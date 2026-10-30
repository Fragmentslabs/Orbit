import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { floatAboveFullScreen } from '../float-above-fullscreen'

/**
 * Floating panels of Computer Use: while the agent controls another app and Orbit is
 * out of focus, the conversation stays on the left edge of the screen and the agent's
 * actions on the right — the same design as the browser's full screen (a collapsed
 * handle that opens on hover).
 *
 * It is a transparent window the size of the usable screen area, above the others and
 * transparent to the mouse: only the panels capture clicks (the renderer says when the
 * mouse enters/leaves them). It never receives focus — the keyboard stays with the app
 * the agent is using — and it never shows up in the screenshot, which is of the target
 * window, not of the screen.
 */

export interface PanelsLoader {
  preload: string
  /** Loads the window renderer (dev server or file), with the query */
  load: (win: BrowserWindow, query: Record<string, string>) => void
}

let loader: PanelsLoader | null = null
let win: BrowserWindow | null = null
let sessionId: string | null = null
let focusCheck: NodeJS.Timeout | null = null
/** Mouse over a panel right now */
let interactive = false

/** The main process injects how to load the renderer (the same preload and the same bundle as the app windows). */
export function setupComputerPanels(next: PanelsLoader): void {
  loader = next
  ipcMain.on('computer-panels:interactive', (event, over: boolean) => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return
    interactive = over
    win.setIgnoreMouseEvents(!over, { forward: true })
    // Left the panel: if Orbit gained focus meanwhile, now it hides.
    if (!over) refresh()
  })
  // The answer field needs a keyboard, and the window is born without focus (the
  // keyboard belongs to the app the agent controls). It receives focus only while the
  // field is in use — it is a non-activating NSPanel, so Orbit does not come to
  // the front — and gives it back on leaving it.
  ipcMain.on('computer-panels:keyboard', (event, wants: boolean) => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return
    win.setFocusable(wants)
    if (wants) win.focus()
    else win.blur()
  })
  // Focus between Orbit windows: the blur arrives before the focus of the next one, so
  // the decision waits a moment to avoid a flash when switching windows.
  app.on('browser-window-focus', () => refresh())
  app.on('browser-window-blur', () => {
    if (focusCheck) clearTimeout(focusCheck)
    focusCheck = setTimeout(refresh, 80)
  })
}

export function isComputerPanelsWindow(target: BrowserWindow | null): boolean {
  return Boolean(target && win && target === win)
}

function orbitFocused(): boolean {
  const focused = BrowserWindow.getFocusedWindow()
  return Boolean(focused && focused !== win)
}

/** Session controlling right now (null = nobody): shows or hides according to the focus. */
export function setComputerPanelsSession(next: string | null): void {
  sessionId = next
  refresh()
}

function refresh(): void {
  // With the mouse over a panel, it does not go away: if the click still activates
  // Orbit, the panel cannot disappear under the cursor.
  if (sessionId && interactive && win && !win.isDestroyed() && win.isVisible()) return
  if (!sessionId || orbitFocused() || !loader) {
    hide()
    return
  }
  show(sessionId)
}

function show(id: string): void {
  if (!loader) return
  if (win && !win.isDestroyed()) {
    win.webContents.send('computer-panels:session', id)
    if (!win.isVisible()) win.showInactive()
    return
  }
  const area = screen.getPrimaryDisplay().workArea
  win = new BrowserWindow({
    ...area,
    // Non-activating NSPanel: clicking the pin or a card does not bring Orbit to the
    // front. A common window activated the app on click — Orbit gained focus and the
    // panels went away at the same instant (reported in the first test).
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: { preload: loader.preload, backgroundThrottling: false },
  })
  // Below the "Orbit is controlling" band (screen-saver), above the apps.
  win.setAlwaysOnTop(true, 'floating')
  floatAboveFullScreen(win)
  win.setIgnoreMouseEvents(true, { forward: true })
  win.once('ready-to-show', () => {
    if (win && !win.isDestroyed() && sessionId) win.showInactive()
  })
  win.on('closed', () => {
    win = null
    interactive = false
  })
  loader.load(win, { session: id })
}

function hide(): void {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide()
}

export function disposeComputerPanels(): void {
  sessionId = null
  if (win && !win.isDestroyed()) win.destroy()
  win = null
}
