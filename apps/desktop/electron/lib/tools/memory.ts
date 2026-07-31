import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { SendMessageInput } from '@shared/chat'
import type { Memory } from '@shared/memory'
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
  const doc = m.hasDoc ? ' (doc anexado — use memory_open para ler)' : ''
  const tags = m.tags.length ? ` tags: ${m.tags.join(', ')}` : ''
  return `#${m.id} [${kind}] (peso ${m.weight.toFixed(2)}, hits ${m.hits}) ${m.text}${tags}${doc}`
}

function saveReply(result: { id: string; merged: boolean; text: string }): string {
  return result.merged
    ? `Fundido com memória já existente #${result.id}: "${result.text}" — não foi criada duplicata.`
    : `Memória #${result.id} salva.`
}

function searchReply(results: Memory[]): string {
  if (results.length === 0) return 'Nenhuma memória relevante encontrada.'
  return results.map(describe).join('\n')
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
          limit,
        })
        return searchReply(results)
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
  return {
    memory_save: tool({
      description:
        'Saves a working memory. kind "project" (default): about THIS project, category required. kind "general": global work style, or (with category="learning") a lesson reusable in OTHER projects with the same stack. For extensive context, pass markdown in `document`.',
      inputSchema: z.object({
        text: z.string().describe('Short, self-contained summary (goes into the prompt and search)'),
        kind: z.enum(['project', 'general']).optional().describe('Default: project'),
        category: z
          .enum(['preference', 'convention', 'structure', 'decision', 'context', 'database', 'standard', 'learning'])
          .optional()
          .describe(
            'Required when kind=project (preference | convention | structure | decision | context | database | standard). "context" expires (weight <= 0.3). When kind=general, only "learning" is accepted — marks the memory as a lesson reusable in other projects; tag it with the technology.',
          ),
        weight: z.number().min(0).max(1).optional().describe('Importance 0..1'),
        tags: z.array(z.string()).optional().describe('Keywords for future search — for category=learning, include the technology/framework name'),
        document: z
          .string()
          .optional()
          .describe('Attached markdown for extensive context'),
        relatedIds: z.array(z.string()).optional().describe('Ids of related memories (creates links). Connect to the parent area, related decisions, etc.'),
        relatedTypes: z.record(z.string(), z.enum(['parent', 'related'])).optional().describe('Relationship type per id. E.g.: { "mem_abc": "parent" }'),
      }),
      execute: async ({ text, kind, category, weight, tags, document, relatedIds, relatedTypes }) => {
        const resolvedKind = kind ?? 'project'
        if (resolvedKind === 'project' && !category) {
          return 'Erro: memórias de projeto exigem o campo category (preference | convention | structure | decision | context | database | standard).'
        }
        if (resolvedKind === 'general' && category && category !== 'learning') {
          return 'Erro: kind=general só aceita category="learning" (ou nenhuma category).'
        }
        const result = await memory.save({
          text,
          kind: resolvedKind,
          category,
          weight,
          tags,
          document,
          relatedIds,
          relatedTypes: relatedTypes as Record<string, 'parent' | 'related'> | undefined,
          directory: ctx.directory,
          sessionId: input.sessionId,
        })
        return saveReply(result)
      },
    }),
    memory_search: tool({
      description:
        'Searches this project\'s memories + general work preferences + lessons from other projects. Use when starting a non-trivial task to load decisions/conventions without re-analyzing the code.',
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
          projectId: projectIdOf(ctx.directory),
          category,
          limit,
        })
        return searchReply(results)
      },
    }),
    memory_open: createOpenTool(),
  }
}
