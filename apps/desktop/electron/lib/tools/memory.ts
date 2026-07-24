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
      'Abre uma memória pelo id e retorna o texto completo, tags e o documento markdown anexado quando existir.',
    inputSchema: z.object({
      id: z.string().describe('Id da memória (ex: mem_abc123)'),
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
        'Salva uma memória duradoura sobre o usuário. NÃO salvar é o default — use apenas para informação genuinamente útil. kind: "seasonal" (expira; atividades recentes), "core" (permanente; fatos pessoais), "general" (permanente; preferências que valem em todos os modos).',
      inputSchema: z.object({
        text: z.string().describe('A memória, em uma frase curta e autocontida'),
        kind: z.enum(['core', 'seasonal', 'general']).optional().describe('Padrão: seasonal'),
        weight: z.number().min(0).max(1).optional().describe('Importância 0..1'),
        tags: z.array(z.string()).optional().describe('Palavras-chave para busca futura'),
        relatedIds: z.array(z.string()).optional().describe('Ids de memórias relacionadas (cria links). Passe ids de pais/relacionados existentes.'),
        relatedTypes: z.record(z.string(), z.enum(['parent', 'related'])).optional().describe('Tipo da relação por id. Ex: { "mem_abc": "parent" }. Padrão: related'),
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
        'Busca nas memórias do usuário (core + seasonal + general). Use quando ele referenciar algo passado de forma vaga ou quando o contexto anterior economizaria repetição.',
      inputSchema: z.object({
        query: z.string().describe('Termos da busca'),
        kind: z.enum(['core', 'seasonal', 'general']).optional().describe('Restringe a um tipo'),
        limit: z.number().int().min(1).max(20).optional().describe('Padrão: 8'),
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
        'Conecta duas memórias existentes (backlink bidirecional). Use quando uma memória expande, corrige ou se relaciona a outra. Se for relação pai-filho (hierarquia), use type="parent".',
      inputSchema: z.object({
        sourceId: z.string(),
        targetId: z.string(),
        type: z.enum(['parent', 'related']).optional().describe('Tipo da relação. "parent" = hierarquia (source é pai de target). Padrão: related'),
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
      'Busca no grafo de memórias do projeto atual. Retorna nós cujo texto ou tags correspondem à consulta, com suas conexões (relatedIds). Use quando precisar de contexto arquitetural, decisões ou convenções específicas — substitui reanalisar o código.',
    inputSchema: z.object({
      query: z.string().describe('Termos da busca — palavras-chave do que precisa encontrar'),
      limit: z.number().int().min(1).max(30).optional().describe('Máximo de nós (padrão: 10)'),
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
        'Salva uma memória de trabalho. kind "project" (padrão): sobre ESTE projeto, category obrigatória. kind "general": estilo global de trabalho, ou (com category="learning") uma lição reutilizável em OUTROS projetos com a mesma stack. Para contexto extenso, passe markdown em `document`.',
      inputSchema: z.object({
        text: z.string().describe('Resumo curto e autocontido (vai ao prompt e à busca)'),
        kind: z.enum(['project', 'general']).optional().describe('Padrão: project'),
        category: z
          .enum(['preference', 'convention', 'structure', 'decision', 'context', 'database', 'standard', 'learning'])
          .optional()
          .describe(
            'Obrigatória quando kind=project (preference | convention | structure | decision | context | database | standard). "context" expira (weight <= 0.3). Quando kind=general, só "learning" é aceita — marca a memória como lição reutilizável em outros projetos; tagueie com a tecnologia.',
          ),
        weight: z.number().min(0).max(1).optional().describe('Importância 0..1'),
        tags: z.array(z.string()).optional().describe('Palavras-chave para busca futura — para category=learning, inclua o nome da tecnologia/framework'),
        document: z
          .string()
          .optional()
          .describe('Markdown anexado para contexto extenso'),
        relatedIds: z.array(z.string()).optional().describe('Ids de memórias relacionadas (cria links). Conecte a área-pai, decisões relacionadas etc.'),
        relatedTypes: z.record(z.string(), z.enum(['parent', 'related'])).optional().describe('Tipo da relação por id. Ex: { "mem_abc": "parent" }'),
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
        'Busca nas memórias deste projeto + preferências gerais de trabalho + aprendizados de outros projetos. Use ao iniciar tarefa não-trivial para carregar decisões/convenções sem reanalisar o código.',
      inputSchema: z.object({
        query: z.string().describe('Termos da busca'),
        kind: z.enum(['project', 'general']).optional().describe('Restringe a um tipo'),
        category: z
          .enum(['preference', 'convention', 'structure', 'decision', 'context', 'database', 'standard', 'learning'])
          .optional()
          .describe('Filtra por categoria'),
        limit: z.number().int().min(1).max(20).optional().describe('Padrão: 8'),
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
