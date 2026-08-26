import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { SendMessageInput } from '@shared/chat'
import type { Memory } from '@shared/memory'
import { isCodeContext } from '@shared/memory'
import { projectIdOf } from '../memory/domain'
import * as memory from '../memory/service'
import type { ToolContext } from './context'

/**
 * Ferramentas de memória do modo Brain — adapters finos sobre o memory service.
 * Chat: memory_save / memory_search / memory_link / memory_open.
 * Code: memory_save (com category e doc opcional) / memory_search / memory_open,
 *       isoladas por projeto (projectId derivado do directory — nunca do modelo).
 */

function describe(m: Memory): string {
  const kind = m.kind === 'project' ? `project/${m.category}` : m.kind
  const area = m.area ? ` area=${m.area}` : ''
  const sub = m.subproject ? ` sub=${m.subproject}` : ''
  const doc = m.hasDoc ? ' (doc anexado — use memory_open para ler)' : ''
  const tags = m.tags.length ? ` tags: ${m.tags.join(', ')}` : ''
  // A vizinhança entra no describe de propósito: é lendo daqui que o agente
  // descobre a que nó pendurar a próxima memória, em vez de criar uma solta.
  const links = m.relatedIds.length ? ` ligada a: ${m.relatedIds.join(', ')}` : ' SEM CONEXÕES'
  return `#${m.id} [${kind}]${area}${sub} (peso ${m.weight.toFixed(2)}, hits ${m.hits}) ${m.text}${tags}${doc}${links}`
}

function saveReply(result: { id: string; merged: boolean; text: string }): string {
  return result.merged
    ? `Fundido com memória já existente #${result.id}: "${result.text}" — não foi criada duplicata.`
    : `Memória #${result.id} salva.`
}

/** Rótulo de um nó no esqueleto da árvore devolvido ao agente. */
function treeLine(node: memory.TreeNodeSummary): string {
  const indent = '  '.repeat(Math.min(node.depth, 6))
  const tag = node.area ? `[${node.area}]` : node.category ? `[${node.category}]` : ''
  const sub = node.subproject ? ` (${node.subproject})` : ''
  const text = node.text.length > 70 ? `${node.text.slice(0, 70)}…` : node.text
  return `${indent}#${node.id} ${tag}${sub} ${text}`
}

function treeReply(nodes: memory.TreeNodeSummary[]): string {
  if (nodes.length === 0) return 'Este projeto ainda não tem árvore de memórias. Rode /init ou crie o nó raiz.'
  return nodes.map(treeLine).join('\n')
}

/**
 * Uma memória de projeto criada sem pai fica órfã no canvas e invisível para a
 * navegação do grafo. Quando a árvore já existe, recusamos o save e devolvemos
 * o esqueleto — o agente escolhe o pai e repete a chamada.
 */
async function requireParent(projectId: string, relatedIds: string[] | undefined): Promise<string | null> {
  if (relatedIds && relatedIds.length > 0) return null
  const skeleton = await memory.tree(projectId)
  if (skeleton.length === 0) return null
  return [
    'Erro: memória de projeto exige relatedIds — sem pai ela fica órfã na árvore.',
    'Escolha abaixo o nó ao qual ela pertence (use relatedTypes: { "<id>": "parent" })',
    'ou, se já existir uma memória sobre o mesmo assunto, edite-a com memory_update.',
    '',
    ...skeleton.map(treeLine),
  ].join('\n')
}

function searchReply(results: Memory[]): string {
  if (results.length === 0) return 'Nenhuma memória relevante encontrada.'
  return results.map(describe).join('\n')
}

/** Idade em dias, para os relatórios de manutenção. */
function dias(desde: number): number {
  return Math.floor((Date.now() - desde) / (24 * 60 * 60 * 1000))
}

/**
 * Lista por USO, não por relevância — é o que a manutenção precisa: a busca
 * léxica esconde justamente as memórias esquecidas, que não casam com nenhum
 * termo. Ordena da menos usada e mais antiga para a mais viva.
 *
 * No modo chat (sem projectId) o conhecimento de código fica de fora por
 * padrão, igual ao memory_search: enumerar não é o mesmo que consultar, mas o
 * agente conversacional não deveria topar com memórias de projeto sem pedir.
 * A rotina de consolidação pede — é ela que passa includeProjectMemories.
 */
function createListTool(projectId?: string) {
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
      const todas = await memory.list()
      const agora = Date.now()
      const ids = new Set(todas.map((m) => m.id))
      const filtradas = todas
        .filter((m) => {
          if (m.expiresAt != null && m.expiresAt < agora) return false
          if (kind && m.kind !== kind) return false
          if (category && m.category !== category) return false
          // Escopo do projeto quando a ferramenta roda no modo código: sem
          // isto a limpeza de um projeto alcançaria memórias de outro.
          // Modo código: só o projeto atual. Modo chat: nada de código, a menos
          // que a chamada peça explicitamente.
          if (projectId) {
            if (m.kind === 'project' && m.projectId !== projectId) return false
          } else if (!includeProjectMemories && isCodeContext(m)) {
            return false
          }
          if (maxHits != null && m.hits > maxHits) return false
          if (minAgeDays != null && dias(m.createdAt) < minAgeDays) return false
          if (onlyOrphans && m.relatedIds.some((r) => ids.has(r))) return false
          return true
        })
        .sort((a, b) => a.hits - b.hits || a.createdAt - b.createdAt)
        .slice(0, limit ?? 30)

      if (filtradas.length === 0) return 'Nenhuma memória corresponde a esses critérios.'
      return [
        `${filtradas.length} memória(s), da menos usada para a mais usada:`,
        ...filtradas.map((m) => {
          const usoRecente = m.lastHitAt ? `, último uso há ${dias(m.lastHitAt)}d` : ', nunca usada'
          return `${describe(m)} — criada há ${dias(m.createdAt)}d${usoRecente}`
        }),
      ].join('\n')
    },
  })
}

/**
 * Exclusão de memória. Menos grave que apagar um chat (não há conteúdo do
 * usuário aqui, só o que o agente resumiu), mas ainda é definitivo: o
 * documento anexado e os backlinks das vizinhas vão junto.
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
      motivo: z
        .string()
        .min(10)
        .describe('Why these specific memories should cease to exist. Written out so the choice is deliberate.'),
    }),
    execute: async ({ ids, motivo }) => {
      const linhas: string[] = []
      let apagadas = 0
      for (const id of ids) {
        const existente = await memory.getFull(id)
        if (!existente) {
          linhas.push(`#${id}: não encontrada`)
          continue
        }
        await memory.remove(id)
        apagadas++
      }
      return [`${apagadas} memória(s) excluída(s). Motivo: ${motivo}`, ...linhas].join('\n')
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
      const full = await memory.getFull(id)
      if (!full) return `Memória #${id} não encontrada.`
      const parts = [describe(full.memory)]
      if (full.memory.relatedIds.length) parts.push(`Relacionadas: ${full.memory.relatedIds.join(', ')}`)
      if (full.document) parts.push(`--- documento anexado ---\n${full.document}`)
      return parts.join('\n')
    },
  })
}

export function createChatMemoryTools(input: SendMessageInput): ToolSet {
  return {
    memory_save: tool({
      description:
        'Saves a lasting memory about the user. NOT saving is the default — only use for genuinely useful information. kind: "seasonal" (expires; recent activities), "core" (permanent; personal facts), "general" (permanent; preferences that apply in all modes).',
      inputSchema: z.object({
        text: z.string().describe('The memory, as a short, self-contained sentence'),
        kind: z.enum(['core', 'seasonal', 'general']).optional().describe('Default: seasonal'),
        weight: z.number().min(0).max(1).optional().describe('Importance 0..1'),
        tags: z.array(z.string()).optional().describe('Keywords for future search'),
        relatedIds: z.array(z.string()).optional().describe('Ids of related memories (creates links). Pass ids of existing parents/related memories.'),
        relatedTypes: z.record(z.string(), z.enum(['parent', 'related'])).optional().describe('Relationship type per id. E.g.: { "mem_abc": "parent" }. Default: related'),
      }),
      execute: async ({ text, kind, weight, tags, relatedIds, relatedTypes }) => {
        const result = await memory.save({
          text,
          kind: kind ?? 'seasonal',
          weight,
          tags,
          relatedIds,
          relatedTypes: relatedTypes as Record<string, 'parent' | 'related'> | undefined,
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
          // O chat nunca vê conhecimento de código, mesmo quando ele está
          // gravado como kind="general" (é o caso dos aprendizados).
          excludeCodeContext: true,
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
      }),
      execute: async ({ id, text, addTags, tags, weight, kind }) => {
        try {
          const updated = await memory.revise(id, { text, addTags, tags, weight, kind })
          if (!updated) return `Memória #${id} não encontrada.`
          return `Memória #${id} atualizada: ${describe(updated)}`
        } catch (err) {
          return `Erro: ${err instanceof Error ? err.message : String(err)}`
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
        return ok ? 'Memórias conectadas.' : 'Não foi possível conectar: alguma das memórias não existe.'
      },
    }),
    memory_list: createListTool(),
    memory_delete: createDeleteTool(),
    memory_open: createOpenTool(),
  }
}

export function createGraphTool(_input: SendMessageInput, ctx: ToolContext) {
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
        projectId: projectIdOf(ctx.directory),
        limit,
      })
      if (results.length === 0) return 'Nenhuma memória encontrada para esta consulta.'
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
  const projectId = projectIdOf(ctx.directory)

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
        category: z
          .enum(['preference', 'convention', 'structure', 'decision', 'context', 'database', 'standard', 'learning'])
          .optional()
          .describe(
            'Required when kind=project (preference | convention | structure | decision | context | database | standard). ' +
            '"context" expires (weight <= 0.3). When kind=general, only "learning" is accepted: a technology-level ' +
            'lesson (framework gotcha, library workaround) with NO reference to this project domain.',
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
      }),
      execute: async ({ text, kind, category, area, subproject, weight, tags, document, relatedIds, relatedTypes }) => {
        const resolvedKind = kind ?? 'project'
        if (resolvedKind === 'project' && !category) {
          return 'Erro: memórias de projeto exigem o campo category (preference | convention | structure | decision | context | database | standard).'
        }
        if (resolvedKind === 'general' && category && category !== 'learning') {
          return 'Erro: kind=general só aceita category="learning" (ou nenhuma category).'
        }
        if (resolvedKind === 'project') {
          const missingParent = await requireParent(projectId, relatedIds)
          if (missingParent) return missingParent
        }
        const result = await memory.save({
          text,
          kind: resolvedKind,
          category,
          area: resolvedKind === 'project' ? area : undefined,
          subproject: resolvedKind === 'project' ? subproject : undefined,
          weight,
          tags,
          document,
          relatedIds,
          relatedTypes: relatedTypes as Record<string, 'parent' | 'related'> | undefined,
          // Sempre enviado: define o projeto em memórias "project" e registra a
          // origem nas "general", para o canvas ancorá-las na árvore certa.
          directory: ctx.directory,
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
      }),
      execute: async ({ id, text, addTags, tags, weight, kind, category, area, document }) => {
        try {
          const updated = await memory.revise(id, {
            text, addTags, tags, weight, kind, category, area, document,
            directory: ctx.directory,
          })
          if (!updated) return `Memória #${id} não encontrada.`
          return `Memória #${id} atualizada: ${describe(updated)}`
        } catch (err) {
          // Reclassificação inválida volta como texto para o agente corrigir a
          // chamada, em vez de derrubar o turno com uma exceção.
          return `Erro: ${err instanceof Error ? err.message : String(err)}`
        }
      },
    }),

    memory_tree: tool({
      description:
        'Returns the memory tree skeleton of this project (id, area and text of every node, indented by ' +
        'depth). Call it BEFORE saving to decide which node the new memory hangs from, and to spot a ' +
        'node that should be updated rather than duplicated.',
      inputSchema: z.object({}),
      execute: async () => treeReply(await memory.tree(projectId)),
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
          projectId,
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
        return ok ? 'Memórias conectadas.' : 'Não foi possível conectar: alguma das memórias não existe.'
      },
    }),

    memory_list: createListTool(projectId),
    memory_delete: createDeleteTool(),
    memory_open: createOpenTool(),
  }
}
