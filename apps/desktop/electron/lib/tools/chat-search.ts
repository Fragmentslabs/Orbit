import path from 'node:path'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { StorageKeys, type ChatMessage, type SendMessageInput, type SessionInfo } from '@shared/chat'
import { readJson } from '../storage'
import { excerpt, isUserChat, sessionIndex, type IndexedChat } from '../session-index'

/**
 * Past conversations for the agent: search finds passages, read opens the surroundings.
 *
 * They are two tools because they are two gestures — and chat_read has no way to get an id
 * without chat_search. Both read only what was SAID (user/assistant text); tool output and
 * reasoning are not in the index and are never returned. Neither ever answers with the
 * conversation that is calling (the model already has it) or with orchestration workers and
 * routine runs, which belong to someone else.
 *
 * Scope is the privacy line. In chat the default is the user's chats; in code mode it is the
 * chats of the SAME project. Widening to every chat is a permission request in code mode
 * (see assess() in permission/rules.ts), because a project session should not read the
 * user's other projects without being told it may.
 */

const SNIPPET_CHARS = 400
const DEFAULT_LIMIT = 5
const DEFAULT_WINDOW = 2
const MAX_WINDOW = 20
const DEFAULT_MAX_CHARS = 6000
/** A message is cut to fit only when at least this much of the budget is left. */
const MIN_PARTIAL_CHARS = 200

type Scope = 'mode' | 'folder' | 'all'

/** Chats each conversation has been shown by a search: chat_read may open those even outside the default scope. */
const surfaced = new Map<string, Set<string>>()
const MAX_TRACKED_SESSIONS = 50

function noteSurfaced(sessionId: string, chatIds: string[]): void {
  let set = surfaced.get(sessionId)
  if (!set) {
    if (surfaced.size >= MAX_TRACKED_SESSIONS) surfaced.delete(surfaced.keys().next().value as string)
    set = new Set()
    surfaced.set(sessionId, set)
  }
  for (const id of chatIds) set.add(id)
}

const day = (at: number) => new Date(at).toLocaleDateString('sv-SE')

/** Local start of a YYYY-MM-DD day (or any date string `Date` understands). NaN when it is not a date. */
function parseDay(text: string | undefined): number | undefined {
  if (!text) return undefined
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim())
  const at = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : Date.parse(text)
  return Number.isNaN(at) ? NaN : at
}

const samePath = (a: string, b: string) => path.resolve(a) === path.resolve(b)

interface Caller {
  sessionId: string
  mode: SendMessageInput['mode']
  directory?: string
  folderId: string | null
}

/** Which chats a scope lets through, from the caller's point of view. */
function scopeFilter(scope: Scope, caller: Caller): { allows: (chat: IndexedChat) => boolean; label: string } {
  if (scope === 'all') return { allows: () => true, label: 'all chats' }
  if (caller.mode === 'code') {
    const allows = (chat: IndexedChat) =>
      chat.mode === 'code' &&
      ((caller.directory !== undefined && chat.directory !== undefined && samePath(chat.directory, caller.directory)) ||
        (caller.folderId !== null && chat.folderId === caller.folderId))
    return { allows, label: 'code chats of this project' }
  }
  if (scope === 'folder') {
    const allows = (chat: IndexedChat) => chat.mode === 'chat' && caller.folderId !== null && chat.folderId === caller.folderId
    return { allows, label: 'chats in the same folder' }
  }
  return { allows: (chat) => chat.mode === 'chat', label: 'chats' }
}

async function callerOf(input: Pick<SendMessageInput, 'sessionId' | 'mode' | 'directory'>): Promise<Caller> {
  const own = await readJson<SessionInfo>(StorageKeys.session(input.sessionId))
  return {
    sessionId: input.sessionId,
    mode: input.mode,
    directory: input.directory ?? own?.directory,
    folderId: own?.folderId ?? null,
  }
}

/** Text a person or the model said in the message — what the index also holds. */
function sayings(message: ChatMessage): string {
  return message.parts
    .filter((p) => p.type === 'text' && !p.source)
    .map((p) => (p as { text: string }).text.trim())
    .filter(Boolean)
    .join('\n\n')
}

function toolNames(message: ChatMessage): string[] {
  const names = message.parts.filter((p) => p.type === 'tool').map((p) => (p as { tool: string }).tool)
  return [...new Set(names)]
}

export function createChatSearchTools(input: Pick<SendMessageInput, 'sessionId' | 'mode' | 'directory'>): ToolSet {
  return {
    chat_search: tool({
      description: [
        'Searches what was said in the user\'s PAST conversations (their text and yours — not tool output) and returns the best passages,',
        'each with the chat id, mode, date and who said it.',
        'Call it when the user refers to something discussed or decided before ("what did we decide about X", "that bug from last week")',
        'and neither memory nor the current conversation has the answer. Matching ignores accents and also finds words that start with',
        'what you typed; use the distinctive words of the subject, not a full sentence.',
        'The header tells how many passages and chats matched and whether the index was complete: zero results with a complete index means it was not said,',
        'not that the search failed. Open a result with chat_read.',
        'The current conversation is never searched.',
        input.mode === 'code'
          ? 'Default scope: the code chats of this same project. scope "all" also searches every other chat and project, and asks the user first.'
          : 'Default scope: the user\'s chats. scope "folder" narrows to chats in the same folder; "all" also includes code chats.',
      ].join(' '),
      inputSchema: z.object({
        query: z.string().min(1).describe('Words to look for'),
        scope: z
          .enum(['mode', 'folder', 'all'])
          .optional()
          .describe('Default "mode": the chats described above. "folder": same sidebar folder (same project in code mode). "all": every chat.'),
        after: z.string().optional().describe('Only passages from this day on, YYYY-MM-DD (inclusive)'),
        before: z.string().optional().describe('Only passages before this day, YYYY-MM-DD (exclusive)'),
        role: z.enum(['user', 'assistant']).optional().describe('Only what the user said, or only what the assistant said'),
        limit: z.number().int().min(1).max(10).optional().describe(`How many passages to return. Default ${DEFAULT_LIMIT}.`),
        includeArchived: z.boolean().optional().describe('Default true: archived chats are still the user\'s history.'),
      }),
      execute: async ({ query, scope, after, before, role, limit, includeArchived }) => {
        const afterAt = parseDay(after)
        const beforeAt = parseDay(before)
        if (Number.isNaN(afterAt) || Number.isNaN(beforeAt)) return 'Error: after/before must be dates in the form YYYY-MM-DD.'

        const caller = await callerOf(input)
        const { allows, label } = scopeFilter(scope ?? 'mode', caller)
        if ((scope ?? 'mode') === 'folder' && caller.mode === 'chat' && caller.folderId === null) {
          return 'This chat is not inside a folder, so scope "folder" has nothing to search. Use scope "mode" or "all".'
        }

        const result = await sessionIndex().search({
          query,
          chat: allows,
          excludeSessionIds: [input.sessionId],
          includeArchived: includeArchived ?? true,
          titles: false,
          role,
          after: afterAt,
          before: beforeAt,
        })
        const shown = result.matches.slice(0, limit ?? DEFAULT_LIMIT)
        noteSurfaced(input.sessionId, shown.map((m) => m.chat.id))

        const { indexed, total, complete } = result.status
        const header =
          `${shown.length} of ${result.matches.length} passages across ${result.chats} chats ` +
          `(indexed ${indexed}/${total}) · scope: ${label}` +
          (complete ? '' : ' · INDEX STILL BUILDING — older chats may be missing, search again in a moment')
        if (shown.length === 0) {
          const hints = [
            (scope ?? 'mode') !== 'all' ? 'scope "all" searches every chat' : null,
            'try other or fewer words (word starts match, accents do not matter)',
          ].filter(Boolean)
          return `${header}\nNothing matched. ${hints.join('; ')}.`
        }
        return [
          header,
          ...shown.flatMap(({ passage, chat }) => [
            `#${chat.id} [${chat.mode}${chat.archived ? ', archived' : ''}] ${day(passage.at)} "${chat.title}" · ${passage.role} · msg ${passage.messageId}`,
            `  ${excerpt(passage.text, result.terms, SNIPPET_CHARS)}`,
          ]),
        ].join('\n')
      },
    }),

    chat_read: tool({
      description: [
        'Reads a few messages of a past conversation found with chat_search: only what the user and the assistant said, plus the names of the tools',
        'that were called (never their output). Pass around=<msg id from the result> to read the surroundings of the passage;',
        'without it, the opening of the chat. It never returns a whole chat: the output stops at maxChars and says how many messages were left out,',
        'so move through a long chat by calling again with around set to the last message you got.',
        'The current conversation cannot be read — you already have it.',
      ].join(' '),
      inputSchema: z.object({
        id: z.string().min(1).describe('Chat id from chat_search (the part after #)'),
        around: z.string().optional().describe('Message id from chat_search ("msg …") to center the window on, or "latest" for the end of the chat'),
        before: z.number().int().min(0).max(MAX_WINDOW).optional().describe(`Messages before the anchor. Default ${DEFAULT_WINDOW}.`),
        after: z.number().int().min(0).max(MAX_WINDOW).optional().describe(`Messages after the anchor. Default ${DEFAULT_WINDOW}.`),
        maxChars: z.number().int().min(500).max(20_000).optional().describe(`Ceiling on the text returned. Default ${DEFAULT_MAX_CHARS}.`),
      }),
      execute: async ({ id, around, before, after, maxChars }) => {
        if (id === input.sessionId) {
          return 'This is the current conversation — its messages are already in your context.'
        }
        const info = await readJson<SessionInfo>(StorageKeys.session(id)).catch(() => null)
        if (!info || !isUserChat(info)) return `Error: no chat with id ${id}. Use an id from chat_search.`

        // Inside the default scope, or shown to this conversation by a search the user already allowed.
        const caller = await callerOf(input)
        const chat: IndexedChat = {
          id: info.id,
          title: info.title,
          mode: info.mode,
          directory: info.directory,
          folderId: info.folderId ?? null,
          archived: Boolean(info.archived),
          updatedAt: info.updatedAt,
        }
        if (!scopeFilter('mode', caller).allows(chat) && !surfaced.get(input.sessionId)?.has(id)) {
          return `Error: chat ${id} is outside this conversation's scope. Find it with chat_search first (scope "all" asks the user in code mode).`
        }

        const all = (await readJson<ChatMessage[]>(StorageKeys.messages(id))) ?? []
        if (all.length === 0) return `Chat "${info.title}" has no messages.`
        const back = before ?? DEFAULT_WINDOW
        const ahead = after ?? DEFAULT_WINDOW
        let anchor = 0
        if (around === 'latest') {
          anchor = all.length - 1
        } else if (around) {
          anchor = all.findIndex((m) => m.id === around)
          if (anchor < 0) return `Error: message ${around} is not in chat ${id}. Omit "around" to read from the start.`
        }
        const from = around ? Math.max(0, anchor - back) : 0
        const to = Math.min(all.length, (around ? anchor : 0) + ahead + 1 + (around ? 0 : back))

        const budget = maxChars ?? DEFAULT_MAX_CHARS
        let used = 0
        let shown = 0
        let cut = false
        const blocks: string[] = []
        for (let i = from; i < to; i++) {
          const message = all[i]
          const tools = toolNames(message)
          const head =
            `--- ${message.role}${message.summary ? ' (summary)' : ''} ${day(message.createdAt)} · msg ${message.id}` +
            (tools.length ? ` · tools: ${tools.join(', ')}` : '')
          let text = sayings(message) || '(no text)'
          const room = budget - used - head.length
          if (room < Math.min(text.length, MIN_PARTIAL_CHARS)) break
          if (text.length > room) {
            text = `${text.slice(0, room).trimEnd()}… [cut]`
            cut = true
          }
          blocks.push(`${head}\n${text}`)
          used += head.length + text.length
          shown++
          if (cut) break
        }
        const left = to - from - shown
        const last = all[from + shown - 1]
        const lines = [
          `#${info.id} [${info.mode}] "${info.title}" · messages ${from + 1}–${from + shown} of ${all.length}`,
          ...blocks,
        ]
        if (left > 0 || cut) {
          lines.push(
            `truncated: ${left} more messages${cut ? ' (the last one is cut)' : ''} in this window. Raise maxChars, or call again with around="${last?.id ?? ''}".`,
          )
        } else if (to < all.length) {
          lines.push(`${all.length - to} later messages not shown. Call again with around="${all[to - 1].id}" to continue.`)
        }
        return lines.join('\n')
      },
    }),
  }
}
