import type { BrowserWindow } from 'electron'
import type { AskItem, ChatMessage, SendMessageInput, SessionInfo } from '@shared/chat'
import { StorageKeys, formatAskLine } from '@shared/chat'
import { reply as askReply } from './ask-broker'
import { readAppLanguage } from './app-language'
import { t } from './i18n'
import { listCredentialProviders } from './auth'
import { broadcastChatEvent } from './broadcast'
import { runChat } from './chat-engine'
import { createContinuationRecord, createSubchatRecord } from './subchats'
import { wakeParentOf } from './subchat-wake'
import { listKeys, readJson, removeJson, writeJson } from './storage'

/**
 * Resuming a request that is no longer in the broker.
 *
 * The ask-broker lives in memory: when the execution ends (abort, error, app
 * restarted), the promise waiting for the answer dies with it. The card, however,
 * is persisted in `pendingAsks/` and shows up again when the conversation is reopened — in
 * both apps. Answering there had nowhere to go: the card closed and nothing
 * happened.
 *
 * Instead of discarding the answer, it becomes a new user message in the
 * same session, with the original question alongside — the agent resumes from where it
 * stopped already knowing what was decided. Dismissing/denying is still just
 * discarding the card: nobody wants to wake the agent up to say "never mind".
 *
 * Answers are coalesced per session in a short window because a batch of worker
 * questions (orchestration mode) closes several cards at once — without it there
 * would be N concurrent runs in the same conversation.
 */

const WINDOW_MS = 400

type SavedRequest = AskItem & { batchId?: string }

interface QuestionReply {
  answers?: string[]
  rejected?: boolean
}

interface Queue {
  win: BrowserWindow
  blocks: string[]
  timer: NodeJS.Timeout
}

const queues = new Map<string, Queue>()

/** The sentences of the resumed message, in the app language (`electron/lib/i18n.ts`). */
interface Texts {
  authorize: string
  noAnswer: string
  subchatHere: string
}

async function texts(): Promise<Texts> {
  return {
    authorize: await t('resume.authorize'),
    noAnswer: await t('resume.noAnswer'),
    subchatHere: await t('resume.subchatHere'),
  }
}

/**
 * A chat suggestion answered after its run ended: the chat never existed, so the
 * "new chat" choice would be lost with the card. It creates it from the saved
 * brief and starts it, with the parent's last model — the same one the conversation
 * would have used. The saved `scope` decides the shape: attached subchat, or a new
 * top-level chat when the reason was the conversation itself being long.
 */
async function openSavedSubchat(win: BrowserWindow, sessionId: string, item: SavedRequest): Promise<void> {
  const parent = await readJson<SessionInfo>(StorageKeys.session(sessionId))
  if (!parent) return
  const child = item.subchat?.scope === 'chat'
    ? await createContinuationRecord({
        sourceId: sessionId,
        title: item.subchat?.title ?? '',
        body: item.subchat?.brief ?? '',
      })
    : await createSubchatRecord({
        parentId: sessionId,
        title: item.subchat?.title ?? '',
        body: item.subchat?.brief ?? '',
        profile: item.subchat?.profile,
        fragmentKind: item.subchat?.fragmentKind,
      })
  if (!child) return
  try {
    const input = await buildInput(sessionId, parent, await t('subchat.kickoff'))
    void runChat(win, {
      ...input,
      sessionId: child.id,
      mode: child.mode,
      directory: child.directory,
      extraDirectories: child.extraDirectories,
    })
      // Same as a subchat opened during the run: its result wakes the parent up.
      .then(() => wakeParentOf(win, input, child))
      .catch((err) => console.error('[subchat] saved subchat turn failed:', err))
  } catch (err) {
    // The chat already exists in the sidebar: it is opened, waiting for the person.
    console.warn('[subchat] saved subchat created without a starting turn:', err)
  }
}

/** Request persisted on disk — the broker only knows the ones still alive. */
async function locate(
  requestId: string,
): Promise<{ key: string; sessionId: string; item: SavedRequest; all: SavedRequest[] } | null> {
  const keys = await listKeys('pendingAsks/')
  for (const key of keys) {
    const all = await readJson<SavedRequest[]>(key)
    const item = all?.find((i) => i.requestId === requestId)
    if (item && all) {
      return { key, sessionId: key.slice('pendingAsks/'.length), item, all }
    }
  }
  return null
}

/** Takes the card off the disk and off every UI (desktop and companions). */
async function closeCard(
  key: string,
  sessionId: string,
  requestId: string,
  all: SavedRequest[],
): Promise<void> {
  const rest = all.filter((i) => i.requestId !== requestId)
  if (rest.length > 0) await writeJson(key, rest)
  else await removeJson(key)
  broadcastChatEvent({ type: 'ask:done', sessionId, requestId })
}

/** The user message an answer to a dead card becomes (null: nothing to tell the agent). Exported for tests. */
export function responseBlock(item: SavedRequest, value: unknown, texts: Texts): string | null {
  // Worker question: the request was made to the orchestrator's chat, and the
  // worker that asked no longer exists — saying whose it was keeps the agent from
  // reading the answers as if they belonged to its own turn.
  const origin = item.origin ? `[worker: ${item.origin.workerTitle}] ` : ''

  // Subchat suggestion: "new chat" never becomes a message (see openSavedSubchat);
  // "here" resumes the conversation asking for the work to be done in it.
  if (item.kind === 'subchat') {
    if (value !== 'here') return null
    // The task travels with the choice: the turn that proposed it is gone, and "do this
    // here" alone left the agent guessing what "this" was.
    const task = [item.subchat?.title, item.subchat?.brief].filter(Boolean).join(' — ')
    return `${origin}${texts.subchatHere}${task ? `\n\n${task}` : ''}`
  }

  if (item.kind === 'permission') {
    // 'deny' does not generate a message: denying a dead request is just clearing the screen.
    if (value !== 'allow' && value !== 'always' && value !== 'always_chat') return null
    return `${origin}${texts.authorize}: ${item.claim?.title ?? ''}`.trim()
  }

  const reply = value as QuestionReply | undefined
  if (reply?.rejected || !Array.isArray(reply?.answers)) return null
  const questions = item.questions ?? []
  if (questions.length === 0) return null
  const lines = questions
    .map((q, i) => formatAskLine(i, q.text, reply.answers?.[i] || texts.noAnswer))
    .join('\n')
  return origin ? `${origin.trim()}\n${lines}` : lines
}

/** Model, mode and permissions of the last turn — resuming cannot swap the
 *  conversation's model for some default. */
async function buildInput(
  sessionId: string,
  session: SessionInfo,
  text: string,
): Promise<SendMessageInput> {
  const messages = (await readJson<ChatMessage[]>(StorageKeys.messages(sessionId))) ?? []
  const lastWithModel = [...messages].reverse().find((m) => m.providerId && m.modelId)
  const lastFromUser = [...messages].reverse().find((m) => m.role === 'user')
  const connected = await listCredentialProviders()
  const language = await readAppLanguage()

  return {
    sessionId,
    text,
    providerId: lastWithModel?.providerId ?? connected[0] ?? 'openai',
    modelId: lastWithModel?.modelId ?? 'gpt-4o',
    mode: session.mode,
    options: { permissionMode: lastFromUser?.permissionMode },
    directory: session.directory,
    extraDirectories: session.extraDirectories,
    ...(language ? { language } : {}),
  }
}

async function dispatch(sessionId: string): Promise<void> {
  const queue = queues.get(sessionId)
  if (!queue) return
  queues.delete(sessionId)
  if (queue.blocks.length === 0) return

  const session = await readJson<SessionInfo>(StorageKeys.session(sessionId))
  if (!session) return

  const text = [await t('resume.header'), '', queue.blocks.join('\n\n'), '', await t('resume.footer')].join('\n')

  const input = await buildInput(sessionId, session, text)
  console.log(`[ask] resuming ${queue.blocks.length} pending answer(s) in session ${sessionId}`)
  void runChat(queue.win, input)
}

/**
 * Answers the live request; if it no longer exists, it resumes through the conversation.
 * Returns false only when there is neither a live request nor a saved card — then the UI
 * discards the card, because nothing is left to answer.
 */
export async function replyOrResume(
  win: BrowserWindow | null,
  requestId: string,
  value: unknown,
): Promise<boolean> {
  if (askReply(requestId, value)) return true

  const saved = await locate(requestId)
  if (!saved) return false

  const { key, sessionId, item, all } = saved
  await closeCard(key, sessionId, requestId, all)

  // The card is already gone; now the choice is actually carried out.
  if (item.kind === 'subchat' && value === 'new') {
    if (win && !win.isDestroyed()) await openSavedSubchat(win, sessionId, item)
    return true
  }

  const block = responseBlock(item, value, await texts())
  // Dismissal/denial: the card is already gone, and there is nothing to tell the agent.
  if (!block || !win || win.isDestroyed()) return true

  const queue = queues.get(sessionId)
  if (queue) {
    queue.blocks.push(block)
    return true
  }
  queues.set(sessionId, {
    win,
    blocks: [block],
    timer: setTimeout(() => void dispatch(sessionId), WINDOW_MS),
  })
  return true
}
