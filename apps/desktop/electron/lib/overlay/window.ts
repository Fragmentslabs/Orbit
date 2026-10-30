import { app, BrowserWindow, globalShortcut, screen, type WebContents } from 'electron'
import { floatAboveFullScreen } from '../float-above-fullscreen'
import {
  OVERLAY_SHORTCUT,
  type OverlayContext,
  type OverlayEvent,
  type OverlaySettings,
} from '@shared/overlay'
import { getAppSettings, onAppSettingsChange } from '../app-settings'
import { getComputerDriver, isComputerAvailable } from '../computer'
import { overlayOpenContext, setOverlayOpenContext } from './open-context'
import { frontmostForeignWindow, readSelectedText } from './selection'

/**
 * The overlay window (⇧⌘space): it comes down at the bottom of the screen, on top of
 * everything, with the persona, the question field and the short answer.
 *
 * Decisions worth recording:
 *  - it is a WINDOW OF ITS OWN, not the main one: the main one is born maximized and
 *    showing/hiding it would cost the flash of a whole window. This one is
 *    transparent, frameless, and stays pre-warmed and hidden;
 *  - in call mode it does NOT steal the focus (`showInactive`): the person stays in
 *    their app, talking — and that app's selection stays readable through AX;
 *  - the selection is read BEFORE showing (in text mode the focus moves here, and
 *    after that the app in the foreground is already Orbit).
 */

export interface OverlayHost {
  /** Preload shared with the app windows. */
  preload: string
  /** Loads the overlay renderer (dev server or file). */
  load: (win: BrowserWindow) => void
}

export const OVERLAY_WIDTH = 660
const MARGIN_BOTTOM = 18
/**
 * Floor for the height: the CLOSED card (~58 pt: persona + field) plus the 8 pt gap
 * above and below. It is a floor, not a size — below this the card is cut by the
 * window and the rounded top corners become a straight line.
 */
const MIN_HEIGHT = 74
const MAX_HEIGHT = 520
/** Time of the "bye" before the window goes away (the final speech still plays). */
const FAREWELL_MS = 1200

let win: BrowserWindow | null = null
let host: OverlayHost | null = null
let loading: Promise<BrowserWindow> | null = null
let height = MIN_HEIGHT
/**
 * Has the renderer ever reported the real height of the card? Before that only the
 * floor exists; after it, the last measurement is worth more than the floor —
 * shrinking the window on every opening cut the card until the next report.
 */
let measured = false
let shortcutError: string | null = null
/** Monitor chosen at the opening: the panel does not jump screens if the cursor leaves. */
let anchorDisplay: ReturnType<typeof screen.getDisplayNearestPoint> | null = null
/**
 * The renderer has announced that it mounted and already listens to `overlay:open`.
 * Without this handshake, the first ⇧⌘space right after boot could send the context to
 * a page that was still mounting — and the panel opened empty, without the selection.
 */
let rendererReady = false
let resolveReady: (() => void) | null = null
const readyPromise = new Promise<void>((resolve) => {
  resolveReady = resolve
})
/** `before-quit`: that is when the window's close can really close. */
let disposing = false

export function markOverlayReady(): void {
  rendererReady = true
  resolveReady?.()
}

/** Called in before-quit: without this the panel's `close` would block the exit. */
export function disposeOverlay(): void {
  disposing = true
  const target = getOverlayWindow()
  if (target && !target.isDestroyed()) target.destroy()
}
/**
 * Selection read at the OPENING of the panel. In text mode the focus moves here, and
 * apps that do not expose AXSelectedText can no longer be copied (Cmd+C would go to
 * Orbit) — this is the only path for their "translate this".
 */
let lastSelection: { text: string; app: string | null; at: number } | null = null

export function lastOverlaySelection(): { text: string; app: string | null; at: number } | null {
  return lastSelection
}

/** Notes the app and the front window at the opening (see open-context.ts). */
async function captureOpenContext(): Promise<void> {
  const front = await frontmostForeignWindow().catch(() => null)
  setOverlayOpenContext(
    front
      ? { app: front.app.name, bundleId: front.app.bundleId, pid: front.app.pid, windowTitle: front.window?.title ?? null, at: Date.now() }
      : null,
  )
}

export function setupOverlay(next: OverlayHost): void {
  host = next
}

export function getOverlayWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null
}

function overlaySettings(): OverlaySettings {
  return getAppSettings().overlay
}

/** Monitor where the cursor is: that is the one the person wants the panel on. */
function targetDisplay() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
}

/** Keeps the bottom edge anchored: growing upwards cannot push the panel off screen. */
function place(nextHeight: number): void {
  const target = getOverlayWindow()
  if (!target) return
  const area = (anchorDisplay ?? targetDisplay()).workArea
  height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(nextHeight)))
  target.setBounds({
    x: Math.round(area.x + (area.width - OVERLAY_WIDTH) / 2),
    y: Math.round(area.y + area.height - height - MARGIN_BOTTOM),
    width: OVERLAY_WIDTH,
    height,
  })
}

function createWindow(): Promise<BrowserWindow> {
  const existing = getOverlayWindow()
  if (existing) return Promise.resolve(existing)
  if (loading) return loading
  if (!host) return Promise.reject(new Error('setupOverlay() was not called'))

  const created = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: MIN_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // NO `vibrancy`/`backgroundMaterial`: the native material paints the
    // ENTIRE RECTANGLE of the window, and the panel (with a margin for the shadow and a
    // variable height) appeared with a second glass card behind it. There is
    // only one card, drawn in CSS, and the transparency is its alpha.
    webPreferences: {
      preload: host.preload,
      backgroundThrottling: false,
    },
  })
  win = created

  created.setAlwaysOnTop(true, 'floating')
  floatAboveFullScreen(created)
  created.setMenuBarVisibility(false)
  // The person sees the panel; the screenshot does not. It is what lets `see_screen`
  // take the print with the panel in front WITHOUT hiding the window — before, it
  // disappeared for an instant on every print. Side effect (a good one, in most
  // cases): the panel also stays out of manual screenshots and of screen
  // sharing on Zoom/Meet.
  created.setContentProtection(true)
  created.on('closed', () => {
    if (win === created) win = null
    loading = null
  })
  // The panel is not a work window: closing it (Cmd+W) only hides — except
  // when the app exits, when the window has to die with it.
  created.on('close', (event) => {
    if (disposing || created.isDestroyed()) return
    event.preventDefault()
    hideOverlay()
  })
  created.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[overlay] renderer process exited: ${details.reason}`)
  })

  loading = new Promise<BrowserWindow>((resolve) => {
    created.webContents.once('did-finish-load', () => resolve(created))
    host!.load(created)
    // If the page never finishes loading, the promise cannot hold the
    // shortcut forever.
    setTimeout(() => resolve(created), 4000)
  })
  place(MIN_HEIGHT)
  return loading
}

/** Creates the hidden window at boot: the first ⇧⌘space must be instant. */
export function prewarmOverlay(): void {
  if (!overlaySettings().enabled) return
  void createWindow().catch(() => undefined)
}

/** Is the voice ready for the overlay to open talking? (TTS and dictation on) */
function callReady(): boolean {
  const voice = getAppSettings().voice
  return voice.tts.enabled && voice.stt.enabled
}

export async function openOverlay(options?: { call?: boolean }): Promise<void> {
  const target = await createWindow().catch(() => null)
  if (!target || target.isDestroyed()) return
  // First opening: wait for the renderer to mount (it announces it via overlay:ready).
  if (!rendererReady) {
    await Promise.race([readyPromise, new Promise((resolve) => setTimeout(resolve, 1500))])
  }

  anchorDisplay = targetDisplay()
  orbitWasActive = BrowserWindow.getAllWindows().some((other) => other !== target && !other.isDestroyed() && other.isFocused())
  const settings = overlaySettings()
  const call = options?.call ?? (settings.openInCall && callReady())

  const context: OverlayContext = {
    call,
    // The selection arrives in a second event: reading it here would cost two `osascript`
    // (~200-400 ms) in front of a shortcut that has to be instant.
    selection: null,
    selectionApp: null,
    settings,
    at: Date.now(),
  }

  // Re-anchors on the cursor monitor WITHOUT shrinking to the floor: a window smaller
  // than the card cuts its top and the top corners come out straight. After the first
  // measurement the last height applies; the renderer reports the exact one as soon as
  // it opens and the extra gap stays transparent (the window has no background).
  place(measured ? height : MIN_HEIGHT)
  if (!target.isVisible()) {
    if (call) target.showInactive()
    else {
      target.show()
      target.focus()
    }
  }
  target.setAlwaysOnTop(true, 'floating')
  target.webContents.send('overlay:open', context)

  // In parallel with the selection and out of the shortcut's path: the panel is already open.
  void captureOpenContext().catch(() => undefined)
  void readSelectedText()
    .catch(() => null)
    .then((selection) => {
      lastSelection = selection ? { text: selection.text, app: selection.app, at: Date.now() } : null
      const current = getOverlayWindow()
      if (!current || !current.isVisible()) return
      current.webContents.send('overlay:event', {
        type: 'selection',
        text: selection?.text ?? null,
        app: selection?.app ?? null,
      } satisfies OverlayEvent)
    })
}

/**
 * Was an Orbit window in use when the panel opened? If so, that is where the focus
 * returns on close; if not, the person was in another app.
 */
let orbitWasActive = false

/**
 * Closing the panel cannot let macOS choose who activates: when hiding the window
 * that has the focus, it brings Orbit's main one to the front and only then the
 * person goes back to the previous app — a flash. That is why the focus is given
 * back to the app the person was in BEFORE the panel goes away.
 */
async function giveFocusBack(closing: BrowserWindow): Promise<void> {
  if (process.platform !== 'darwin' || orbitWasActive) return
  const front = overlayOpenContext()
  if (front && isComputerAvailable()) {
    await getComputerDriver().act({ op: 'activate', pid: front.pid }).catch(() => undefined)
    return
  }
  // Without knowing where the person was: if only the panel was visible, hiding the
  // app gives the focus back to the previous one; with the main window visible, it leaves it.
  const othersVisible = BrowserWindow.getAllWindows().some((other) => other !== closing && !other.isDestroyed() && other.isVisible())
  if (!othersVisible) app.hide()
}

export function hideOverlay(): void {
  const target = getOverlayWindow()
  if (!target) return
  const hadFocus = target.isFocused()
  target.webContents.send('overlay:event', { type: 'hangup', reason: 'dismissed' } satisfies OverlayEvent)
  if (!hadFocus) {
    target.hide()
    return
  }
  void giveFocusBack(target).finally(() => {
    if (!target.isDestroyed()) target.hide()
  })
}

export function toggleOverlay(options?: { call?: boolean }): void {
  const target = getOverlayWindow()
  if (target?.isVisible()) hideOverlay()
  else void openOverlay(options)
}

/** The renderer measures the content and asks for the height; the window follows. */
export function resizeOverlay(nextHeight: number): void {
  if (!getOverlayWindow()) return
  measured = true
  place(nextHeight)
}

/** Chat events reach the overlay too — it may be the one that asked the question. */
export function forwardToOverlay(channel: string, payload: unknown): void {
  const target = getOverlayWindow()
  if (!target) return
  const contents: WebContents = target.webContents
  if (!contents.isDestroyed()) contents.send(channel, payload)
}

/**
 * The `end_call` tool is valid anywhere a spoken conversation exists: in the overlay
 * (which goes away) and in call mode of the main window (which goes back to text).
 * One event, every renderer listens to it.
 */
export function endCallEverywhere(reason?: string): void {
  for (const other of BrowserWindow.getAllWindows()) {
    if (!other.isDestroyed()) other.webContents.send('voice:hangup', reason ?? null)
  }
  endOverlayCall(reason)
}

/**
 * The agent ended the conversation ("it was nothing, bye Orbit"): it turns off the
 * listening and makes the panel go away. The delay lets the goodbye be spoken.
 */
export function endOverlayCall(reason?: string): void {
  const target = getOverlayWindow()
  if (!target) return
  target.webContents.send('overlay:event', { type: 'hangup', reason } satisfies OverlayEvent)
  setTimeout(() => {
    const current = getOverlayWindow()
    if (current?.isVisible()) current.hide()
  }, FAREWELL_MS)
}

/** Registers the global shortcut according to the preferences. Returns the conflict, if any. */
export function syncOverlayShortcut(): { ok: boolean; error?: string } {
  globalShortcut.unregister(OVERLAY_SHORTCUT)
  shortcutError = null
  if (!overlaySettings().enabled) return { ok: true }
  try {
    const registered = globalShortcut.register(OVERLAY_SHORTCUT, () => toggleOverlay())
    if (!registered) shortcutError = 'inUse'
    return registered ? { ok: true } : { ok: false, error: 'inUse' }
  } catch (err) {
    shortcutError = err instanceof Error ? err.message : String(err)
    return { ok: false, error: shortcutError }
  }
}

export function overlayShortcutStatus(): { shortcut: string; ok: boolean; error?: string } {
  const enabled = overlaySettings().enabled
  return {
    shortcut: OVERLAY_SHORTCUT,
    ok: !enabled || (!shortcutError && globalShortcut.isRegistered(OVERLAY_SHORTCUT)),
    error: shortcutError ?? undefined,
  }
}

/** Preferences changing with the panel open: shortcut, opacity and persona live. */
export function watchOverlaySettings(): void {
  onAppSettingsChange((next, prev) => {
    if (next.overlay.enabled !== prev.overlay.enabled) syncOverlayShortcut()
    if (!getOverlayWindow()) return
    // Any change in the block counts, including the MODEL: the window is
    // pre-warmed and does not reload on every opening, so without this relay it
    // would keep the model chosen at boot.
    if (JSON.stringify(next.overlay) !== JSON.stringify(prev.overlay)) {
      forwardToOverlay('overlay:event', { type: 'settings', settings: next.overlay } satisfies OverlayEvent)
    }
  })
}
