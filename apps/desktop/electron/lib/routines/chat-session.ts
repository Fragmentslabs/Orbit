import type { ChatMessage, RoutineRunPart, SessionInfo, TextPart, TokenUsage } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import type { Routine, RoutineRun } from '@shared/routines'
import { routineChatSessionId, routineRunMessageId } from '@shared/routines'
import { broadcastChatEvent, broadcastRoutineEvent } from '../broadcast'
import { readJson, writeJson } from '../storage'
import { ensureRoutineFolder } from './folder'
import { updateRoutine } from './repo'

/**
 * The routine's ONE conversation.
 *
 * A routine used to be a pile of chats, one per execution. Here it gains a chat of its own —
 * the one the person talks to — and each execution becomes a MESSAGE of it: the answer is the
 * text, and a `RoutineRunPart` rides along with the metadata (state, team, cost). The execution
 * still runs in a session of its own, a CHILD of this one: the agent that works never carries
 * the history of the previous runs, while the person reads everything in one scroll.
 */

/** Ceiling of the answer copied into the conversation: a reading copy, not the record. */
const MAX_ANSWER = 12_000

/** Header carried by the message of one execution, as the chat renders it. */
export type RunCardInfo = {
  run: RoutineRun
  /** Team members that took part, in order (the avatar group). */
  agents: string[]
  reason: 'schedule' | 'manual' | 'event'
}

/**
 * Creates the routine's chat the first time it is needed and keeps it aligned with the routine
 * afterwards (title, folder, working folders). Called when the screen opens and before every
 * execution.
 *
 * The chat lives in the routine's own folder — created here the first time it is needed — and
 * the working folders ride along as extras: places the agent reads and edits, never where the
 * routine keeps its memory or its scripts.
 */
export async function ensureRoutineChat(routine: Routine, knownFolder?: string): Promise<SessionInfo> {
  const id = routineChatSessionId(routine.id)
  const now = Date.now()
  const existing = await readJson<SessionInfo>(StorageKeys.session(id)).catch(() => null)
  const folder = knownFolder ?? routine.folder ?? (await ensureRoutineFolder(routine))
  if (folder !== routine.folder) {
    const saved = await updateRoutine(routine.id, (r) => ({ ...r, folder })).catch(() => null)
    if (saved) broadcastRoutineEvent({ type: 'routine', routine: saved })
  }
  const session: SessionInfo = {
    id,
    title: routine.title,
    mode: 'code',
    // The routine's chat is never pinned or archived on its own: it belongs to the routine,
    // not to the list of conversations.
    pinned: false,
    archived: false,
    folderId: null,
    directory: folder,
    ...(routine.folders.length > 0 ? { extraDirectories: [...routine.folders] } : {}),
    routineId: routine.id,
    routineChat: true,
    // A routine run by an agent opens its chat as that agent's chat.
    ...(routine.agent ? { profile: routine.agent } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  await writeJson(StorageKeys.session(id), session)
  // The renderer only knows the session through this event: it was born in the main process,
  // outside the session-store.
  broadcastChatEvent({ type: 'session', sessionId: id, session })
  return session
}

/**
 * Text of the last answer of an execution — what the message of the run shows. The final answer
 * is the LAST text block of the run's last assistant message: the same block its own chat shows
 * as the answer.
 */
async function lastAnswer(sessionId: string): Promise<string> {
  const messages = (await readJson<ChatMessage[]>(StorageKeys.messages(sessionId)).catch(() => null)) ?? []
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'assistant') continue
    const texts = message.parts.filter(
      (part): part is TextPart => part.type === 'text' && !!part.text.trim(),
    )
    const text = texts.length > 0 ? texts[texts.length - 1].text.trim() : ''
    if (!text) continue
    return text.length > MAX_ANSWER ? `${text.slice(0, MAX_ANSWER).trimEnd()}…` : text
  }
  return ''
}

/** What the execution consumed, summed from the turns it wrote — the footer of its message. */
async function sessionUsage(sessionId: string): Promise<TokenUsage | undefined> {
  const messages = (await readJson<ChatMessage[]>(StorageKeys.messages(sessionId)).catch(() => null)) ?? []
  let input = 0
  let output = 0
  let reasoning = 0
  let cacheRead = 0
  let cacheWrite = 0
  let cost = 0
  let any = false
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.tokens) continue
    any = true
    input += message.tokens.input
    output += message.tokens.output
    reasoning += message.tokens.reasoning
    cacheRead += message.tokens.cacheRead ?? 0
    cacheWrite += message.tokens.cacheWrite ?? 0
    cost += message.tokens.cost ?? 0
  }
  if (!any) return undefined
  return { input, output, reasoning, cacheRead, cacheWrite, cost }
}

/** The metadata of one execution, as the message carries it. */
function runPart(run: RoutineRun, agents: readonly string[]): RoutineRunPart {
  return {
    id: `run_part_${run.sessionId}`,
    type: 'routine-run',
    runId: run.sessionId,
    sessionId: run.sessionId,
    status: run.status === 'running' ? 'error' : run.status,
    startedAt: run.startedAt,
    ...(run.completedAt ? { finishedAt: run.completedAt } : {}),
    reason: run.reason,
    ...(run.cost > 0 ? { cost: run.cost } : {}),
    ...(run.error ? { error: run.error } : {}),
    ...(agents.length > 0 ? { agents: [...agents] } : {}),
  }
}

async function readMessages(chatId: string): Promise<ChatMessage[]> {
  return (await readJson<ChatMessage[]>(StorageKeys.messages(chatId)).catch(() => null)) ?? []
}

async function writeMessages(chatId: string, messages: ChatMessage[]): Promise<void> {
  await writeJson(StorageKeys.messages(chatId), messages)
  broadcastChatEvent({ type: 'messages', sessionId: chatId, messages })
}

/**
 * One writer per chat at a time.
 *
 * Every mutation here reads the file, changes the list and writes it back. A run starting while
 * the screen backfills the history would make the second writer erase the first one's messages —
 * the whole list is theirs. The queue keeps the conversation whole without a lock on disk.
 */
const chatLocks = new Map<string, Promise<unknown>>()

function withChatLock<T>(chatId: string, task: () => Promise<T>): Promise<T> {
  const previous = chatLocks.get(chatId) ?? Promise.resolve()
  const run = previous.then(
    () => task(),
    () => task(),
  )
  chatLocks.set(
    chatId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  )
  return run
}

/** Puts the execution in the routine's chat, already in the "running" state. */
export async function appendRunCard(chatId: string, info: RunCardInfo): Promise<void> {
  await withChatLock(chatId, async () => {
    const messages = await readMessages(chatId)
    // A retry of the same execution must not leave two messages behind.
    const clean = messages.filter((message) => message.id !== routineRunMessageId(info.run.sessionId))
    clean.push({
      id: routineRunMessageId(info.run.sessionId),
      role: 'assistant',
      createdAt: info.run.startedAt,
      parts: [
        {
          id: `run_part_${info.run.sessionId}`,
          type: 'routine-run',
          runId: info.run.sessionId,
          sessionId: info.run.sessionId,
          status: 'running',
          startedAt: info.run.startedAt,
          reason: info.reason,
          ...(info.agents.length ? { agents: info.agents } : {}),
        },
      ],
    })
    await writeMessages(chatId, clean)
  })
}

/** Closes the execution's message with the result (or the failure). */
export async function finishRunCard(chatId: string, run: RoutineRun): Promise<void> {
  await withChatLock(chatId, async () => {
    const messages = await readMessages(chatId)
    const message = messages.find((m) => m.id === routineRunMessageId(run.sessionId))
    if (!message) return
    const part = message.parts.find((p): p is RoutineRunPart => p.type === 'routine-run')
    if (!part) return

    part.status = run.status === 'running' ? 'error' : run.status
    part.finishedAt = run.completedAt ?? Date.now()
    part.cost = run.cost
    if (run.error) part.error = run.error

    // The execution IS the message: its answer becomes the TEXT of the conversation, and the
    // part keeps only the metadata. Nothing has to be opened elsewhere to be read.
    const answer = run.status === 'error' ? '' : await lastAnswer(run.sessionId)
    if (answer) {
      part.summary = answer.length > 600 ? `${answer.slice(0, 600).trimEnd()}…` : answer
      if (!message.parts.some((p) => p.type === 'text')) {
        message.parts.push({
          id: `run_text_${run.sessionId}`,
          type: 'text',
          state: 'done',
          text: answer,
        })
      }
    } else if (run.status === 'error') {
      // No answer in a failure: the reason is what the message has to say.
      delete part.summary
    }
    message.completedAt = run.completedAt ?? Date.now()
    const usage = await sessionUsage(run.sessionId)
    if (usage) message.tokens = usage

    await writeMessages(chatId, messages)
  })
}

/**
 * The executions that are not in the conversation yet, put there: the historical ones (from
 * before this chat existed) and the messages of the old format, which carried only a condensed
 * summary instead of the answer.
 *
 * Runs when the routine screen opens. The "previous executions" list points at these messages,
 * so an execution that is not here could not even be jumped to.
 */
export async function syncRunMessages(
  chatId: string,
  routine: Routine,
  runs: readonly RoutineRun[],
): Promise<void> {
  await withChatLock(chatId, async () => {
    const messages = await readMessages(chatId)
    const byId = new Map(messages.map((message) => [message.id, message]))
    const agents = routine.team?.members.map((member) => member.name) ?? []
    let changed = false

    for (const run of [...runs].sort((a, b) => a.startedAt - b.startedAt)) {
      // The live execution already has its message (written when it started).
      if (run.status === 'running') continue
      const id = routineRunMessageId(run.sessionId)
      const existing = byId.get(id)
      if (existing) {
        // A message from the previous format: the header exists, the answer was only a summary.
        const hasText = existing.parts.some((part) => part.type === 'text' && !!part.text.trim())
        if (!hasText && run.status !== 'error') {
          const text = await lastAnswer(run.sessionId)
          if (text) {
            existing.parts.push({
              id: `run_text_${run.sessionId}`,
              type: 'text',
              state: 'done',
              text,
            })
            changed = true
          }
        }
        // The footer of an old message was never filled: the duration and what it consumed
        // belong to it just the same.
        if (!existing.completedAt && run.completedAt) {
          existing.completedAt = run.completedAt
          changed = true
        }
        if (!existing.tokens) {
          const usage = await sessionUsage(run.sessionId)
          if (usage) {
            existing.tokens = usage
            changed = true
          }
        }
        continue
      }
      // The execution's session may have been deleted: there is nothing to read or to jump to.
      const session = await readJson<SessionInfo>(StorageKeys.session(run.sessionId)).catch(() => null)
      if (!session) continue
      const answer = run.status === 'error' ? '' : await lastAnswer(run.sessionId)
      const part = runPart(run, agents)
      if (answer) part.summary = answer.length > 600 ? `${answer.slice(0, 600).trimEnd()}…` : answer
      const message: ChatMessage = {
        id,
        role: 'assistant',
        createdAt: run.startedAt,
        ...(run.completedAt ? { completedAt: run.completedAt } : {}),
        parts: [
          part,
          ...(answer
            ? [{ id: `run_text_${run.sessionId}`, type: 'text' as const, state: 'done' as const, text: answer }]
            : []),
        ],
      }
      const usage = await sessionUsage(run.sessionId)
      if (usage) message.tokens = usage
      messages.push(message)
      byId.set(id, message)
      changed = true
    }

    if (!changed) return
    messages.sort((a, b) => a.createdAt - b.createdAt)
    await writeMessages(chatId, messages)
  })
}

/** Removes the messages of the executions that no longer exist (a deleted execution session). */
export async function dropRunCards(chatId: string, sessionIds: readonly string[]): Promise<void> {
  if (!sessionIds.length) return
  await withChatLock(chatId, async () => {
    const gone = new Set(sessionIds)
    const messages = await readMessages(chatId)
    const kept = messages.filter(
      (message) => !message.parts.some((p) => p.type === 'routine-run' && gone.has(p.sessionId)),
    )
    if (kept.length === messages.length) return
    await writeMessages(chatId, kept)
  })
}
