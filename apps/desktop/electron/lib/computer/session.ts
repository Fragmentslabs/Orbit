import { BrowserWindow, globalShortcut, screen } from 'electron'
import { floatAboveFullScreen } from '../float-above-fullscreen'
import { computerStopShortcut, type ComputerActivity, type ComputerEvent } from '@shared/computer'
import { getAppSettings } from '../app-settings'
import { tNow } from '../i18n'
import { disposeComputerPanels, setComputerPanelsSession } from './panels'
import { finishOrphanRecording, disposeRecordings } from './recording'
import { forgetShots } from './shots'
import { ComputerError } from './types'

/**
 * Live state of the computer control: who is controlling what, the always-visible
 * indicator, the panic shortcut and the giving back of the accessibility flags turned
 * on in the apps. All of this is born with the first action and dies with the end of
 * the turn (or Stop) — the global shortcut does not stay hooked for nothing.
 */

/**
 * Safety net: with no action for this long, the control is considered finished even
 * without the end of the turn. It is not the normal ending — that is the end of the
 * turn (chat-engine) or Stop. At 20 s, the agent thinking between one action and the
 * next lost the band and the panic shortcut in the middle of the turn, and ⌘⇧. stopped
 * nothing (reported in the test on the app).
 */
const IDLE_MS = 5 * 60_000
/**
 * macOS: ⌘⇧. is the one announced in the band; ⌘⇧Esc is the reserve, for whoever looks
 * for "Esc". Windows: Ctrl+Shift+. only — Ctrl+Shift+Esc opens Task Manager (the
 * system does not let it be registered) and Win+. is the emoji panel, so the shortcut
 * does not collide with any system one.
 */
export const PANIC_SHORTCUTS = process.platform === 'win32' ? ['Control+Shift+.'] : ['CommandOrControl+Shift+.', 'CommandOrControl+Shift+Escape']

interface Live {
  activity: ComputerActivity
  timer: NodeJS.Timeout
}

const live = new Map<string, Live>()
/** pid → sessions that turned the accessibility flag on in it */
const enhanced = new Map<number, Set<string>>()

let overlay: BrowserWindow | null = null
let overlayText: string | null = null
let shortcutOn = false
let stopHandler: ((sessionId: string) => void) | null = null
let restoreHandler: ((pids: number[]) => Promise<void>) | null = null

/** Who stops the turn (abortSession) — injected by the main process to avoid an import cycle. */
export function setComputerStopHandler(handler: (sessionId: string) => void): void {
  stopHandler = handler
}

export function setComputerRestoreHandler(handler: (pids: number[]) => Promise<void>): void {
  restoreHandler = handler
}

// It also goes to the panels window (it shows the app being controlled).
function broadcast(event: ComputerEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win !== overlay && !win.isDestroyed()) win.webContents.send('computer:event', event)
  }
}

/** The conversation thumbnail changed (new screenshot or action target). */
export function noteShotChanged(sessionId: string): void {
  broadcast({ type: 'shot', sessionId, at: Date.now() })
}

export function getComputerActivity(): ComputerActivity[] {
  return [...live.values()].map((l) => l.activity)
}

/** Does the app already have the accessibility flag on (by any session)? */
export function isEnhanced(pid: number): boolean {
  return enhanced.has(pid)
}

export function noteEnhanced(sessionId: string, pid: number): void {
  const set = enhanced.get(pid) ?? new Set<string>()
  set.add(sessionId)
  enhanced.set(pid, set)
}

/**
 * Conversations of the shortcut panel (⇧⌘space). Whoever started the control owns the
 * interface: controlling through it, the panel itself shows the status, the thumbnail
 * and the approvals — the floating edge panels (made for the main window chat) would
 * sit on top of it telling the same thing.
 */
const overlaySessions = new Set<string>()

export function markOverlaySession(sessionId: string): void {
  overlaySessions.add(sessionId)
}

/**
 * One conversation controls at a time. Two acting together — the chat on one task and
 * the shortcut on another — clicked on top of each other, and each read the other's
 * change as the result of its own action. The second one gets a clear error and
 * decides with the person (wait or stop the other); the first one does not even find
 * out.
 */
export function assertCanControl(sessionId: string): void {
  for (const [id, other] of live) {
    if (id === sessionId) continue
    const where = overlaySessions.has(id) ? ' from the shortcut panel' : ''
    throw new ComputerError(
      'busy',
      `Another Orbit conversation is controlling the computer right now${where} (in ${other.activity.app}). Only one conversation controls it at a time.`,
    )
  }
}

/** Records activity: turns on the indicator and the shortcut on the first one, renews the deadline on the following ones. */
export function noteActivity(sessionId: string, app: string, action: string | null): void {
  const now = Date.now()
  const current = live.get(sessionId)
  if (current) clearTimeout(current.timer)
  const activity: ComputerActivity = {
    sessionId,
    app,
    startedAt: current?.activity.startedAt ?? now,
    lastAt: now,
    lastAction: action ?? current?.activity.lastAction ?? null,
  }
  live.set(sessionId, { activity, timer: setTimeout(() => endActivity(sessionId), IDLE_MS) })
  ensureShortcut()
  showOverlay()
  if (!overlaySessions.has(sessionId)) setComputerPanelsSession(sessionId)
  broadcast({ type: 'active', activity })
}

/**
 * Gives back the accessibility flags this session turned on in the apps — without
 * ending the control. The window reading by the shortcut turns on the tree of a
 * Chromium/Electron app only for the duration of the reading, and there is no activity
 * to close it.
 */
export function releaseEnhanced(sessionId: string): void {
  const pids: number[] = []
  for (const [pid, sessions] of enhanced) {
    sessions.delete(sessionId)
    if (sessions.size === 0) {
      enhanced.delete(pid)
      pids.push(pid)
    }
  }
  if (pids.length && restoreHandler) void restoreHandler(pids)
}

/** Ends the control of a session (idle, Stop or end of turn). */
export function endActivity(sessionId: string): void {
  const current = live.get(sessionId)
  if (current) clearTimeout(current.timer)
  live.delete(sessionId)
  // The screenshot only lives while the control lasts: memory does not keep an old image.
  forgetShots(sessionId)
  // A recording the agent did not stop: build it and store it in the gallery.
  void finishOrphanRecording(sessionId)
  releaseEnhanced(sessionId)
  if (current) broadcast({ type: 'idle', sessionId })
  if (live.size === 0) {
    releaseShortcut()
    hideOverlay()
    setComputerPanelsSession(null)
  } else {
    showOverlay()
    // The panels follow the session that acted last among the remaining ones.
    const latest = [...live.values()].sort((a, b) => b.activity.lastAt - a.activity.lastAt)[0]
    setComputerPanelsSession(overlaySessions.has(latest.activity.sessionId) ? null : latest.activity.sessionId)
  }
}

/** Stop: aborts the turn (the abort kills the bridge in progress) and ends the control. */
export function stopComputer(sessionId?: string): void {
  const targets = sessionId ? [sessionId] : [...live.keys()]
  for (const id of targets) {
    stopHandler?.(id)
    endActivity(id)
  }
}

function ensureShortcut(): void {
  if (shortcutOn) return
  for (const accelerator of PANIC_SHORTCUTS) {
    let ok = false
    try {
      ok = globalShortcut.register(accelerator, () => stopComputer())
    } catch {
      ok = false
    }
    // Another app may already own the shortcut: without a log, the panic would fail silently.
    if (!ok) console.warn(`[computer] stop shortcut not registered: ${accelerator}`)
    shortcutOn = shortcutOn || ok
  }
}

function releaseShortcut(): void {
  if (!shortcutOn) return
  for (const accelerator of PANIC_SHORTCUTS) globalShortcut.unregister(accelerator)
  shortcutOn = false
}

/** Link of the Stop button of the band: the main process intercepts the navigation (the page is a data: one without preload). */
const STOP_URL = 'orbit-computer://stop'
/** Breathing room around the band so the yellow ring and the shadow fit in the window. */
const OVERLAY_PAD_X = 12
const OVERLAY_HEIGHT = 52

function overlayHtml(text: string, stop: string, shortcut: string): string {
  const esc = (value: string) => value.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] ?? c)
  // Orbit primary yellow (--primary of the dark theme). The body fills the
  // whole window: at content height, its overflow:hidden cut the
  // ring in a straight line flush with the base of the band.
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;font:600 12px -apple-system,system-ui,sans-serif;-webkit-user-select:none;cursor:default}
body{padding-top:8px;box-sizing:border-box}
.bar{margin:0 auto;width:max-content;max-width:96vw;display:flex;gap:10px;align-items:center;padding:4px 4px 4px 14px;border-radius:999px;
background:rgba(16,16,20,.86);color:#fff;box-shadow:0 0 0 2px oklch(0.795 0.184 86.047),0 4px 12px rgba(0,0,0,.3)}
.dot{width:8px;height:8px;border-radius:50%;background:oklch(0.852 0.199 91.936);animation:p 1.2s ease-in-out infinite}
@keyframes p{50%{opacity:.35}}
.stop{display:inline-flex;gap:6px;align-items:center;padding:4px 10px;border-radius:999px;background:oklch(0.852 0.199 91.936);color:oklch(0.421 0.095 57.708);text-decoration:none;cursor:pointer}
.stop:hover{background:oklch(0.795 0.184 86.047)}
.sq{width:7px;height:7px;border-radius:1.5px;background:currentColor}
kbd{font:600 10px -apple-system,system-ui,sans-serif;opacity:.7}
</style></head><body><div class="bar"><span class="dot"></span><span>${esc(text)}</span>
<a class="stop" href="${STOP_URL}" draggable="false"><span class="sq"></span>${esc(stop)}<kbd>${esc(shortcut)}</kbd></a></div></body></html>`
}

/**
 * Band at the top of the screen while the agent controls the computer, with the Stop
 * button. Non-activating panel and without focus: clicking Stop does not bring Orbit to
 * the front nor steal the keyboard from the app the agent is using. The window shrinks
 * to the size of the band, so it does not block clicks around it. It never shows up in
 * the screenshot — the capture is of the target window, not of the screen.
 */
function showOverlay(): void {
  const apps = [...new Set([...live.values()].map((l) => l.activity.app))].join(', ')
  // In the global pointer the agent uses the REAL mouse: the band warns the person
  // not to fight for the cursor (the mix showed up in the recording).
  const text = tNow(getAppSettings().computer.pointer === 'global' ? 'computer.overlayGlobal' : 'computer.overlay', { apps })
  if (!overlay || overlay.isDestroyed()) {
    const area = screen.getPrimaryDisplay().workArea
    const width = Math.min(720, area.width)
    overlay = new BrowserWindow({
      x: Math.round(area.x + (area.width - width) / 2),
      y: area.y,
      width,
      height: OVERLAY_HEIGHT,
      ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    overlay.setAlwaysOnTop(true, 'screen-saver')
    floatAboveFullScreen(overlay)
    // The button is a link: the navigation never happens, it becomes the Stop.
    overlay.webContents.on('will-navigate', (event, url) => {
      event.preventDefault()
      if (url.startsWith(STOP_URL)) stopComputer()
    })
    overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    overlay.on('closed', () => {
      overlay = null
      overlayText = null
    })
  }
  // Reloading on every action would make the band blink: only when the text changes.
  if (text === overlayText) return
  overlayText = text
  const target = overlay
  void target
    .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(overlayHtml(text, tNow('computer.overlayStop'), computerStopShortcut(process.platform)))}`)
    .then(() => fitOverlay(target))
    .then(() => {
      if (!target.isDestroyed() && !target.isVisible()) target.showInactive()
    })
    .catch(() => undefined)
}

/** Fits the window to the width of the band, centered at the top of the screen. */
async function fitOverlay(target: BrowserWindow): Promise<void> {
  if (target.isDestroyed()) return
  const width = (await target.webContents
    .executeJavaScript('Math.ceil(document.querySelector(".bar").getBoundingClientRect().width)')
    .catch(() => null)) as number | null
  if (!width || target.isDestroyed()) return
  const area = screen.getPrimaryDisplay().workArea
  const w = Math.min(area.width, width + OVERLAY_PAD_X * 2)
  target.setBounds({ x: Math.round(area.x + (area.width - w) / 2), y: area.y, width: w, height: OVERLAY_HEIGHT })
}

function hideOverlay(): void {
  if (overlay && !overlay.isDestroyed()) overlay.destroy()
  overlay = null
  overlayText = null
}

/** App shutdown: gives the flags back, releases the shortcut and closes the indicator. */
export async function disposeComputerSessions(): Promise<void> {
  for (const l of live.values()) clearTimeout(l.timer)
  live.clear()
  const pids = [...enhanced.keys()]
  enhanced.clear()
  releaseShortcut()
  hideOverlay()
  disposeComputerPanels()
  await disposeRecordings()
  if (pids.length && restoreHandler) await restoreHandler(pids)
}
