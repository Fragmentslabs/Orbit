import type { ChatMessage, SessionInfo } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import { listKeys, readJson, writeJson } from './storage'
import { SUMMARY_PREFIX } from './compaction'

/**
 * Subchats: conversations opened from another one, with their own context.
 *
 * The child keeps the parent (`parentId`), but the parent needs the INVERSE list on every
 * turn. There is no persisted index: one scan per turn costs less than keeping
 * a file synchronized by two writers (the renderer creates the child from the card,
 * the main creates the one from the tool) — and the parentId never changes after creation.
 */

const MAX_SUBCHATS = 8
/** How much of the child's last result enters the parent's context. */
const MAX_RESULT = 600
/** With no result yet, the brief serves as a summary (it is what the child knows). */
const MAX_BRIEF = 400

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** All the text of a message, without the summary marker. */
function messageText(message: ChatMessage): string {
  const text = message.parts
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text?: string }).text ?? '')
    .join('\n')
    .trim()
  return text.startsWith(SUMMARY_PREFIX) ? text.slice(SUMMARY_PREFIX.length).trim() : text
}

function relativeTime(when: number): string {
  const min = Math.round((Date.now() - when) / 60_000)
  if (min < 2) return 'just now'
  if (min < 60) return `${min} min ago`
  const hours = Math.round(min / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export interface SubchatSummary {
  session: SessionInfo
  /** What the child produced last — or the brief, if it has not run yet. */
  result?: string
}

/** Children of a conversation, from the most recent to the oldest. */
export async function listSubchats(parentId: string): Promise<SubchatSummary[]> {
  const keys = await listKeys(StorageKeys.sessionPrefix)
  const sessions = (await Promise.all(keys.map((k) => readJson<SessionInfo>(k)))).filter(
    (s): s is SessionInfo =>
      // Orchestration workers have a parentId too, but they are workers.ts'
      // business (read_worker/message_worker) — here only attached conversations.
      s != null && s.parentId === parentId && !s.archived && s.orchestration?.role !== 'worker',
  )
  sessions.sort((a, b) => b.updatedAt - a.updatedAt)

  return Promise.all(
    sessions.slice(0, MAX_SUBCHATS).map(async (session) => {
      const messages = (await readJson<ChatMessage[]>(StorageKeys.messages(session.id))) ?? []
      const assistant = [...messages].reverse().find((m) => m.role === 'assistant' && !m.summary)
      const brief = [...messages].reverse().find((m) => m.summary)
      const result = assistant
        ? messageText(assistant)
        : brief
          ? messageText(brief).slice(0, MAX_BRIEF)
          : ''
      return { session, result: result || undefined }
    }),
  )
}

/**
 * A child of THIS conversation, by id. It is the lock of the tools that read or instruct
 * a subchat: the id comes from the model, so it only counts if the child's `parentId` is the
 * conversation that is calling — another of the user's chats, an orchestration
 * worker or an invented id all give null.
 */
export async function findSubchat(parentId: string, subchatId: string): Promise<SessionInfo | null> {
  const session = await readJson<SessionInfo>(StorageKeys.session(subchatId))
  if (!session || session.parentId !== parentId || session.orchestration?.role === 'worker') return null
  return session
}

export interface SubchatRead {
  /** Position (1-based) of the first message returned */
  from: number
  to: number
  total: number
  messages: { index: number; role: 'user' | 'assistant'; text: string; tools: string[]; error?: string }[]
}

/** Text ceiling per message on read — a detailed tool output does not fit. */
const MAX_MESSAGE_READ = 4000

/**
 * Last messages of a subchat, from the oldest to the most recent. The
 * opening message (the brief) counts like any other; tool calls
 * enter only by name.
 */
export async function readSubchatMessages(subchatId: string, last: number, skip = 0): Promise<SubchatRead> {
  const all = (await readJson<ChatMessage[]>(StorageKeys.messages(subchatId))) ?? []
  const end = Math.max(0, all.length - skip)
  const start = Math.max(0, end - last)
  const messages = all.slice(start, end).map((m, i) => {
    const text = messageText(m)
    return {
      index: start + i + 1,
      role: m.role as 'user' | 'assistant',
      text: text.length > MAX_MESSAGE_READ ? `${text.slice(0, MAX_MESSAGE_READ)}… [truncated]` : text,
      tools: m.parts.filter((p) => p.type === 'tool').map((p) => (p as { tool: string }).tool),
      error: m.error,
    }
  })
  return { from: start + 1, to: end, total: all.length, messages }
}

export interface NewSubchat {
  parentId: string
  title: string
  /** The text that opens the new chat (the brief). It becomes the summary message. */
  body: string
}

/**
 * Creates the child with the brief as its opening message — a system summary,
 * for the new chat's model to read as context and for the UI to show as a card.
 * It inherits mode, folder and extra folders from the parent: the work goes on in the same place.
 */
export async function createSubchatRecord({ parentId, title, body }: NewSubchat): Promise<SessionInfo | null> {
  const parent = await readJson<SessionInfo>(StorageKeys.session(parentId))
  if (!parent) return null

  const now = Date.now()
  const child: SessionInfo = {
    id: newId('ses'),
    title: title.trim().slice(0, 80) || 'Subchat',
    mode: parent.mode,
    pinned: false,
    archived: false,
    folderId: parent.folderId,
    directory: parent.directory,
    extraDirectories: parent.extraDirectories,
    parentId,
    createdAt: now,
    updatedAt: now,
  }

  const opening: ChatMessage = {
    id: newId('msg'),
    role: 'assistant',
    summary: true,
    continuation: true,
    parts: [
      {
        id: newId('prt'),
        type: 'text',
        text: `${SUMMARY_PREFIX}\n\n${body.trim()}`,
        state: 'done',
      },
    ],
    createdAt: now,
  }

  await writeJson(StorageKeys.session(child.id), child)
  await writeJson(StorageKeys.messages(child.id), [opening])
  return child
}

/** The system prompt block: the parent sees the RESULT of each child. */
export function formatSubchatsBlock(summaries: SubchatSummary[]): string {
  if (summaries.length === 0) return ''
  const lines = summaries.map(({ session, result }) => {
    const capped = result && result.length > MAX_RESULT
      ? `${result.slice(0, MAX_RESULT).replace(/\s+/g, ' ')}…`
      : result?.replace(/\s+/g, ' ')
    return `- **${session.title}** (id: ${session.id}, opened ${relativeTime(session.createdAt)})${capped ? `\n  Latest: ${capped}` : ''}`
  })
  return [
    '## Subchats opened from this conversation',
    'Separate conversations with their own context, attached to this one. You see each one\'s LATEST result here, not its history: read_subchat reads more when you need it. Stay consistent with what they did and do not redo their work; when the user asks about one, answer from this line and point them to the chat. To give one a new instruction use send_to_subchat — the user is asked before it goes.',
    ...lines,
  ].join('\n')
}
