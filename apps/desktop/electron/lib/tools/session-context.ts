import { tool } from 'ai'
import { z } from 'zod'
import { StorageKeys, type ChatMessage } from '@shared/chat'
import { readJson } from '../storage'
import type { ToolContext } from './context'

/**
 * Tool session_context: metadados dos últimos N turnos da sessão — modo
 * ativo, permissionMode, timestamps, arquivos alterados (snapshot) e tool
 * parts com erro. É puramente leitura: lê o histórico persistido via
 * sessionId (mesmo storage do chat-engine) e não injeta nada no contexto —
 * o modelo decide quando chamar.
 *
 * Turno = uma mensagem de usuário + a resposta do assistente seguinte.
 * Mensagens sintéticas de compactação (summary) são ignoradas.
 */

const MAX_TEXT_SNIPPET = 200

interface TurnRecord {
  role: 'user'
  /** Primeiro texto da mensagem do usuário, truncado para contexto */
  text: string
  createdAt: number
  completedAt?: number
  mode?: string
  permissionMode?: string
  /** Arquivos alterados no turno (snapshot do assistente) */
  files: string[]
  /** Tool parts que terminaram em erro */
  errors: { tool: string; error: string }[]
  truncated?: boolean
}

export function createSessionContextTool(ctx: ToolContext) {
  return tool({
    description:
      "Returns metadata about recent turns in this session (newest first): active mode, permission mode, timestamps, files changed, and tool calls that errored. Read-only, cheap — useful to answer 'what was changed in the previous turn?'.",
    inputSchema: z.object({
      turns: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe('Number of most recent turns to inspect (default 5)'),
    }),
    execute: async ({ turns = 5 }) => {
      let messages: ChatMessage[]
      try {
        messages = (await readJson<ChatMessage[]>(StorageKeys.messages(ctx.sessionId))) ?? []
      } catch (err) {
        return { turns: [], note: `histórico indisponível: ${err instanceof Error ? err.message : String(err)}` }
      }
      if (messages.length === 0) return { turns: [], note: 'nenhum histórico nesta sessão' }

      const records: TurnRecord[] = []
      let current: TurnRecord | null = null
      for (const message of messages) {
        if (message.role === 'user') {
          // Mensagens de compactação são artefato interno, não turnos do usuário
          if (message.summary) continue
          const textPart = message.parts.find(
            (p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text',
          )
          const text = (textPart?.text ?? '').trim().replace(/\s+/g, ' ')
          current = {
            role: 'user',
            text: text.length > MAX_TEXT_SNIPPET ? text.slice(0, MAX_TEXT_SNIPPET) + '…' : text,
            createdAt: message.createdAt,
            mode: message.mode,
            permissionMode: message.permissionMode,
            files: [],
            errors: [],
          }
          records.push(current)
        } else if (message.role === 'assistant' && current) {
          current.completedAt ??= message.completedAt
          if (message.truncated) current.truncated = true
          if (message.snapshot?.files?.length) {
            current.files = message.snapshot.files
          }
          for (const part of message.parts) {
            if (part.type === 'tool' && part.state === 'error') {
              current.errors.push({ tool: part.tool, error: part.error ?? 'erro desconhecido' })
            }
          }
        }
      }

      return { turns: records.slice(-turns).reverse() }
    },
  })
}
