import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { SendMessageInput } from '@shared/chat'
import type { Memory } from '@shared/memory'
import { defaultScopeOf, visibleIn } from '@shared/memory'
import * as memory from '../memory/service'
import type { ToolContext } from './context'

/**
 * Brain mode memory tools — thin adapters over the memory service.
 * Chat: memory_save / memory_search / memory_link / memory_open.
 * Code: memory_save (with category and optional doc) / memory_search / memory_open,
 *       isolated per project (projectId derived from the directory — never from the model).
 */

/**
 * Search enrichment, offered to both memory_save (chat and code) and
 * memory_update. All optional: whoever calls the model already has the text, so
 * filling it in costs few tokens and avoids a second LLM pass just to
 * index. What does not come is derived from the text (memory-retrieval.ts).
 */
const ENRICHMENT = z.object({
  title: z.string().optional().describe('Short descriptive title (3-8 words)'),
  summary: z.string().optional().describe('Faithful one-line summary of the fact stored'),
  entities: z
    .array(z.string())
    .optional()
    .describe('People, projects, products, places and identifiers that appear in the text'),
  keywords: z.array(z.string()).optional().describe('Search terms a future question might use (any language)'),
  concepts: z
    .array(z.string())
    .optional()
    .describe('Paraphrases/intentions that should lead here, e.g. "booking a flight" for a seat preference'),
})

function describe(m: Memory): string {
  const kind = m.kind === 'project' ? `project/${m.category}` : m.kind
  // It only appears when it was chosen: the kind's default is already implicit, and
  // printing "scope=chat" on every conversation memory is noise.
  const scope = m.scope && m.scope !== defaultScopeOf(m.kind, m.category) ? ` scope=${m.scope}` : ''
  const area = m.area ? ` area=${m.area}` : ''
  const sub = m.subproject ? ` sub=${m.subproject}` : ''
  const doc = m.hasDoc ? ' (doc attached — use memory_open to read it)' : ''
  const tags = m.tags.length ? ` tags: ${m.tags.join(', ')}` : ''
  // The neighborhood goes into the describe on purpose: it is by reading from here that the agent
  // finds out which node to hang the next memory on, instead of creating a loose one.
  const links = m.relatedIds.length ? ` linked to: ${m.relatedIds.join(', ')}` : ' NO CONNECTIONS'
  // The title is the headline chosen for this memory — five words that
  // say what the text sometimes takes three lines to say.
  const title = m.title ? `${m.title} — ` : ''
  return `#${m.id} [${kind}]${scope}${area}${sub} (weight ${m.weight.toFixed(2)}, hits ${m.hits}) ${title}${m.text}${tags}${doc}${links}`
}

function saveReply(result: { id: string; merged: boolean; text: string }): string {
  return result.merged
    ? `Merged into existing memory #${result.id}: "${result.text}" — no duplicate was created.`
    : `Memory #${result.id} saved.`
}

/** Label of a node in the tree skeleton returned to the agent. */
function treeLine(node: memory.TreeNodeSummary): string {
  const indent = '  '.repeat(Math.min(node.depth, 6))
  const tag = node.area ? `[${node.area}]` : node.category ? `[${node.category}]` : ''
  const sub = node.subproject ? ` (${node.subproject})` : ''
  const text = node.text.length > 70 ? `${node.text.slice(0, 70)}…` : node.text
  return `${indent}#${node.id} ${tag}${sub} ${text}`
}

function treeReply(nodes: memory.TreeNodeSummary[]): string {
  if (nodes.length === 0) return 'This project has no memory tree yet. Run /init or create the root node.'
  return nodes.map(treeLine).join('\n')
}

/**
 * A project memory created without a parent stays orphaned in the canvas and invisible to
 * graph navigation. When the tree already exists, we refuse the save and return
 * the skeleton — the agent picks the parent and repeats the call.
 */
async function requireParent(projectId: string, relatedIds: string[] | undefined): Promise<string | null> {
  if (relatedIds && relatedIds.length > 0) return null
  const skeleton = await memory.tree(projectId)
  if (skeleton.length === 0) return null
  return [
    'Error: a project memory requires relatedIds — without a parent it is orphaned in the tree.',
    'Pick below the node it belongs to (use relatedTypes: { "<id>": "parent" })',
    'or, if a memory on the same subject already exists, edit it with memory_update.',
    '',
    ...skeleton.map(treeLine),
  ].join('\n')
}

function searchReply(results: Memory[]): string {
  if (results.length === 0) return 'No relevant memories found.'
  return results.map(describe).join('\n')
}

/** Age in days, for the maintenance reports. */
function daysAgo(since: number): number {
  return Math.floor((Date.now() - since) / (24 * 60 * 60 * 1000))
}

/**
 * Lists by USE, not by relevance — it is what maintenance needs: lexical
 * search hides exactly the forgotten memories, which match no
 * term. It orders from the least used and oldest to the most alive.
 *
 * In chat mode (no projectId) code knowledge stays out by
 * default, like memory_search: enumerating is not the same as querying, but the
 * conversational agent should not run into project memories without asking.
 * The consolidation routine asks for it — that is what passes includeProjectMemories.
 */
function createListTool(projectIdOf?: () => Promise<string>) {
  return tool({
    description: [
      'Lists memories ordered by DISUSE (fewest hits and oldest first), with hits, age and last use.',
      'Use it for maintenance: memory_search ranks by lexical relevance and therefore hides exactly the',
      'forgotten memories you are looking for. Returns ids, so it pairs with memory_update and memory_delete.',
    ].join(' '),
    inputSchema: z.object({
      kind: z.enum(['core', 'seasonal', 'general', 'project']).optional().describe('Restricts to one type'),
      category: z
        .enum(['preference', 'convention', 'structure', 'decision', 'context', 'database', 'standard', 'learning'])
        .optional(),
      maxHits: z.number().int().min(0).optional().describe('Only memories used at most this many times (0 = never used)'),
      minAgeDays: z.number().int().min(0).optional().describe('Only memories created at least this many days ago'),
      onlyOrphans: z.boolean().optional().describe('Only memories with no connections at all'),
      includeProjectMemories: z
        .boolean()
        .optional()
        .describe(
          'Chat mode only. Default false: project memories and cross-project learnings stay out, ' +
          'as they do in memory_search. Set true ONLY for maintenance work that must span every project.',
        ),
      limit: z.number().int().min(1).max(100).optional().describe('Default: 30'),
    }),
    execute: async ({ kind, category, maxHits, minAgeDays, onlyOrphans, includeProjectMemories, limit }) => {
      const projectId = projectIdOf ? await projectIdOf() : undefined
      const all = await memory.list()
      const now = Date.now()
      const ids = new Set(all.map((m) => m.id))
      const filtered = all
        .filter((m) => {
          if (m.expiresAt != null && m.expiresAt < now) return false
          // A routine proposal is not memory yet: it does not show up to the agent.
          if (m.proposed) return false
          if (kind && m.kind !== kind) return false
          if (category && m.category !== category) return false
          // Project scope when the tool runs in code mode: without
          // this a project's cleanup would reach another one's memories.
          // Code mode: only the current project. Chat mode: no code at all, unless
          // the call explicitly asks for it.
          if (projectId) {
            if (m.kind === 'project' && m.projectId !== projectId) return false
          } else if (!includeProjectMemories && !visibleIn(m, 'chat')) {
            return false
          }
          if (maxHits != null && m.hits > maxHits) return false
          if (minAgeDays != null && daysAgo(m.createdAt) < minAgeDays) return false
          if (onlyOrphans && m.relatedIds.some((r) => ids.has(r))) return false
          return true
        })
        .sort((a, b) => a.hits - b.hits || a.createdAt - b.createdAt)
        .slice(0, limit ?? 30)

      if (filtered.length === 0) return 'No memories match these criteria.'
      return [
        `${filtered.length} memory(ies), least used first:`,
        ...filtered.map((m) => {
          const lastUsed = m.lastHitAt ? `, last used ${daysAgo(m.lastHitAt)}d ago` : ', never used'
          return `${describe(m)} — created ${daysAgo(m.createdAt)}d ago${lastUsed}`
        }),
      ].join('\n')
    },
  })
}

/**
 * Memory deletion. Less serious than deleting a chat (there is no user
 * content here, only what the agent summarized), but still definitive: the
 * attached document and the neighbors' backlinks go along with it.
 */
function createDeleteTool() {
  return tool({
    description: [
      'Permanently deletes memories by id, along with any attached document and the backlinks pointing to them.',
      'Before deleting near-duplicates, prefer memory_update: rewriting the surviving memory to absorb the other',
      'keeps its id, its links and its accumulated hits, which deleting throws away.',
      'Deleting is right for what is obsolete, wrong, or genuinely redundant — not for what is merely unused.',
    ].join(' '),
    inputSchema: z.object({
      ids: z.array(z.string()).min(1).max(50).describe('Memory ids (from memory_list / memory_search)'),
      reason: z
        .string()
        .min(10)
        .describe('Why these specific memories should cease to exist. Written out so the choice is deliberate.'),
    }),
    execute: async ({ ids, reason }) => {
      const lines: string[] = []
      let deleted = 0
      for (const id of ids) {
        const existente = await memory.getFull(id)
        if (!existente) {
          lines.push(`#${id}: not found`)
          continue
        }
        await memory.remove(id)
        deleted++
      }
      return [`${deleted} memory(ies) deleted. Reason: ${reason}`, ...lines].join('\n')
    },
  })
}

function createOpenTool() {
  return tool({
    description:
      'Opens a memory by id and returns the full text, tags, and the attached markdown document when there is one.',
    inputSchema: z.object({
      id: z.string().describe('Memory id (e.g.: mem_abc123)'),
    }),
    execute: async ({ id }) => {
      const full = await memory.open(id)
      if (!full) return `Memory #${id} not found.`
      const parts = [describe(full.memory)]
      if (full.memory.relatedIds.length) parts.push(`Related: ${full.memory.relatedIds.join(', ')}`)
      if (full.document) parts.push(`--- attached document ---\n${full.document}`)
      return parts.join('\n')
    },
  })
}

export function createChatMemoryTools(input: SendMessageInput): ToolSet {
  return {
    memory_save: tool({
      description:
        'Saves a lasting memory about the user. NOT saving is the default — only use for genuinely useful information. kind: "seasonal" (expires; recent activities), "core" (permanent; personal facts), "general" (permanent; a preference or rule with no specific context — not tied to a project). Fill the search fields (title, summary, keywords, concepts) — they are what makes the memory findable later, and they never say anything the text does not.',
      inputSchema: z.object({
        text: z.string().describe('The memory, as a short, self-contained sentence'),
        kind: z.enum(['core', 'seasonal', 'general']).optional().describe('Default: seasonal'),
        scope: z
          .enum(['chat', 'both'])
          .optional()
          .describe(
            'Default "chat": the memory only exists in chat mode. Use "both" when it is about HOW TO WORK ' +
            'and must also guide code sessions (e.g. "offer an artifact before implementing"). ' +
            'Conversational style stays "chat". Only meaningful for kind="general".',
          ),
        category: z
          .enum(['preference', 'convention', 'decision', 'standard'])
          .optional()
          .describe(
            'Only for kind="general": what kind of knowledge it is — preference (how he likes things ' +
            'done), convention (a rule of the house), decision (a choice already made), standard ' +
            '(a checklist to follow).',
          ),
        weight: z.number().min(0).max(1).optional().describe('Importance 0..1'),
        tags: z.array(z.string()).optional().describe('Keywords for future search'),
        relatedIds: z.array(z.string()).optional().describe('Ids of related memories (creates links). Pass ids of existing parents/related memories.'),
        relatedTypes: z.record(z.string(), z.enum(['parent', 'related'])).optional().describe('Relationship type per id. E.g.: { "mem_abc": "parent" }. Default: related'),
        ...ENRICHMENT.shape,
      }),
      execute: async ({ text, kind, scope, category, weight, tags, relatedIds, relatedTypes, title, summary, entities, keywords, concepts }) => {
        const resolvedKind = kind ?? 'seasonal'
        const result = await memory.save({
          text,
          kind: resolvedKind,
          // Only "general" chooses where it applies: core and seasonal are conversation by
          // definition, and the kind's default already ties them to the chat.
          scope: resolvedKind === 'general' ? (scope ?? 'chat') : undefined,
          // And only it carries a category: the other two are not knowledge.
          category: resolvedKind === 'general' ? category : undefined,
          weight,
          tags,
          relatedIds,
          relatedTypes: relatedTypes as Record<string, 'parent' | 'related'> | undefined,
          title,
          summary,
          entities,
          keywords,
          concepts,
          sessionId: input.sessionId,
        })
        return saveReply(result)
      },
    }),
    memory_search: tool({
      description:
        'Searches the user\'s memories (core + seasonal + general). Use when they vaguely reference something past, or when prior context would save repetition.',
      inputSchema: z.object({
        query: z.string().describe('Search terms'),
        kind: z.enum(['core', 'seasonal', 'general']).optional().describe('Restricts to one type'),
        limit: z.number().int().min(1).max(20).optional().describe('Default: 8'),
      }),
      execute: async ({ query, kind, limit }) => {
        const results = await memory.search({
          query,
          kinds: kind ? [kind] : ['core', 'seasonal', 'general'],
          // The chat never sees code knowledge, even when it is
          // stored as kind="general" (that is the case of learnings).
          mode: 'chat',
          limit,
        })
        return searchReply(results)
      },
    }),
    memory_update: tool({
      description:
        'Rewrites an EXISTING memory in place — the alternative to saving a near-duplicate. Use it when ' +
        'something you already stored turns out to be incomplete, outdated or wrong. Preserves the id, ' +
        'the links and the accumulated hits.',
      inputSchema: z.object({
        id: z.string().describe('Id of the memory to rewrite (from memory_search)'),
        text: z.string().optional().describe('New full text, already incorporating the previous content'),
        addTags: z.array(z.string()).optional().describe('Tags to add, keeping the existing ones'),
        tags: z.array(z.string()).optional().describe('Replaces the whole tag list'),
        weight: z.number().min(0).max(1).optional(),
        kind: z.enum(['core', 'seasonal', 'general']).optional().describe('Reclassify (e.g. a seasonal fact that turned out to be permanent)'),
        scope: z
          .enum(['chat', 'both'])
          .optional()
          .describe('Move a general memory to "both" when it turned out to guide code sessions too.'),
        category: z
          .enum(['preference', 'convention', 'decision', 'standard'])
          .optional()
          .describe('Reclassify a general memory (e.g. a preference that is really a decision).'),
      }),
      execute: async ({ id, text, addTags, tags, weight, kind, scope, category }) => {
        try {
          const updated = await memory.revise(id, { text, addTags, tags, weight, kind, scope, category })
          if (!updated) return `Memory #${id} not found.`
          return `Memory #${id} updated: ${describe(updated)}`
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`
        }
      },
    }),
    memory_link: tool({
      description:
        'Connects two existing memories (bidirectional backlink). Use when one memory expands, corrects, or relates to another. For a parent-child (hierarchy) relationship, use type="parent".',
      inputSchema: z.object({
        sourceId: z.string(),
        targetId: z.string(),
        type: z.enum(['parent', 'related']).optional().describe('Relationship type. "parent" = hierarchy (source is parent of target). Default: related'),
      }),
      execute: async ({ sourceId, targetId, type }) => {
        const ok = await memory.link(sourceId, targetId, type)
        return ok ? 'Memories connected.' : 'Could not connect: one of the memories does not exist.'
      },
    }),
    memory_list: createListTool(),
    memory_delete: createDeleteTool(),
    memory_open: createOpenTool(),
  }
}

/**
 * Memory scope of the session's folder, resolved once per tool set.
 * It is the parent folder's project when it already has a tree — see
 * resolveProjectScope — and not the projectIdOf of the raw folder.
 */
function scopeResolver(ctx: ToolContext): () => Promise<memory.ProjectScope> {
  let pending: Promise<memory.ProjectScope> | undefined
  return () => (pending ??= memory.resolveProjectScope(ctx.directory))
}

export function createGraphTool(_input: SendMessageInput, ctx: ToolContext) {
  const scope = scopeResolver(ctx)
  return tool({
    description:
      'Searches the current project\'s memory graph. Returns nodes whose text or tags match the query, with their connections (relatedIds). Use when you need architectural context, decisions, or specific conventions — replaces re-analyzing the code.',
    inputSchema: z.object({
      query: z.string().describe('Search terms — keywords for what you need to find'),
      limit: z.number().int().min(1).max(30).optional().describe('Max nodes (default: 10)'),
    }),
    execute: async ({ query, limit }) => {
      const results = await memory.search({
        query,
        kinds: ['project'],
        projectId: (await scope()).projectId,
        limit,
      })
      if (results.length === 0) return 'No memories found for this query.'
      const lines: string[] = []
      for (const m of results) {
        const area = m.area ? ` [${m.area}]` : ''
        const category = m.category ? `[${m.category}]` : ''
        const doc = m.hasDoc ? ' (doc — use memory_open)' : ''
        const tags = m.tags.length ? ` tags: ${m.tags.join(', ')}` : ''
        lines.push(`#${m.id}${area} ${category} ${m.text}${doc}${tags}`)
        if (m.relatedIds.length) {
          const related = (await Promise.all(
            m.relatedIds.map((id) => memory.getFull(id)),
          )).filter(Boolean)
          for (const r of related) {
            lines.push(`  ↳ #${r!.memory.id} [${r!.memory.area ?? r!.memory.category ?? ''}] ${r!.memory.text}`)
          }
        }
      }
      return lines.join('\n')
    },
  })
}

export function createCodeMemoryTools(input: SendMessageInput, ctx: ToolContext): ToolSet {
  const scope = scopeResolver(ctx)
  const projectId = async () => (await scope()).projectId

  return {
    memory_save: tool({
      description:
        'Saves a working memory as a NODE IN THE PROJECT TREE. Before calling, run memory_search: ' +
        'if a memory on the same subject already exists, use memory_update to refine it instead of ' +
        'creating a near-duplicate. relatedIds is REQUIRED once the project has a tree — a node with ' +
        'no parent is invisible to graph navigation. Default kind is "project"; "general" is only for ' +
        'knowledge that is true in OTHER projects too.',
      inputSchema: z.object({
        text: z.string().describe('Short, self-contained summary (goes into the prompt and search)'),
        kind: z
          .enum(['project', 'general'])
          .optional()
          .describe(
            'Default: project. Use "general" ONLY if the fact stays true in a project that shares ' +
            'nothing with this codebase. Anything naming this project entities, schema, routes, ' +
            'business rules or infrastructure is kind="project", never general.',
          ),
        scope: z
          .enum(['code', 'both'])
          .optional()
          .describe(
            'Default "code": the fact only exists inside code sessions. Use "both" when it is a work ' +
            'preference that must also shape chat conversations (e.g. "offer an artifact before ' +
            'implementing"). Only meaningful for kind="general".',
          ),
        category: z
          .enum(['preference', 'convention', 'structure', 'decision', 'context', 'database', 'standard', 'learning'])
          .optional()
          .describe(
            'Required when kind=project (preference | convention | structure | decision | context | database | standard). ' +
            '"context" expires (weight <= 0.3). For kind=general: "learning" for a technology-level lesson ' +
            '(framework gotcha, library workaround) with no reference to this project domain; preference, ' +
            'convention, decision or standard for how the user works.',
          ),
        area: z
          .enum([
            'overview', 'business', 'design', 'architecture', 'preferences', 'infrastructure',
            'security', 'development', 'database', 'testing', 'performance', 'dependencies', 'standards',
          ])
          .optional()
          .describe('Knowledge area this memory belongs to. Match the parent area node you link to.'),
        subproject: z
          .string()
          .optional()
          .describe('Subproject inside the repo (e.g. "front", "back", "api") when the fact only applies there.'),
        weight: z.number().min(0).max(1).optional().describe('Importance 0..1'),
        tags: z.array(z.string()).optional().describe('Keywords for future search — for category=learning, include the technology/framework name'),
        document: z.string().optional().describe('Attached markdown for extensive context'),
        relatedIds: z
          .array(z.string())
          .optional()
          .describe(
            'REQUIRED for kind=project once a tree exists. Ids of the parent area node plus any related ' +
            'memories. Get them from memory_tree or memory_search. A memory may have several parents.',
          ),
        relatedTypes: z
          .record(z.string(), z.enum(['parent', 'related']))
          .optional()
          .describe('Relationship per id. Mark the owning area as "parent": { "mem_abc": "parent" }'),
        ...ENRICHMENT.shape,
      }),
      execute: async ({ text, kind, scope: savedScope, category, area, subproject, weight, tags, document, relatedIds, relatedTypes, title, summary, entities, keywords, concepts }) => {
        const resolvedKind = kind ?? 'project'
        if (resolvedKind === 'project' && !category) {
          return 'Error: project memories require the category field (preference | convention | structure | decision | context | database | standard).'
        }
        if (resolvedKind === 'project') {
          const missingParent = await requireParent(await projectId(), relatedIds)
          if (missingParent) return missingParent
        }
        const result = await memory.save({
          text,
          kind: resolvedKind,
          // Only "general" chooses where it applies; "project" is already code by nature.
          scope: resolvedKind === 'general' ? (savedScope ?? 'code') : undefined,
          category,
          area: resolvedKind === 'project' ? area : undefined,
          subproject: resolvedKind === 'project' ? subproject : undefined,
          weight,
          tags,
          document,
          relatedIds,
          relatedTypes: relatedTypes as Record<string, 'parent' | 'related'> | undefined,
          title,
          summary,
          entities,
          keywords,
          concepts,
          // Always sent: it defines the project in "project" memories and records the
          // origin in the "general" ones, so the canvas anchors them in the right tree. It is
          // the scope root: in a subfolder, the memory enters the parent's tree.
          directory: (await scope()).directory,
          sessionId: input.sessionId,
        })
        return saveReply(result)
      },
    }),

    memory_update: tool({
      description:
        'Rewrites an EXISTING memory in place — the alternative to saving a near-duplicate. Use it when ' +
        'a new finding refines, corrects or extends something already stored, or to fix a wrong ' +
        'classification (e.g. a project fact that was saved as kind="general"). Preserves the id, the ' +
        'links and the accumulated hits.',
      inputSchema: z.object({
        id: z.string().describe('Id of the memory to rewrite (from memory_search / memory_tree)'),
        text: z.string().optional().describe('New full text, already incorporating the previous content'),
        addTags: z.array(z.string()).optional().describe('Tags to add, keeping the existing ones'),
        tags: z.array(z.string()).optional().describe('Replaces the whole tag list'),
        weight: z.number().min(0).max(1).optional(),
        kind: z.enum(['project', 'general']).optional().describe('Reclassify. Moving to "project" attaches it to the current folder.'),
        scope: z
          .enum(['code', 'both'])
          .optional()
          .describe('Move a general memory to "both" when it turned out to guide chat conversations too.'),
        category: z
          .enum(['preference', 'convention', 'structure', 'decision', 'context', 'database', 'standard', 'learning'])
          .optional(),
        area: z
          .enum([
            'overview', 'business', 'design', 'architecture', 'preferences', 'infrastructure',
            'security', 'development', 'database', 'testing', 'performance', 'dependencies', 'standards',
          ])
          .optional(),
        document: z.string().optional().describe('Replaces the attached markdown'),
        ...ENRICHMENT.shape,
      }),
      execute: async ({ id, text, addTags, tags, weight, kind, scope: savedScope, category, area, document, title, summary, entities, keywords, concepts }) => {
        try {
          const updated = await memory.revise(id, {
            text, addTags, tags, weight, kind, scope: savedScope, category, area, document,
            title, summary, entities, keywords, concepts,
            directory: (await scope()).directory,
          })
          if (!updated) return `Memory #${id} not found.`
          return `Memory #${id} updated: ${describe(updated)}`
        } catch (err) {
          // An invalid reclassification comes back as text so the agent can correct the
          // call, instead of bringing the turn down with an exception.
          return `Error: ${err instanceof Error ? err.message : String(err)}`
        }
      },
    }),

    memory_tree: tool({
      description:
        'Returns the memory tree skeleton of this project (id, area and text of every node, indented by ' +
        'depth). Call it BEFORE saving to decide which node the new memory hangs from, and to spot a ' +
        'node that should be updated rather than duplicated.',
      inputSchema: z.object({}),
      execute: async () => treeReply(await memory.tree(await projectId())),
    }),

    memory_search: tool({
      description:
        'Searches this project memories + general work preferences + lessons from other projects. Run it ' +
        'at the start of a non-trivial task, and ALWAYS before memory_save — the result tells you whether ' +
        'to create a new node or update an existing one, and gives the ids to link against.',
      inputSchema: z.object({
        query: z.string().describe('Search terms'),
        kind: z.enum(['project', 'general']).optional().describe('Restricts to one type'),
        category: z
          .enum(['preference', 'convention', 'structure', 'decision', 'context', 'database', 'standard', 'learning'])
          .optional()
          .describe('Filters by category'),
        limit: z.number().int().min(1).max(20).optional().describe('Default: 8'),
      }),
      execute: async ({ query, kind, category, limit }) => {
        const results = await memory.search({
          query,
          kinds: kind ? [kind] : ['project', 'general'],
          projectId: await projectId(),
          mode: 'code',
          category,
          limit,
        })
        return searchReply(results)
      },
    }),

    memory_link: tool({
      description:
        'Connects two existing memories. Use it to attach an orphan node to its area, or to record that ' +
        'two memories relate. type="parent" means sourceId is the PARENT of targetId.',
      inputSchema: z.object({
        sourceId: z.string(),
        targetId: z.string(),
        type: z.enum(['parent', 'related']).optional().describe('Default: related'),
      }),
      execute: async ({ sourceId, targetId, type }) => {
        const ok = await memory.link(sourceId, targetId, type)
        return ok ? 'Memories connected.' : 'Could not connect: one of the memories does not exist.'
      },
    }),

    memory_list: createListTool(projectId),
    memory_delete: createDeleteTool(),
    memory_open: createOpenTool(),
  }
}
