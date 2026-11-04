import { tNow } from './i18n'
import { BrowserWindow, webContents, type NativeImage, type WebContents } from 'electron'
import sharp from 'sharp'
import {
  ConsoleBuffer,
  attachConsole,
  dragBetween,
  evaluateInPage,
  formatConsoleEntries,
  mouseMove,
  mouseUp,
  resolveTarget,
  type BrowserTarget,
} from './browser-input'

/**
 * Panel browser controlled by the agent. The renderer mounts a
 * <webview> on the Browser tab and registers the webContentsId here (panel:register);
 * the operations (navigate, read, click, type, screenshot) run directly on the
 * WebContents. When the agent needs the browser and the panel is closed, we
 * broadcast "panel:event" and wait for the registration — the panel opens on its own.
 *
 * The registration is PER CHAT SESSION (Map sessionId → webContentsId): each chat
 * has its own browser tab/instance, and an agent's tools act on the
 * webview of ITS session — two agents in different chats navigate/capture
 * simultaneously, each in its own browser, without stepping on each other.
 */

const REGISTER_TIMEOUT_MS = 10_000
const LOAD_TIMEOUT_MS = 20_000
/** Maximum time a capturePage may take (renderer busy/stuck). */
const CAPTURE_TIMEOUT_MS = 10_000
/** Capture attempts before giving up (the webview may be repainting). */
const CAPTURE_ATTEMPTS = 3
const CAPTURE_RETRY_DELAY_MS = 500

/**
 * Capture failure of the panel webview (empty or timeout). The
 * panel_screenshot tool uses `reason` to decide the fallback (hidden window).
 */
export class PanelCaptureError extends Error {
  constructor(
    message: string,
    readonly reason: 'empty' | 'timeout',
  ) {
    super(message)
  }
}

const panelWcs = new Map<string, number>()

/**
 * Last viewport requested by the agent (panel_resize). The renderer applies it to the
 * webview's hidden host; here it serves so that the FALLBACK captures in the hidden
 * window (captureUrl) come out in the SAME size — without this, a mobile screenshot
 * would become desktop when the panel webview fails. null = "fills the
 * panel" (the hidden window uses the 1280×800 default).
 */
let lastViewport: { width: number; height: number } | null = null

export function panelLastViewport(): { width: number; height: number } | null {
  return lastViewport
}

/**
 * Console of each session. It lives per SESSION, not per webContents: the guest is
 * recreated when the tab changes place, and the history (the error that brought the
 * page down) cannot disappear along with it.
 */
const consoleBySession = new Map<string, ConsoleBuffer>()
/** webContents already linked to the console → session that owns them now. */
const consoleOwners = new Map<number, string>()

function consoleOf(sessionId: string): ConsoleBuffer {
  let buffer = consoleBySession.get(sessionId)
  if (!buffer) {
    buffer = new ConsoleBuffer()
    consoleBySession.set(sessionId, buffer)
  }
  return buffer
}

/** Pointer with the button still pressed (panel_drag with release: false). */
const heldPointer = new Map<string, { x: number; y: number }>()

export function registerPanelWebContents(sessionId: string | null, id: number | null): void {
  if (!sessionId) return
  if (id == null) {
    panelWcs.delete(sessionId)
    return
  }
  panelWcs.set(sessionId, id)
  const wc = webContents.fromId(id)
  if (!wc || wc.isDestroyed()) return
  const known = consoleOwners.has(id)
  consoleOwners.set(id, sessionId)
  if (known) return
  attachConsole(wc, () => {
    const owner = consoleOwners.get(id)
    return owner ? consoleOf(owner) : undefined
  })
  wc.once('destroyed', () => consoleOwners.delete(id))
}

/**
 * Releases the registration of a <webview> that died — but ONLY if the registration is
 * that webContents. Without this condition, closing a tab would take down the agent's
 * browser of the session (which is another webview, still alive).
 */
export function unregisterPanelWebContents(sessionId: string | null, id: number | null): void {
  if (!sessionId || id == null) return
  if (panelWcs.get(sessionId) !== id) return
  panelWcs.delete(sessionId)
  consoleOwners.delete(id)
}

function getWc(sessionId: string): WebContents | null {
  const wcId = panelWcs.get(sessionId)
  if (wcId == null) return null
  const wc = webContents.fromId(wcId)
  return wc && !wc.isDestroyed() ? wc : null
}

export type PanelEvent =
  | { type: 'ensure'; url?: string; sessionId: string }
  | { type: 'resize'; width: number | null; height: number | null; label: string }
  | { type: 'fullscreen'; on: boolean }
  // Opens (or focuses) the panel's Motion tab for a motion composition already
  // registered — the motion_preview tool is what emits it, right after writing the
  // composition and before any render. `id` identifies the composition in the
  // registry (video/motion-store) and `entry` is the path of the entry INSIDE the
  // composition folder, as it appears in the scheme URL (`index.html`, almost
  // always): the panel keeps both (`motionId`/`motionEntry`) and mounts
  // `orbit-motion://<id>/<entry>`. The same id comes back to the SAME tab; whoever serves
  // the content is the scheme, not this channel.
  | { type: 'motion'; id: string; entry: string; title: string }
  // Opens (or focuses) the panel's Design tab for an already registered canvas — whoever
  // emits it is design_write/design_edit, right after writing the canvas. `id`
  // identifies the canvas in the registry (design/design-store); unlike
  // motion there is no `entry` (the canvas has no single entry file — the tab reads
  // `canvas.json` and draws every artboard).
  | { type: 'design'; id: string; title: string; sessionId?: string; path?: string }
  // Opens (or focuses) the panel's Slides tab for an already registered deck — whoever
  // emits it is slides_preview/slides_write. `entry` is the entry file inside
  // the deck folder (almost always `index.html`), as it appears in the
  // scheme URL: the panel keeps `slidesId`/`slidesEntry` and mounts
  // `orbit-slides://<id>/<entry>`. The same id comes back to the SAME tab.
  | { type: 'slides'; id: string; entry: string; title: string; sessionId?: string; path?: string }
  | { type: 'activity'; label: string; sessionId?: string }
  // Pieces that no longer exist — deleted by the agent (motion_delete,
  // design_delete, slides_delete) or undone by the revert of the message that
  // created them. The panel closes their tabs in every chat.
  | { type: 'pieces-removed'; motion: string[]; design: string[]; slides: string[] }

function broadcastPanelEvent(event: PanelEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('panel:event', event)
  }
}

/**
 * Announces to the UI what the agent is doing in the browser (activity feed).
 * `sessionId` identifies which chat it came from — the renderer uses it to keep the
 * "testing…" indicator fresh on that session (header badge and chip in the
 * conversation).
 */
function activity(label: string, sessionId?: string): void {
  broadcastPanelEvent({ type: 'activity', label, sessionId })
}

/** Same feed, for whoever captures outside the panel (hidden script engine). */
export function panelActivity(label: string): void {
  activity(label)
}

/**
 * Opens (or focuses) the panel's Motion tab for an already registered composition —
 * `motion_preview` is the only caller. It validates and loads nothing here (the
 * registry and the scheme do that): it only tells the UI, which resolves the rest by the
 * received id — calling again with the same id brings the SAME tab to focus.
 */
export function panelMotionPreview(event: { id: string; entry: string; title: string; path?: string; sessionId?: string }): void {
  broadcastPanelEvent({ type: 'motion', ...event })
}

/**
 * Opens (or focuses) the panel's Design tab for an already registered canvas —
 * design_write/design_edit are the only callers. It mirrors panelMotionPreview.
 */
export function panelDesignPreview(event: { id: string; title: string; path?: string; sessionId?: string }): void {
  broadcastPanelEvent({ type: 'design', ...event })
}

/**
 * Opens (or focuses) the panel's Slides tab for an already registered deck —
 * slides_preview/slides_write are the only callers. It mirrors
 * panelMotionPreview: it only tells the UI, which resolves the rest by the id.
 */
export function panelSlidesPreview(event: {
  id: string
  entry: string
  title: string
  path?: string
  sessionId?: string
}): void {
  broadcastPanelEvent({ type: 'slides', ...event })
}

/** Closes the tabs of the pieces that no longer exist (see the 'pieces-removed' event). */
export function panelPiecesRemoved(removed: { motion?: string[]; design?: string[]; slides?: string[] }): void {
  const event = { type: 'pieces-removed' as const, motion: removed.motion ?? [], design: removed.design ?? [], slides: removed.slides ?? [] }
  if (event.motion.length + event.design.length + event.slides.length === 0) return
  broadcastPanelEvent(event)
}

/** Current URL of the panel browser — empty when the session has no webview. */
export function panelCurrentUrl(sessionId: string): string {
  const wc = getWc(sessionId)
  if (!wc) return ''
  const url = wc.getURL()
  return url === 'about:blank' ? '' : url
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Ensures the session's webview is registered (creating it in the hidden host if
 * needed) and returns the WebContents OF THAT session. `sessionId` identifies which
 * chat/task the request came from — the renderer creates the hidden <webview> and the
 * per-session registration guarantees that an agent's tools never act on another chat's
 * browser. The panel NEVER opens on its own: the UI only shows the browser when
 * the user clicks the indicator.
 */
export async function ensurePanelBrowser(sessionId: string, url?: string): Promise<WebContents> {
  const existing = getWc(sessionId)
  if (existing) return existing
  broadcastPanelEvent({ type: 'ensure', url, sessionId })
  const deadline = Date.now() + REGISTER_TIMEOUT_MS
  while (Date.now() < deadline) {
    const wc = getWc(sessionId)
    if (wc) return wc
    await delay(200)
  }
  throw new Error('The panel browser did not open in time (is the right panel available?)')
}

async function waitForLoad(wc: WebContents): Promise<void> {
  const deadline = Date.now() + LOAD_TIMEOUT_MS
  while (wc.isLoading() && Date.now() < deadline) await delay(150)
  await delay(400) /** Resizes the browser viewport (responsiveness). null = fills the panel. */
}

/** Resizes the browser viewport (responsiveness). null = fills the panel. */
export async function panelResize(
  sessionId: string,
  width: number | null,
  height: number | null,
  label: string,
): Promise<string> {
  await ensurePanelBrowser(sessionId)
  activity(tNow('panel.activity.resize', { label }), sessionId)
  lastViewport = width && height ? { width, height } : null
  broadcastPanelEvent({ type: 'resize', width, height, label })
  await delay(700) // lets the layout reflow at the new width
  return width
    ? `Viewport set to ${label} (${width}×${height}px). Use panel_screenshot to see the result.`
    : `Viewport set to ${label} (fills the panel).`
}

/** Turns the panel browser's fullscreen on/off. */
export async function panelFullscreen(on: boolean): Promise<void> {
  broadcastPanelEvent({ type: 'fullscreen', on })
  await delay(350)
}

export async function panelNavigate(sessionId: string, url: string): Promise<{ title: string; url: string }> {
  const wc = await ensurePanelBrowser(sessionId, url)
  activity(tNow('panel.activity.navigate', { url }), sessionId)
  try {
    await Promise.race([wc.loadURL(url), delay(LOAD_TIMEOUT_MS)])
  } catch (err) {
    // ERR_ABORTED (-3) is common in SPAs/redirects — it is not a real failure
    const code = (err as { errno?: number }).errno
    if (code !== -3) throw err
  }
  await waitForLoad(wc)
  return { title: wc.getTitle(), url: wc.getURL() }
}

/**
 * Read script: marks visible interactive elements with data-orbit-ref
 * and returns the title, URL, visible text and the list of labeled interactive elements.
 */
const READ_SCRIPT = `(() => {
  const interactiveSelector = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [onclick]'
  const isVisible = (el) => {
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return false
    const style = getComputedStyle(el)
    return style.visibility !== 'hidden' && style.display !== 'none'
  }
  const labelOf = (el) => {
    const text = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.title || '').trim()
    return text.replace(/\\s+/g, ' ').slice(0, 80)
  }
  let ref = 0
  const interactive = []
  for (const el of document.querySelectorAll(interactiveSelector)) {
    if (!isVisible(el)) continue
    ref += 1
    el.setAttribute('data-orbit-ref', String(ref))
    const tag = el.tagName.toLowerCase()
    const type = el.getAttribute('type')
    interactive.push('[ref=' + ref + '] <' + tag + (type ? ' type=' + type : '') + '> ' + labelOf(el))
    if (interactive.length >= 150) break
  }
  return {
    title: document.title,
    url: location.href,
    text: (document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 6000),
    interactive,
  }
})()`

export async function panelRead(sessionId: string): Promise<string> {
  const wc = await ensurePanelBrowser(sessionId)
  activity(tNow('panel.activity.read'), sessionId)
  const result = (await wc.executeJavaScript(READ_SCRIPT)) as {
    title: string
    url: string
    text: string
    interactive: string[]
  }
  return [
    `Page: ${result.title} — ${result.url}`,
    '',
    '## Visible content',
    result.text || '(empty page)',
    '',
    `## Interactive elements (use ref in panel_click/panel_type)`,
    result.interactive.join('\n') || '(none found)',
  ].join('\n')
}

function findScript(ref?: number, selector?: string): string {
  if (ref != null) return `document.querySelector('[data-orbit-ref="${ref}"]')`
  return `document.querySelector(${JSON.stringify(selector ?? '')})`
}

export async function panelClick(sessionId: string, ref?: number, selector?: string): Promise<string> {
  const wc = await ensurePanelBrowser(sessionId)
  activity(tNow('panel.activity.click', { target: ref != null ? `ref ${ref}` : (selector ?? '') }), sessionId)
  const outcome = (await wc.executeJavaScript(`(() => {
    const el = ${findScript(ref, selector)}
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    el.click()
    return true
  })()`)) as boolean | null
  if (!outcome) return `Element not found (${ref != null ? `ref=${ref}` : selector}). Run panel_read to refresh the refs.`
  await waitForLoad(wc)
  return `Clicked. Now on: ${wc.getTitle()} — ${wc.getURL()}`
}

export async function panelType(
  sessionId: string,
  text: string,
  ref?: number,
  selector?: string,
  pressEnter?: boolean,
): Promise<string> {
  const wc = await ensurePanelBrowser(sessionId)
  activity(tNow('panel.activity.type'), sessionId)
  const outcome = (await wc.executeJavaScript(`(() => {
    const el = ${findScript(ref, selector)}
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    el.focus()
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter) setter.call(el, ${JSON.stringify(text)})
    else el.value = ${JSON.stringify(text)}
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    if (${pressEnter === true}) {
      const form = el.form
      if (form && typeof form.requestSubmit === 'function') form.requestSubmit()
      else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
    }
    return true
  })()`)) as boolean | null
  if (!outcome) return `Field not found (${ref != null ? `ref=${ref}` : selector}). Run panel_read to refresh the refs.`
  await waitForLoad(wc)
  return `Text typed${pressEnter ? ' and submitted' : ''}. Now on: ${wc.getTitle()} — ${wc.getURL()}`
}

/**
 * Screenshot of the viewport, reduced to ≤1024px of width by default
 * (token saving — `maxWidth` raises that for documentation). With
 * fullscreen, it goes full screen to capture the whole screen and returns to the side
 * view right after (the screenshot comes out bigger and the UI goes back to normal).
 *
 * For the WHOLE PAGE (beyond the viewport) the path is another: captureUrl in
 * browser-script.ts, in a hidden window — resizing the visible webview
 * would make the UI blink.
 */
export async function panelScreenshot(
  sessionId: string,
  fullscreen = false,
  options?: { format?: 'webp' | 'png'; maxWidth?: number },
): Promise<Buffer> {
  const wc = await ensurePanelBrowser(sessionId)
  activity(tNow('panel.activity.screenshot'), sessionId)

  /**
   * Capture with protections: the capturePage of the panel's hidden webview returns an
   * EMPTY image when the webview is not painted (hidden host, 0×0 after
   * resize) and may never resolve when the renderer is busy — both
   * cases became sharp's "Input buffer is empty" or hung the tool.
   */
  const capture = async (defaultWidth: number) => {
    const maxWidth = options?.maxWidth ?? defaultWidth
    const CAPTURE_TIMED_OUT = Symbol('captureTimedOut')
    let timedOut = false
    for (let attempt = 1; attempt <= CAPTURE_ATTEMPTS; attempt += 1) {
      const outcome = await Promise.race<NativeImage | typeof CAPTURE_TIMED_OUT>([
        wc.capturePage(),
        delay(CAPTURE_TIMEOUT_MS).then(() => CAPTURE_TIMED_OUT),
      ])
      if (outcome !== CAPTURE_TIMED_OUT) {
        const png = outcome.toPNG()
        if (!outcome.isEmpty() && png.length > 0) {
          const { width } = outcome.getSize()
          const resized = width > maxWidth ? outcome.resize({ width: maxWidth }) : outcome
          const pipeline = sharp(resized.toPNG())
          return options?.format === 'png'
            ? await pipeline.png().toBuffer()
            : await pipeline.webp({ quality: 80 }).toBuffer()
        }
      } else {
        timedOut = true
      }
      if (attempt < CAPTURE_ATTEMPTS) await delay(CAPTURE_RETRY_DELAY_MS)
    }
    throw new PanelCaptureError(
      timedOut
        ? 'The panel webview did not answer the capture in time — the browser may be busy or stuck; try again (or panel_navigate) and, if it persists, open the panel.'
        : 'The panel webview is hidden or not painting (empty capture) — the browser needs to be visible; try panel_resize desktop or open the panel and capture again.',
      timedOut ? 'timeout' : 'empty',
    )
  }

  if (!fullscreen) return capture(1024)
  await panelFullscreen(true)
  try {
    await delay(300)
    return capture(1440)
  } finally {
    await panelFullscreen(false)
  }
}

/** Messages from the console of the panel page (errors, warnings, logs). */
export function panelConsole(
  sessionId: string,
  options: { level?: 'all' | 'warning' | 'error'; pattern?: string; limit?: number; clear?: boolean },
): string {
  const buffer = consoleBySession.get(sessionId)
  if (!buffer || buffer.size === 0) {
    return getWc(sessionId)
      ? 'Console empty — no messages since the browser opened.'
      : 'This session\'s browser has not opened yet — use panel_navigate first.'
  }
  const entries = buffer.query(options)
  if (options.clear) buffer.clear()
  const filter = options.level && options.level !== 'all' ? ` (level ${options.level}+)` : ''
  if (entries.length === 0) return `No messages${filter}${options.pattern ? ` containing "${options.pattern}"` : ''}.`
  return `${entries.length} message(s)${filter}${options.clear ? ' — console cleared afterwards' : ''}:\n${formatConsoleEntries(entries)}`
}

/** Runs JS on the panel page (the same one the user sees) and returns the result. */
export async function panelEval(sessionId: string, code: string): Promise<string> {
  const wc = await ensurePanelBrowser(sessionId)
  activity(tNow('panel.activity.eval'), sessionId)
  return evaluateInPage(wc, code)
}

/**
 * Runs a script in the panel page and returns its RAW value (an object, not the formatted JSON text
 * panelEval gives). For internal tools that move data — frames as data URLs — which the eval
 * formatting would stringify and truncate. Never reachable with agent-written text except through the
 * tool that builds the script; a thrown error comes back as { __error }.
 */
export async function panelRunScript(sessionId: string, script: string, timeoutMs = 30_000): Promise<unknown> {
  const wc = await ensurePanelBrowser(sessionId)
  activity(tNow('panel.activity.eval'), sessionId)
  const TIMED_OUT = Symbol('scriptTimedOut')
  try {
    const outcome = await Promise.race([wc.executeJavaScript(script, true), delay(timeoutMs).then(() => TIMED_OUT)])
    if (outcome === TIMED_OUT) return { __error: `the page did not answer within ${Math.round(timeoutMs / 1000)} s` }
    return outcome
  } catch (err) {
    return { __error: (err as Error)?.message ?? String(err) }
  }
}

/** Hovers the mouse over an element (menus, tooltips, :hover states). */
export async function panelHover(sessionId: string, target: BrowserTarget): Promise<string> {
  const wc = await ensurePanelBrowser(sessionId)
  const point = await resolveTarget(wc, target, true)
  if (typeof point === 'string') return point
  activity(tNow('panel.activity.hover'), sessionId)
  mouseMove(wc, point, heldPointer.has(sessionId))
  await delay(300)
  return `Mouse over (${Math.round(point.x)}, ${Math.round(point.y)}). Use panel_screenshot to see the hover state.`
}

/**
 * Drags with real mouse events. With release: false the button stays
 * pressed — the agent takes the screenshot in the middle of the gesture and calls again (without
 * from) to continue or release.
 */
export async function panelDrag(
  sessionId: string,
  options: { from?: BrowserTarget; to: BrowserTarget; steps?: number; release?: boolean },
): Promise<string> {
  const wc = await ensurePanelBrowser(sessionId)
  const held = heldPointer.get(sessionId) ?? null
  if (options.from && held) {
    // A pending drag with the button pressed: it releases before starting another one
    mouseUp(wc, held)
    heldPointer.delete(sessionId)
    await delay(150)
  }
  if (!options.from && !held) return 'No drag in progress — provide from (ref, selector or x/y).'
  const from = options.from ? await resolveTarget(wc, options.from, true) : null
  if (typeof from === 'string') return from
  const to = await resolveTarget(wc, options.to, false)
  if (typeof to === 'string') return to
  activity(tNow(options.release === false ? 'panel.activity.dragHold' : 'panel.activity.drag'), sessionId)
  const end = await dragBetween(wc, from, to, {
    held: options.from ? null : held,
    steps: options.steps,
    release: options.release,
  })
  if (options.release === false) {
    heldPointer.set(sessionId, end)
    return `Dragging — button still held at (${Math.round(end.x)}, ${Math.round(end.y)}). Take the panel_screenshot now; then call panel_drag without from to move further or release (release: true).`
  }
  heldPointer.delete(sessionId)
  return `Released at (${Math.round(end.x)}, ${Math.round(end.y)}). Now on: ${wc.getTitle()} — ${wc.getURL()}`
}
