import { tool } from 'ai'
import { z } from 'zod'
import { StorageKeys, type ChatMessage } from '@shared/chat'
import { readJson } from '../storage'
import type { ToolContext } from './context'

/**
 * Tool session_context: metadata of the session's last N turns — active
 * mode, permissionMode, timestamps, changed files (snapshot) and tool
 * parts with an error. It is purely read: it reads the persisted history via
 * sessionId (the same storage as chat-engine) and injects nothing into the context —
 * the model decides when to call it.
 *
 * Turn = one user message + the following assistant response.
 * Synthetic compaction messages (summary) are ignored.
 */

const MAX_TEXT_SNIPPET = 200

interface TurnRecord {
  role: 'user'
  /** First text of the user message, truncated for context */
  text: string
  createdAt: number
  completedAt?: number
  mode?: string
  permissionMode?: string
  /** Files changed in the turn (assistant snapshot) */
  files: string[]
  /** Tool parts that ended in an error */
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
        return { turns: [], note: `history unavailable: ${err instanceof Error ? err.message : String(err)}` }
      }
      if (messages.length === 0) return { turns: [], note: 'no history in this session' }

      const records: TurnRecord[] = []
      let current: TurnRecord | null = null
      for (const message of messages) {
        if (message.role === 'user') {
          // Compaction messages are an internal artifact, not user turns
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
              current.errors.push({ tool: part.tool, error: part.error ?? 'unknown error' })
            }
          }
        }
      }

      return { turns: records.slice(-turns).reverse() }
    },
  })
}
