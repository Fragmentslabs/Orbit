import { BrowserWindow, Notification } from 'electron'
import {
  FRAGMENT_DAILY_AT_PATTERN,
  FRAGMENT_MAX_NOTIFICATIONS,
  FRAGMENT_NOTIFY_ID_PATTERN,
  FRAGMENT_NOTIFY_MAX_BODY,
  FRAGMENT_NOTIFY_MAX_TITLE,
  FRAGMENT_NOTIFY_MIN_MINUTES,
  type FragmentManifest,
  type FragmentNotification,
  type FragmentNotifyEvent,
} from '@shared/fragments'
import { readJson, writeJson } from '../storage'
import { customSoundAvailable, playSound } from '../sound'
import { t } from '../i18n'
import { getFragment } from './fragment-store'

/**
 * Notifications scheduled by fragments — the piece that makes a widget able to remind the
 * person of something with the fragment closed.
 *
 * The schedule lives HERE, not in the page: the page says "wake me at 18:00 with this text"
 * and the app keeps it. A page only exists while its frame is mounted; a reminder cannot
 * depend on that.
 *
 * The hard limit is the same the person chose for the feature: it only fires with ORBIT
 * OPEN. With the process gone nothing runs — a reminder that must survive that is a routine.
 *
 * What came due while the app was closed is stale, not a queue: anything more than
 * LATE_GRACE_MS late is dropped instead of fired in a burst when the window opens.
 */
const STORAGE_KEY = 'fragment-notifications'
const TICK_MS = 20_000
const LATE_GRACE_MS = 5 * 60_000
/** Caps so a page in a loop cannot turn the app into a metronome. */
const MAX_PER_MINUTE = 6
const MAX_PER_HOUR = 30

type Stored = Record<string, FragmentNotification[]>

let cache: Stored | null = null
let timer: NodeJS.Timeout | null = null
let wakeTimer: NodeJS.Timeout | null = null
/** fragmentId → epochs of the notifications it fired (for the caps above). */
const fired: Record<string, number[]> = {}

/**
 * The app window — NOT "the first one alive": the overlay window is created hidden at boot,
 * before the main one, so taking the first would always report the app as being in the
 * background (and every toast would go out as a native banner).
 *
 * Deliberately ignores visibility: on macOS closing the window keeps the app running, and a
 * banner clicked in that state has to reopen it (show() brings a hidden window back).
 */
function frontWindow(): BrowserWindow | null {
  // The overlay is a small bar over everything: the app window is the big one.
  const area = (win: BrowserWindow) => {
    const { width, height } = win.getBounds()
    return width * height
  }
  return (
    BrowserWindow.getAllWindows()
      .filter((w) => !w.isDestroyed())
      .sort((a, b) => area(b) - area(a))[0] ?? null
  )
}

/** Some Orbit window is visible and focused: a toast is enough (a banner would be spam). */
function appVisible(): boolean {
  return BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isVisible() && w.isFocused())
}

async function readAll(): Promise<Stored> {
  cache ??= (await readJson<Stored>(STORAGE_KEY)) ?? {}
  return cache
}

async function writeAll(next: Stored): Promise<void> {
  cache = next
  await writeJson(STORAGE_KEY, next)
}

/** When a `dailyAt` next happens, from `now`. Today if the time has not passed yet. */
function nextDaily(dailyAt: string, now: number): number {
  const [h, m] = dailyAt.split(':').map(Number)
  const next = new Date(now)
  next.setHours(h, m, 0, 0)
  if (next.getTime() <= now) next.setDate(next.getDate() + 1)
  return next.getTime()
}

function cleanTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, FRAGMENT_NOTIFY_MAX_TITLE) : null
}

function cleanBody(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, FRAGMENT_NOTIFY_MAX_BODY)
}

/** Everything one fragment has scheduled, soonest first. */
export async function listNotifications(fragmentId: string): Promise<FragmentNotification[]> {
  const all = await readAll()
  return [...(all[fragmentId] ?? [])].sort((a, b) => a.nextAt - b.nextAt)
}

/**
 * Creates or updates a schedule. The `id` is the identity: calling again with the same id
 * (on every mount, say) updates the text and keeps the cadence instead of stacking copies.
 */
export async function scheduleNotification(
  fragmentId: string,
  params: Record<string, unknown>,
): Promise<FragmentNotification> {
  const id = typeof params.id === 'string' ? params.id : ''
  if (!FRAGMENT_NOTIFY_ID_PATTERN.test(id)) {
    throw new Error('notify.schedule needs { id } — 1-64 letters, digits, "-" or "_"')
  }
  const title = cleanTitle(params.title)
  if (!title) throw new Error('notify.schedule needs { title: string }')
  const body = cleanBody(params.body)

  const now = Date.now()
  const hasDaily = typeof params.dailyAt === 'string'
  const hasEvery = params.everyMinutes !== undefined
  const hasAt = params.at !== undefined
  const kinds = Number(hasDaily) + Number(hasEvery) + Number(hasAt)
  if (kinds !== 1) {
    throw new Error('notify.schedule needs exactly one of { at } (epoch ms), { dailyAt } ("HH:MM") or { everyMinutes }')
  }

  const all = await readAll()
  const list = all[fragmentId] ?? []
  const existing = list.find((n) => n.id === id)
  if (!existing && list.length >= FRAGMENT_MAX_NOTIFICATIONS) {
    throw new Error(`this fragment already has ${FRAGMENT_MAX_NOTIFICATIONS} notifications scheduled`)
  }

  let nextAt: number
  const entry: FragmentNotification = {
    id,
    title,
    body,
    nextAt: 0,
    createdAt: existing?.createdAt ?? now,
  }
  if (hasAt) {
    const at = Number(params.at)
    if (!Number.isFinite(at)) throw new Error('{ at } must be epoch milliseconds')
    if (at < now - 1000) throw new Error('{ at } is in the past')
    if (at > now + 366 * 24 * 60 * 60_000) throw new Error('{ at } is more than a year away')
    entry.at = Math.round(at)
    // Re-scheduling the same instant keeps idempotency; a new instant replaces it.
    nextAt = entry.at
  } else if (hasDaily) {
    const dailyAt = String(params.dailyAt)
    if (!FRAGMENT_DAILY_AT_PATTERN.test(dailyAt)) throw new Error('{ dailyAt } must be "HH:MM"')
    entry.dailyAt = dailyAt
    // Already scheduled for a future time: keep it (a page that re-mounts must not reset the clock).
    nextAt = existing?.dailyAt === dailyAt && existing.nextAt > now ? existing.nextAt : nextDaily(dailyAt, now)
  } else {
    const every = Math.round(Number(params.everyMinutes))
    if (!Number.isFinite(every) || every < FRAGMENT_NOTIFY_MIN_MINUTES) {
      throw new Error(`{ everyMinutes } must be at least ${FRAGMENT_NOTIFY_MIN_MINUTES}`)
    }
    entry.everyMinutes = every
    nextAt = existing?.everyMinutes === every && existing.nextAt > now ? existing.nextAt : now + every * 60_000
  }
  entry.nextAt = nextAt

  const next = list.filter((n) => n.id !== id)
  next.push(entry)
  await writeAll({ ...all, [fragmentId]: next })
  // The new time may be sooner than whatever the wake-up was armed for.
  void armWake()
  return entry
}

/** Cancels one schedule by id, or every one of the fragment. Returns how many went away. */
export async function cancelNotification(fragmentId: string, id?: string): Promise<number> {
  const all = await readAll()
  const list = all[fragmentId] ?? []
  const next = id ? list.filter((n) => n.id !== id) : []
  const removed = list.length - next.length
  if (removed === 0) return 0
  if (next.length === 0) {
    const copy = { ...all }
    delete copy[fragmentId]
    await writeAll(copy)
  } else {
    await writeAll({ ...all, [fragmentId]: next })
  }
  void armWake()
  return removed
}

/** The fragment went away, or lost the grant: its schedules go with it. */
export async function cancelAllFor(fragmentId: string): Promise<void> {
  await cancelNotification(fragmentId)
  delete fired[fragmentId]
}

function withinCaps(fragmentId: string, now: number): boolean {
  const stamps = (fired[fragmentId] ?? []).filter((at) => now - at < 60 * 60_000)
  const lastMinute = stamps.filter((at) => now - at < 60_000).length
  fired[fragmentId] = stamps
  return lastMinute < MAX_PER_MINUTE && stamps.length < MAX_PER_HOUR
}

/** Banners Electron already handed to the system and still on screen (a GC'd one never shows). */
const liveBanners = new Set<Notification>()

/**
 * Returns false when this system cannot show a banner — either there is no daemon at all, or
 * the OS refused it. macOS answers UNErrorDomain 1 when notifications are not allowed for the
 * app, which is what a dev Electron build hits until it is allowed in System Settings.
 */
async function showNative(manifest: FragmentManifest, notification: FragmentNotification): Promise<boolean> {
  if (!Notification.isSupported()) return false
  const prefix = await t('notif.fragment.title')
  const hasCustomSound = await customSoundAvailable()
  const banner = new Notification({
    title: `${prefix} · ${manifest.name}`,
    body: notification.body ? `${notification.title} — ${notification.body}` : notification.title,
    silent: hasCustomSound,
  })
  liveBanners.add(banner)
  banner.on('click', () => {
    const win = frontWindow()
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send('fragment:open', {
      id: manifest.id,
      title: manifest.name,
      sessionId: manifest.sessionId,
    })
  })
  // A refusal is silent unless we listen: the banner never appears and the person hears only
  // the sound. The caller falls back to the in-app toast when this resolves false.
  const delivered = await new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    banner.on('show', () => finish(true))
    banner.on('failed', (_event, error) => {
      console.error('[fragment-notify] the system refused the banner:', error)
      finish(false)
    })
    try {
      banner.show()
    } catch (error) {
      console.error('[fragment-notify] could not raise the banner:', error)
      finish(false)
    }
    // Some builds emit neither event: assume it went out instead of falling back on a guess.
    setTimeout(() => finish(true), 1200).unref?.()
  })
  setTimeout(() => liveBanners.delete(banner), 15_000).unref?.()
  return delivered
}

/** Every window gets it; the overlay page has no such listener and simply ignores it. */
function sendToast(event: FragmentNotifyEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('fragment:notify', event)
  }
}

/** Turns one due schedule into a toast (window in front) or a native banner (it is not). */
async function fire(manifest: FragmentManifest, notification: FragmentNotification): Promise<void> {
  const now = Date.now()
  if (!withinCaps(manifest.id, now)) return
  fired[manifest.id] = [...(fired[manifest.id] ?? []), now]

  const event: FragmentNotifyEvent = {
    fragmentId: manifest.id,
    fragmentName: manifest.name,
    icon: manifest.icon,
    title: notification.title,
    body: notification.body,
    at: now,
  }

  if (appVisible()) {
    sendToast(event)
  } else if (!(await showNative(manifest, notification))) {
    // This system has no banners at all: a toast waiting for the person beats only a sound.
    sendToast(event)
  }
  // The app's notification sound, the same one a new message uses.
  if (await customSoundAvailable()) void playSound('notification.wav').catch(() => undefined)
}

/** An immediate notification (`notify.show`), through the same caps and the same sound. */
export async function showNotificationNow(
  manifest: FragmentManifest,
  title: string,
  body: string,
): Promise<void> {
  await fire(manifest, {
    id: 'immediate',
    title: title.slice(0, FRAGMENT_NOTIFY_MAX_TITLE),
    body: body.slice(0, FRAGMENT_NOTIFY_MAX_BODY),
    nextAt: Date.now(),
    createdAt: Date.now(),
  })
}

/** Advances a schedule past `now` and says whether it should fire at this tick. */
function advance(notification: FragmentNotification, now: number): boolean {
  if (notification.dailyAt) {
    notification.nextAt = nextDaily(notification.dailyAt, now)
    return true
  }
  if (notification.everyMinutes) {
    const step = notification.everyMinutes * 60_000
    // Behind by whole intervals (the app was closed): realign in one jump, no burst.
    const missed = Math.floor((now - notification.nextAt) / step) + 1
    notification.nextAt += Math.max(1, missed) * step
    return true
  }
  return false // one-shot: fired, then removed
}

/** One pass over the schedule. Exported for the test. */
export async function tickFragmentNotifications(now = Date.now()): Promise<void> {
  const all = await readAll()
  const ids = Object.keys(all)
  if (ids.length === 0) return
  const next: Stored = { ...all }

  for (const fragmentId of ids) {
    const list = all[fragmentId] ?? []
    const keep: FragmentNotification[] = []
    let manifest: FragmentManifest | null = null
    let looked = false

    for (const notification of list) {
      if (notification.nextAt > now) {
        keep.push(notification)
        continue
      }
      if (!looked) {
        manifest = await getFragment(fragmentId)
        looked = true
      }
      // Deleted, or the person revoked it: the schedule dies with the permission.
      if (!manifest || !manifest.grants.includes('notify')) continue
      // Stale one-shot (the app was closed at the time): drop it instead of firing late.
      if (notification.at && now - notification.nextAt > LATE_GRACE_MS) continue
      // Advance FIRST: a failure drawing the toast must not leave the schedule due, or every
      // tick would fire it again (the sound playing every 20s).
      const repeats = advance(notification, now)
      if (repeats) keep.push(notification)
      try {
        await fire(manifest, notification)
      } catch (err) {
        console.error('[fragment-notify] could not deliver a notification', err)
      }
    }

    if (keep.length === 0) delete next[fragmentId]
    else next[fragmentId] = keep
  }

  if (JSON.stringify(next) !== JSON.stringify(all)) await writeAll(next)
  void armWake()
}

/**
 * Arms a single wake-up for the soonest schedule. The interval below is only the safety net:
 * without this a notification set for 18:00 would wait for the next tick and leave at 18:00:19.
 */
async function armWake(): Promise<void> {
  if (!timer) return
  if (wakeTimer) {
    clearTimeout(wakeTimer)
    wakeTimer = null
  }
  let all: Stored
  try {
    all = await readAll()
  } catch {
    return
  }
  let soonest = Infinity
  for (const list of Object.values(all)) {
    for (const notification of list) soonest = Math.min(soonest, notification.nextAt)
  }
  if (!Number.isFinite(soonest)) return
  const delay = Math.max(250, Math.min(soonest - Date.now(), 30_000))
  wakeTimer = setTimeout(() => void tickFragmentNotifications().catch(() => undefined), delay)
  wakeTimer.unref?.()
}

/** Starts the ticker (idempotent). Runs once on start, then every TICK_MS. */
export function startFragmentNotifications(): void {
  if (timer) return
  timer = setInterval(() => void tickFragmentNotifications().catch(() => undefined), TICK_MS)
  // A background timer must not keep the process alive on quit.
  timer.unref?.()
  void tickFragmentNotifications().catch(() => undefined)
}

export function stopFragmentNotifications(): void {
  if (timer) clearInterval(timer)
  if (wakeTimer) clearTimeout(wakeTimer)
  timer = null
  wakeTimer = null
}
