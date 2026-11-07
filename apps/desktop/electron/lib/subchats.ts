import type { ChatMessage, SessionInfo, SpecialistProfile } from '@shared/chat'
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

/**
 * First line the MODEL reads on a subchat's result that woke the parent up (a user
 * message with `origin: 'subchat'`, see subchat-wake.ts). It is added when the history
 * is turned into model messages, never persisted: the screens (desktop notice, mobile
 * bubble) show the stored text, and older wake messages get it too.
 *
 * It says on its own what the message is and what to do, so the system prompt does not
 * have to. A single "[SYSTEM: …]" line with no "]" inside, like ENGINE_CONTEXT_HEADER:
 * if the model ever echoes it, stripEngineMarkers removes it from the visible answer.
 */
export const SUBCHAT_RESULT_MARKER =
  "[SYSTEM: a subchat you started finished a turn; this is its result, delivered by the app — the user did not type it. Carry on with whatever part of the user's request it unblocks; if nothing is left, tell the user in a line or two what the subchat did and where. Do not answer it as a question from the user, and do not send the subchat more work unless the user's request needs it.]"

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
  /** What a specialist child made (motion, design, fragment), described so the parent can reach it. */
  artifacts?: string[]
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
  /** A specialist chat: it runs the lean profile of that craft for its whole life. */
  profile?: SpecialistProfile
}

export interface NewContinuation {
  /** Conversation the brief was written from — read only for mode, folder and extra folders. */
  sourceId: string
  title: string
  body: string
}

/**
 * Creates the conversation with the brief as its opening message — a system summary,
 * for the new chat's model to read as context and for the UI to show as a card.
 * It inherits mode, folder and extra folders from the source: the work goes on in the same place.
 * With `parentId` it is a subchat; without it, a top-level chat that merely continues the work.
 */
async function createRecord({
  source,
  title,
  body,
  parentId,
  continuedFrom,
  fallbackTitle,
  profile,
}: {
  source: SessionInfo
  title: string
  body: string
  parentId?: string
  continuedFrom?: string
  fallbackTitle: string
  profile?: SpecialistProfile
}): Promise<SessionInfo> {
  const now = Date.now()
  const session: SessionInfo = {
    id: newId('ses'),
    title: title.trim().slice(0, 80) || fallbackTitle,
    mode: source.mode,
    pinned: false,
    archived: false,
    folderId: source.folderId,
    directory: source.directory,
    extraDirectories: source.extraDirectories,
    ...(parentId ? { parentId } : {}),
    ...(continuedFrom ? { continuedFrom } : {}),
    // The fragment chat keeps its own field (see specialistProfileOf); the others use `profile`.
    ...(profile === 'fragment' ? { fragment: { kind: 'screen' as const } } : profile ? { profile } : {}),
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

  await writeJson(StorageKeys.session(session.id), session)
  await writeJson(StorageKeys.messages(session.id), [opening])
  return session
}

/** Conversation attached to `parentId` — the subchat of the tools and of the card. */
export async function createSubchatRecord({ parentId, title, body, profile }: NewSubchat): Promise<SessionInfo | null> {
  const parent = await readJson<SessionInfo>(StorageKeys.session(parentId))
  if (!parent) return null
  return createRecord({ source: parent, title, body, parentId, fallbackTitle: 'Subchat', profile })
}

/**
 * A NEW top-level conversation continuing the work of `sourceId` — the case of a long
 * conversation, where another compaction would make a summary of a summary and lose the
 * beginning. It is deliberately WITHOUT `parentId`: a new chat is not a child chat, and it
 * must not be indented under (nor vanish with) the one it came from.
 */
export async function createContinuationRecord({ sourceId, title, body }: NewContinuation): Promise<SessionInfo | null> {
  const source = await readJson<SessionInfo>(StorageKeys.session(sourceId))
  if (!source) return null
  return createRecord({ source, title, body, continuedFrom: source.id, fallbackTitle: 'New chat' })
}

/** The turn block: the parent sees the RESULT of each child. */
export function formatSubchatsBlock(summaries: SubchatSummary[]): string {
  if (summaries.length === 0) return ''
  const lines = summaries.map(({ session, result, artifacts }) => {
    const capped = result && result.length > MAX_RESULT
      ? `${result.slice(0, MAX_RESULT).replace(/\s+/g, ' ')}…`
      : result?.replace(/\s+/g, ' ')
    const made = artifacts?.length ? `\n  Made: ${artifacts.join('; ')}` : ''
    return `- **${session.title}** (id: ${session.id}, opened ${relativeTime(session.createdAt)})${capped ? `\n  Latest: ${capped}` : ''}${made}`
  })
  const reachable = summaries.some((s) => s.artifacts?.length)
    ? ' What a specialist subchat made is listed under "Made": you can read and change it yourself with the tools of its craft, passing the id — no need to send it back to the subchat for a small change.'
    : ''
  return [
    '## Subchats opened from this conversation',
    'Separate conversations with their own context, attached to this one. You see each one\'s LATEST result here, not its history: read_subchat reads more when you need it. Stay consistent with what they did and do not redo their work; when the user asks about one, answer from this line and point them to the chat. To give one a new instruction use send_to_subchat — the user is asked before it goes.' + reachable,
    ...lines,
  ].join('\n')
}

/** Conversations that continue this one (newest first) — where the work went after it got long. */
export async function listContinuations(sessionId: string): Promise<SessionInfo[]> {
  const keys = await listKeys(StorageKeys.sessionPrefix)
  const sessions = (await Promise.all(keys.map((k) => readJson<SessionInfo>(k)))).filter(
    (s): s is SessionInfo => s != null && s.continuedFrom === sessionId && !s.archived,
  )
  return sessions.sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * What changes between turns about this conversation's relatives: the latest result of
 * each subchat and the chats that continue it. It travels in the turn's message, never in
 * the system prompt — a child answering would otherwise throw away the cache prefix of
 * the whole conversation.
 */
export async function subchatsTurnBlock(
  sessionId: string,
  /** What a child made (artifacts/describe.ts); injected so this module stays free of the artifact stores. */
  artifactsOf: (childId: string) => Promise<string[]> = async () => [],
): Promise<string> {
  const [found, continuations] = await Promise.all([listSubchats(sessionId), listContinuations(sessionId)])
  const children = await Promise.all(
    found.map(async (child) => ({ ...child, artifacts: await artifactsOf(child.session.id).catch(() => []) })),
  )
  const parts = [formatSubchatsBlock(children)]
  if (continuations.length > 0) {
    parts.push(
      [
        '## This conversation continues elsewhere',
        'The work moved to a fresh conversation when this one got long. What happened there is NOT in this context: say so when asked, and read it with chat_read (around "latest") instead of guessing.',
        ...continuations.map((c) => `- **${c.title}** (id: ${c.id}, opened ${relativeTime(c.createdAt)})`),
      ].join('\n'),
    )
  }
  return parts.filter(Boolean).join('\n\n')
}

/**
 * Who this conversation is to another one — stable for its whole life, so it may live in
 * the system prompt. A subchat learns it has a parent that reads its answers; a
 * continuation learns where its history lives.
 */
export async function conversationOriginBlock(session: SessionInfo | null): Promise<string> {
  if (!session || session.orchestration?.role === 'worker') return ''
  const lines: string[] = []
  if (session.parentId) {
    const parent = await readJson<SessionInfo>(StorageKeys.session(session.parentId))
    if (parent) {
      lines.push(
        `## You are a subchat of "${parent.title}" (id: ${parent.id})`,
        'That conversation opened you for one piece of work and is waiting on it. When a turn of yours was started by it (its brief, or a message marked as coming from it), your FINAL message goes back to it and wakes it up — so end that turn with what it needs: the result (what changed, exact paths, what was verified, what was not), or the one decision only it can make, asked plainly. Do not end with a question to the user for something the parent conversation can decide.',
        `To look at what it is doing, read it with chat_read({ id: "${parent.id}", around: "latest" }). The user can also talk to you directly here: then answer the user.`,
      )
    }
  }
  if (session.continuedFrom) {
    const source = await readJson<SessionInfo>(StorageKeys.session(session.continuedFrom))
    if (source) {
      lines.push(
        `## This conversation continues "${source.title}" (id: ${source.id})`,
        `It was opened with a brief because that one got long; its full history stays there. When the brief is not enough, read it with chat_read({ id: "${source.id}", around: "latest" }) instead of guessing.`,
      )
    }
  }
  return lines.join('\n')
}
