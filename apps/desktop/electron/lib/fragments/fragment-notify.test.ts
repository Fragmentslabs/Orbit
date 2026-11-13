import { beforeEach, describe, expect, it, vi } from 'vitest'

/** orbit.notify: the app keeps the schedule and fires it — given the grant, inside the caps. */

const h = vi.hoisted(() => ({
  sent: [] as Array<{ channel: string; payload: Record<string, unknown> }>,
  manifest: null as null | Record<string, unknown>,
  native: 0,
  /** The overlay is pre-warmed hidden at boot, BEFORE the app window: it comes first. */
  overlayVisible: false,
  mainFocused: true,
  failSend: false,
  /** Whether this system can show native banners at all. */
  supported: true,
  /** macOS refusing the banner (UNErrorDomain 1) — the case a dev Electron build hits. */
  nativeRefused: false,
}))

vi.mock('electron', () => {
  const fakeWindow = (
    bounds: { width: number; height: number },
    visible: () => boolean,
    focused: () => boolean,
  ) => ({
    isDestroyed: () => false,
    isVisible: visible,
    isFocused: focused,
    isMinimized: () => false,
    getBounds: () => ({ x: 0, y: 0, ...bounds }),
    show() {},
    focus() {},
    restore() {},
    webContents: {
      send: (channel: string, payload: Record<string, unknown>) => {
        if (h.failSend) throw new Error('window gone')
        h.sent.push({ channel, payload })
      },
    },
  })

  return {
  app: { getPath: () => `${process.env.TMPDIR || '/tmp'}/orbit-notify-test-${process.pid}` },
  BrowserWindow: {
    getAllWindows: () => [
      fakeWindow({ width: 560, height: 120 }, () => h.overlayVisible, () => false),
      fakeWindow({ width: 1280, height: 800 }, () => true, () => h.mainFocused),
    ],
  },
  Notification: class {
    private handlers: Record<string, (...args: unknown[]) => void> = {}
    static isSupported() {
      return h.supported
    }
    on(event: string, handler: (...args: unknown[]) => void) {
      this.handlers[event] = handler
      return this
    }
    show() {
      h.native++
      if (h.nativeRefused) this.handlers.failed?.(new Error('refused'), 'UNErrorDomain 1')
      else this.handlers.show?.()
    }
  },
  }
})

vi.mock('../sound', () => ({ customSoundAvailable: async () => true, playSound: async () => true }))
vi.mock('../i18n', () => ({ t: async (key: string) => key }))
vi.mock('./fragment-store', () => ({ getFragment: async () => h.manifest }))

import {
  cancelAllFor,
  listNotifications,
  scheduleNotification,
  tickFragmentNotifications,
} from './fragment-notify'

const FRAGMENT = {
  id: 'frag-test-abc123',
  name: 'LeetCode do dia',
  icon: 'code',
  requests: ['notify'],
  grants: ['notify'],
  sessionId: 'session-1',
}

beforeEach(async () => {
  h.sent.length = 0
  h.native = 0
  h.mainFocused = true
  h.overlayVisible = false
  h.failSend = false
  h.supported = true
  h.nativeRefused = false
  h.manifest = FRAGMENT
  // Also clears the fire caps of this fragment.
  await cancelAllFor(FRAGMENT.id)
})

describe('scheduleNotification', () => {
  it('keeps a one-shot with the instant it was given', async () => {
    const at = Date.now() + 60_000
    const saved = await scheduleNotification(FRAGMENT.id, { id: 'a', title: 'Vence hoje', at })
    expect(saved.nextAt).toBe(at)
    expect(await listNotifications(FRAGMENT.id)).toHaveLength(1)
  })

  it('updating the same id replaces instead of stacking', async () => {
    const at = Date.now() + 60_000
    await scheduleNotification(FRAGMENT.id, { id: 'a', title: 'Antigo', at })
    const saved = await scheduleNotification(FRAGMENT.id, { id: 'a', title: 'Novo', at })
    const list = await listNotifications(FRAGMENT.id)
    expect(list).toHaveLength(1)
    expect(saved.title).toBe('Novo')
  })

  it('refuses a cadence below the minimum', async () => {
    await expect(
      scheduleNotification(FRAGMENT.id, { id: 'a', title: 'x', everyMinutes: 0 }),
    ).rejects.toThrow()
  })

  it('refuses an invalid daily time', async () => {
    await expect(
      scheduleNotification(FRAGMENT.id, { id: 'a', title: 'x', dailyAt: '9:00' }),
    ).rejects.toThrow()
  })

  it('refuses a past one-shot', async () => {
    await expect(
      scheduleNotification(FRAGMENT.id, { id: 'a', title: 'x', at: Date.now() - 10_000 }),
    ).rejects.toThrow()
  })
})

describe('tickFragmentNotifications', () => {
  it('fires a due one-shot as a toast and removes it', async () => {
    // A past instant is refused, so the schedule is made now and the tick runs a moment later.
    await scheduleNotification(FRAGMENT.id, { id: 'a', title: 'Vence', at: Date.now() + 1_000 })
    await tickFragmentNotifications(Date.now() + 2_000)

    const toasts = h.sent.filter((entry) => entry.channel === 'fragment:notify')
    expect(toasts.length).toBeGreaterThan(0)
    expect(toasts[0].payload.fragmentId).toBe(FRAGMENT.id)
    expect(await listNotifications(FRAGMENT.id)).toHaveLength(0)
  })

  it('drops a one-shot that came due while the app was closed', async () => {
    const at = Date.now() + 1_000
    await scheduleNotification(FRAGMENT.id, { id: 'a', title: 'Velho', at })
    // Ten minutes later: stale, not a queue.
    await tickFragmentNotifications(at + 10 * 60_000)

    expect(h.sent).toHaveLength(0)
    expect(await listNotifications(FRAGMENT.id)).toHaveLength(0)
  })

  it('draws a toast even with the pre-warmed overlay window ahead of the app window', async () => {
    // Regression: "the first window alive" was the hidden overlay, so the app always thought
    // it was in the background and every notification became a native banner (no toast).
    await scheduleNotification(FRAGMENT.id, { id: 'a', title: 'Vence', at: Date.now() + 1_000 })
    await tickFragmentNotifications(Date.now() + 2_000)

    expect(h.sent.some((entry) => entry.channel === 'fragment:notify')).toBe(true)
    expect(h.native).toBe(0)
  })

  it('raises a native banner instead of a toast when no window is focused', async () => {
    // The person is in another app: a toast would only be seen later, so the banner is the
    // delivery — and it must not double up with a toast.
    h.mainFocused = false
    await scheduleNotification(FRAGMENT.id, { id: 'a', title: 'Volta aqui', at: Date.now() + 1_000 })
    await tickFragmentNotifications(Date.now() + 2_000)

    expect(h.sent.filter((entry) => entry.channel === 'fragment:notify')).toHaveLength(0)
    expect(h.native).toBe(1)
  })

  it('falls back to the toast when the system refuses the banner', async () => {
    // macOS answers UNErrorDomain 1 for an app whose notifications are not allowed (a dev
    // Electron build until it is enabled in System Settings): the reminder must still show.
    h.mainFocused = false
    h.nativeRefused = true
    await scheduleNotification(FRAGMENT.id, { id: 'a', title: 'Vence', at: Date.now() + 1_000 })
    await tickFragmentNotifications(Date.now() + 2_000)

    expect(h.sent.some((entry) => entry.channel === 'fragment:notify')).toBe(true)
    expect(h.native).toBe(1)
  })

  it('falls back to the toast when the system cannot show banners', async () => {
    // Linux without a notification daemon, for instance: better late on screen than only a sound.
    h.mainFocused = false
    h.supported = false
    await scheduleNotification(FRAGMENT.id, { id: 'a', title: 'Vence', at: Date.now() + 1_000 })
    await tickFragmentNotifications(Date.now() + 2_000)

    expect(h.sent.some((entry) => entry.channel === 'fragment:notify')).toBe(true)
    expect(h.native).toBe(0)
  })

  it('realigns the schedule even when delivering the toast fails', async () => {
    await scheduleNotification(FRAGMENT.id, { id: 'r', title: 'Beber água', everyMinutes: 30 })
    h.failSend = true
    await tickFragmentNotifications(Date.now() + 31 * 60_000)
    h.failSend = false

    const list = await listNotifications(FRAGMENT.id)
    expect(list).toHaveLength(1)
    expect(list[0].nextAt).toBeGreaterThan(Date.now())

    // And it must not be due again at the same instant (the sound repeating every tick).
    h.sent.length = 0
    await tickFragmentNotifications(Date.now() + 31 * 60_000)
    expect(h.sent).toHaveLength(0)
  })

  it('keeps a recurring one, realigned to the future', async () => {
    await scheduleNotification(FRAGMENT.id, { id: 'r', title: 'Beber água', everyMinutes: 30 })
    const now = Date.now()
    await tickFragmentNotifications(now + 31 * 60_000)

    const list = await listNotifications(FRAGMENT.id)
    expect(list).toHaveLength(1)
    expect(list[0].nextAt).toBeGreaterThan(now + 31 * 60_000)
    expect(h.sent.some((entry) => entry.channel === 'fragment:notify')).toBe(true)
  })

  it('discards the schedule when the person revokes "notify"', async () => {
    h.manifest = { ...FRAGMENT, grants: [] }
    await scheduleNotification(FRAGMENT.id, { id: 'a', title: 'x', everyMinutes: 30 })
    await tickFragmentNotifications(Date.now() + 31 * 60_000)

    expect(h.sent).toHaveLength(0)
    expect(await listNotifications(FRAGMENT.id)).toHaveLength(0)
  })
})
