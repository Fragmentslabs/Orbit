import { describeChatArtifacts } from './artifacts/describe'
import type { BrowserWindow } from 'electron'
import type { ChatMessage, SendMessageInput, SessionInfo } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import { getRunningSessionIds, lastTurnAborted, runChat } from './chat-engine'
import { readJson } from './storage'
import { tNow } from './i18n'

/**
 * Wakes a conversation up when a subchat it started finishes a turn.
 *
 * Without it the parent only learned the result on the user's next message, so the
 * subchat looked like it reported to nobody. Now its final message comes back as a
 * turn of the parent — marked `origin: 'subchat'`, so neither the screen nor the
 * model reads it as something the user typed.
 *
 * Only turns the PARENT started wake it (its brief, send_to_subchat): when the user
 * talks to the subchat directly, that is their conversation. Three guards keep it from
 * running on its own:
 * - a subchat the user stopped does not wake anyone;
 * - at most MAX_STREAK wakes in a row with no message typed by the user in between
 *   (parent → subchat → parent → … would otherwise loop for as long as it likes);
 * - the parent's own turn is never interrupted: the wake waits until it is idle, and
 *   the wakes of one parent run one at a time.
 */

const MAX_STREAK = 3
/** How long a wake waits for a busy parent before giving up (its result stays in the turn block). */
const MAX_WAIT_MS = 30 * 60_000
const POLL_MS = 2_000
const MAX_RESULT = 4_000

/** One chain per parent: two subchats finishing together must not start two turns of it. */
const chains = new Map<string, Promise<void>>()

function textOf(message: ChatMessage): string {
  return message.parts
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text?: string }).text ?? '')
    .join('\n')
    .trim()
}

/** Wakes in a row since the last message the user typed in the parent. */
export function wakeStreak(history: ChatMessage[]): number {
  let streak = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (m.role !== 'user') continue
    if (m.origin !== 'subchat') break
    streak++
  }
  return streak
}

async function waitIdle(sessionId: string): Promise<boolean> {
  const deadline = Date.now() + MAX_WAIT_MS
  while (getRunningSessionIds().includes(sessionId)) {
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  return true
}

/** The parent's message: who finished, and what it said. */
export function wakeText(child: SessionInfo, last: ChatMessage | undefined, made: readonly string[] = []): string {
  const head = tNow('subchat.finished', { title: child.title, id: child.id })
  // What a specialist subchat made, with the id to reach it: the parent can act on it directly.
  const madeBlock = made.length ? `\n\nMade by this subchat (you can read and change it with the tools of its craft):\n${made.map((m) => `- ${m}`).join('\n')}` : ''
  if (!last) return `${head}\n\n${tNow('subchat.finishedEmpty')}${madeBlock}`
  if (last.error) return `${head}\n\n${tNow('subchat.finishedError')} ${last.error}${madeBlock}`
  const text = textOf(last)
  if (!text) return `${head}\n\n${tNow('subchat.finishedEmpty')}${madeBlock}`
  return `${head}\n\n${text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}… [read_subchat for the rest]` : text}${madeBlock}`
}

async function wake(win: BrowserWindow, opener: SendMessageInput, child: SessionInfo): Promise<void> {
  const parentId = child.parentId
  if (!parentId || lastTurnAborted(child.id)) return
  if (!(await waitIdle(parentId))) return
  const parent = await readJson<SessionInfo>(StorageKeys.session(parentId))
  if (!parent || parent.archived) return
  const history = (await readJson<ChatMessage[]>(StorageKeys.messages(parentId))) ?? []
  if (wakeStreak(history) >= MAX_STREAK) return
  const childMessages = (await readJson<ChatMessage[]>(StorageKeys.messages(child.id))) ?? []
  const last = [...childMessages].reverse().find((m) => m.role === 'assistant' && !m.summary)
  // The user may have sent something while we waited; their turn wins.
  if (getRunningSessionIds().includes(parentId)) return
  const o = opener.options
  await runChat(win, {
    sessionId: parentId,
    text: wakeText(child, last, await describeChatArtifacts(child.id).catch(() => [])),
    messageOrigin: 'subchat',
    providerId: opener.providerId,
    modelId: opener.modelId,
    mode: parent.mode,
    // The capabilities the parent had when it opened the subchat — not one-off turn
    // flags (retry, plan review, overlay, voice call), which belonged to that turn.
    options: {
      permissionMode: o.permissionMode,
      followGlobalPermission: o.followGlobalPermission,
      reasoning: o.reasoning,
      brain: o.brain,
      brainContext: o.brainContext,
      skillHints: o.skillHints,
      research: o.research,
      browser: o.browser,
      subagents: o.subagents,
      toolsServers: o.toolsServers,
    },
    directory: parent.directory,
    extraDirectories: parent.extraDirectories,
    visionModel: opener.visionModel,
    language: opener.language,
  })
}

/** Queues the wake of `child`'s parent after a turn the parent started. Never throws. */
export function wakeParentOf(win: BrowserWindow, opener: SendMessageInput, child: SessionInfo): void {
  const parentId = child.parentId
  if (!parentId) return
  const previous = chains.get(parentId) ?? Promise.resolve()
  const next = previous
    .then(() => wake(win, opener, child))
    .catch((err) => console.error('[subchat] waking the parent failed:', err))
  chains.set(parentId, next)
  void next.finally(() => {
    if (chains.get(parentId) === next) chains.delete(parentId)
  })
}
