import { BrowserWindow, Notification } from 'electron'
import type { AskItem, ChatMessage, MessageErrorKind } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import { lastProseText } from '@shared/chat-text'
import { readJson } from './storage'
import { customSoundAvailable, playSound } from './sound'
import { notifyCompanionMessage } from './companion-server'
import { t, type MainMessageKey } from './i18n'

/**
 * Native desktop notifications.
 *
 * Display criteria (the same for the 3 types):
 * - The main window is NOT focused — with the app in front the user already sees
 *   the permission card / the message on screen; a native banner would be spam.
 * - Profile of the type enabled (persisted via storage:write, under the key
 *   `notification-prefs`, by the renderer — see notification-prefs-store).
 * - Custom sound `notification.wav` when there is a player available (afplay,
 *   SoundPlayer etc.); without a player, it falls back to the system's native sound.
 *
 * Worker pendings (origin) are grouped: one batch = one notification.
 */
export interface NotificationPrefs {
  pendingAsk: boolean
  newMessage: boolean
  chatError: boolean
}

const DEFAULTS: NotificationPrefs = { pendingAsk: true, newMessage: true, chatError: true }

export async function getNotificationPrefs(): Promise<NotificationPrefs> {
  const saved = await readJson<Partial<NotificationPrefs>>('notification-prefs')
  return { ...DEFAULTS, ...saved }
}

/**
 * The window in front — NOT "the first one alive": the overlay window is created hidden at
 * boot, before the main one, so the first would always be the hidden overlay.
 */
function frontWindow(): BrowserWindow | null {
  const alive = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isVisible())
  return alive.find((w) => w.isFocused()) ?? alive[0] ?? null
}

function appVisible(): boolean {
  return BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isVisible() && w.isFocused())
}

/**
 * Preview of the turn's ANSWER — the last prose block of the message, the same
 * rule that the chat bubble and the read-aloud use (see `lastProseText`).
 * Taking the first text part took the narration: in a turn with
 * tools it is the preamble ("I'll implement…"), not the answer the
 * person reads at the end.
 */
function previewOf(message: ChatMessage, max = 140): string {
  const text = lastProseText(message).replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}

async function sessionTitle(sessionId: string): Promise<string> {
  const session = await readJson<{ title?: string }>(StorageKeys.session(sessionId))
  return session?.title?.trim() || sessionId.slice(0, 8)
}

interface NotificationBase {
  title: string
  body: string
  sessionId?: string
}

async function show(kind: keyof NotificationPrefs, n: NotificationBase): Promise<void> {
  if (!Notification.isSupported()) return
  if (appVisible()) return
  const prefs = await getNotificationPrefs()
  if (!prefs[kind]) return

  const win = frontWindow()
  const hasCustomSound = await customSoundAvailable()
  const notification = new Notification({ title: n.title, body: n.body, silent: hasCustomSound })
  if (hasCustomSound) void playSound('notification.wav')
  notification.on('click', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
    if (n.sessionId) {
      win?.webContents.send('chat:event', { type: 'notifications:open', sessionId: n.sessionId })
    }
  })
  notification.show()
}

/** Pending question/permission (a turn's request; worker batch = 1 notice). */
export async function notifyPendingAsk(sessionId: string, item: AskItem): Promise<void> {
  const title = await sessionTitle(sessionId)
  if (item.kind === 'question') {
    const firstQuestion = item.questions?.[0]?.text
    void show('pendingAsk', {
      title: await t('notif.question.title'),
      // The question's text is content (the model/user's language); only the
      // fallback is a fixed sentence.
      body: firstQuestion
        ? `${title}: ${firstQuestion}`
        : await t('notif.question.pendingIn', { session: title }),
      sessionId,
    })
  } else {
    void show('pendingAsk', {
      title: await t('notif.permission.title'),
      body: `${title}: ${item.claim?.title ?? (await t('notif.permission.fallback'))}`,
      sessionId,
    })
  }
}

/** Batch of worker requests — a single notification, with the first claim. */
export async function notifyPendingAskBatch(sessionId: string, items: AskItem[]): Promise<void> {
  if (items.length === 0) return
  const title = await sessionTitle(sessionId)
  const first = items[0]
  const extra =
    items.length > 1 ? ` ${await t('notif.batch.more', { count: items.length - 1 })}` : ''
  const fallback = await t(
    first.kind === 'question' ? 'notif.pending.question' : 'notif.pending.action',
  )
  void show('pendingAsk', {
    title: await t('notif.permission.title'),
    body:
      first.kind === 'question'
        ? `${title}: ${first.questions?.[0]?.text ?? fallback}${extra}`
        : `${title}: ${first.claim?.title ?? fallback}${extra}`,
    sessionId,
  })
}

/** New assistant message completed in an inactive session (window out of focus). */
export async function notifyNewMessage(sessionId: string, message: ChatMessage): Promise<void> {
  const preview = previewOf(message)
  if (!preview) return
  const title = await sessionTitle(sessionId)
  void show('newMessage', {
    title,
    body: preview,
    sessionId,
  })
  // Companions (mobile) are also notified — the mobile's prefs decide whether they
  // display it; the channel is local, independent of the desktop's prefs.
  notifyCompanionMessage(sessionId, title, preview)
}

/** Short reason per failure type, for the banner's body. */
const CHAT_ERROR_KEYS: Record<Exclude<MessageErrorKind, 'unknown'>, MainMessageKey> = {
  moderation: 'notif.chatError.kind.moderation',
  'model-unavailable': 'notif.chatError.kind.model-unavailable',
  'rate-limit': 'notif.chatError.kind.rate-limit',
  network: 'notif.chatError.kind.network',
  'context-length': 'notif.chatError.kind.context-length',
  'context-length-turn': 'notif.chatError.kind.context-length-turn',
  'provider-config': 'notif.chatError.kind.provider-config',
  'tool-limit': 'notif.chatError.kind.tool-limit',
}

/** Chat error (provider failure, not a manual abort). */
export async function notifyChatError(
  sessionId: string,
  error: string,
  kind?: MessageErrorKind,
): Promise<void> {
  const title = await sessionTitle(sessionId)
  // Classified failure → translated reason (and short, which is what fits in a
  // banner); the raw text stays in the error card inside the app. Only `unknown`
  // falls into the raw text, for lack of an explanation of its own.
  const reason =
    kind && kind !== 'unknown'
      ? await t(CHAT_ERROR_KEYS[kind])
      : error.slice(0, 200) || (await t('notif.chatError.unexpected'))
  void show('chatError', {
    title: await t('notif.chatError.title'),
    body: `${title}: ${reason}`,
    sessionId,
  })
}