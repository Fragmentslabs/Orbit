import { panelApi } from "@/src/lib/ipc"
import { usePanelStore } from "@/src/stores/panel-store"

/**
 * Pool of `<webview>` for the right panel — one per `sessionId:tabId`.
 *
 * The ELEMENT is disposable (measured on Electron 44, not assumed): the guest of the
 * `<webview>` is destroyed when the element leaves the DOM and created again when
 * it comes back. The previous version reused the SAME element, moving it from
 * parent (hidden host ↔ visible container) — and there the defect was born:
 *
 * - if the element was re-attached before the first guest finished being born,
 *   Electron created TWO guests for the same element and the renderer ended up
 *   keeping the id of the guest that had already died;
 * - with that dead id, the next detach/attach failed with "Invalid
 *   guestInstanceId: N" in the console;
 * - and the tab stayed WHITE forever: Electron's `reset()` (which runs
 *   AFTER the detach) was skipped by the error, so `beforeFirstNavigation`
 *   stayed false and the element never created a guest again — not even on reload.
 *
 * Now every MOUNT creates a new `<webview>`, straight into the visible container,
 * and every UNMOUNT removes it from the DOM. The element never changes parent and is never
 * reused: it is born in the place where it is going to stay and dies when it leaves there.
 *
 * What survives is the STATE of the tab (the URL), kept in the pool registry:
 * - the tab URL (it comes back on the same page when switching tab/chat);
 * - cookies, logins and localStorage (partition `persist:` — survives until
 *   the app restarts);
 * - the selection mode, re-injected on every new guest.
 *
 * What does not persist is the page's in-memory state (filled form,
 * scroll, SPA state) — a limitation of the `<webview>`, not a choice of ours.
 */

/** Persistent session of the panel browser: cookies/logins/localStorage on
 *  disk, shared with the hidden capture window (browser-script.ts). */
export const BROWSER_PARTITION = "persist:orbit-browser"

export interface WebviewElement extends HTMLElement {
  src: string
  partition: string
  getWebContentsId(): number
  getURL(): string
  loadURL(url: string): Promise<void>
  reload(): void
  executeJavaScript(code: string): Promise<unknown>
  isLoading(): boolean
}

interface WebviewRecord {
  key: string
  /** Live <webview>. null when there is no element on screen (tab unmounted or
   *  element discarded). */
  el: WebviewElement | null
  /** Last webContents of the guest registered in the main process. Kept because the
   *  already disconnected element no longer returns the id (Electron zeroes the
   *  guestInstanceId on reset) — and it is that one that needs to be released in the main process. */
  wcId: number | null
  /** Authoritative URL of the tab — survives the recreation of the guest. */
  currentUrl: string
  /** URL we already asked for this guest. Prevents the restore from repeating
   *  when the loaded URL does not match the requested one exactly (Chromium
   *  normalizes URLs) — without that lock, dom-ready and loadURL feed each other in an
   *  infinite loop of ERR_ABORTED. Reset on every new guest (mount/unmount) and
   *  also when the navigation does not get to commit: with a blank guest the
   *  lock does not apply, otherwise it stays stuck in about:blank forever. */
  requestedUrl: string | null
  /** true when the element is in the visible container of a tab. */
  mounted: boolean
  onNavigate?: (url: string) => void
  /** Last known access — basis of the eviction of unmounted webviews. */
  lastUsed: number
}

/** Size of the hidden host when there is NO viewport defined (equivalent to the panel
 *  open filling the container). */
const HIDDEN_WIDTH = 1280
const HIDDEN_HEIGHT = 800

/**
 * Effective size of the hidden host: when the agent defines a viewport
 * (panel_resize), the background browser renders in it — the screenshot
 * comes out in the chosen size EVEN with the panel closed (a real
 * responsiveness test in the background). Without a viewport, it assumes the default
 * size of the panel.
 */
function hiddenHostSize(): { width: number; height: number } {
  const viewport = usePanelStore.getState().viewport
  return viewport
    ? { width: viewport.width, height: viewport.height }
    : { width: HIDDEN_WIDTH, height: HIDDEN_HEIGHT }
}

/**
 * TTL of unmounted webviews (tab closed and agent browser idle): after
 * this time without use, the registry is cleared. The cost of destroying is zero — the
 * next browser tool recreates the webview and navigates to the URL it asks for (the
 * store keeps the last URL of the tab).
 */
export const EVICT_TTL_MS = 10 * 60 * 1000

const records = new Map<string, WebviewRecord>()

// ─── Selection mode ──────────────────────────────────────────────────────────

/** Prefix of the selection payload the page sends through console.log. */
const SELECT_PREFIX = "__ORBIT_SELECT__"

/**
 * Injected into the page when selection mode is on. It is ONE shot: on
 * click, it sends the payload and disarms itself — the store mirrors that
 * (addSelection resets selectMode), so the button is never lit without the
 * listeners being actually active.
 */
const SELECT_ON = `(() => {
  if (window.__orbitSelectCleanup) window.__orbitSelectCleanup()
  let last = null
  const restore = () => { if (last) { last.style.outline = last.__orbitOutline || ''; last = null } }
  const over = (e) => {
    restore()
    last = e.target
    last.__orbitOutline = last.style.outline
    last.style.outline = '2px solid #22c55e'
  }
  const cssPath = (el) => {
    const parts = []
    let node = el
    while (node && node.nodeType === 1 && parts.length < 5) {
      if (node.id) { parts.unshift('#' + node.id); break }
      let part = node.tagName.toLowerCase()
      const cls = [...node.classList].slice(0, 2).join('.')
      if (cls) part += '.' + cls
      const parent = node.parentElement
      if (parent) {
        const siblings = [...parent.children].filter((c) => c.tagName === node.tagName)
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')'
      }
      parts.unshift(part)
      node = node.parentElement
    }
    return parts.join(' > ')
  }
  const click = (e) => {
    e.preventDefault()
    e.stopPropagation()
    const el = e.target
    console.log('${SELECT_PREFIX}' + JSON.stringify({
      tag: el.tagName.toLowerCase(),
      selector: cssPath(el),
      text: (el.innerText || el.value || '').trim().replace(/\\s+/g, ' ').slice(0, 200),
      html: el.outerHTML.slice(0, 1500),
      url: location.href,
    }))
    window.__orbitSelectCleanup()
  }
  document.addEventListener('mouseover', over, true)
  document.addEventListener('click', click, true)
  window.__orbitSelectCleanup = () => {
    document.removeEventListener('mouseover', over, true)
    document.removeEventListener('click', click, true)
    restore()
    window.__orbitSelectCleanup = null
  }
})()`

const SELECT_OFF = `window.__orbitSelectCleanup && window.__orbitSelectCleanup()`

// ─── Safe guest access ───────────────────────────────────────────────────────

/**
 * true when the guest is attached and has already emitted dom-ready. It is a LIVE
 * check: `getWebContentsId()` throws exactly while those conditions do not
 * hold. A cache (WeakSet "it is ready already") would lie after every
 * re-parent, which is when the guest is recreated — it was that lie that took down
 * the React tree with "The WebView must be attached to the DOM...".
 */
export function isWebviewReady(el: WebviewElement): boolean {
  try {
    return el.getWebContentsId() > 0
  } catch {
    return false
  }
}

/** getURL() that never throws: "" while the guest is not ready. */
export function safeWebviewURL(el: WebviewElement): string {
  if (!isWebviewReady(el)) return ""
  try {
    return el.getURL()
  } catch {
    return ""
  }
}

function run(el: WebviewElement, code: string): void {
  if (!isWebviewReady(el)) return
  try {
    void el.executeJavaScript(code).catch(() => {})
  } catch {
    // guest died between the check and the call — the next dom-ready re-applies
  }
}

/** The key is `${sessionId}:${tabId}` — extracts the sessionId (nanoid, no ":"). */
function sessionIdOf(key: string): string {
  const idx = key.indexOf(":")
  return idx >= 0 ? key.slice(0, idx) : key
}

/** The key is `${sessionId}:${tabId}` — extracts the tabId. */
function tabIdOf(key: string): string {
  const idx = key.indexOf(":")
  return idx >= 0 ? key.slice(idx + 1) : key
}

function isRealUrl(url: string | undefined): url is string {
  return !!url && url !== "about:blank"
}

/**
 * Decides whether the restore should ask the guest for the URL.
 *
 * PURE on purpose: it is the only part of this race that can be tested without
 * Electron, and it is exactly where the defect lived. `requestedUrl` exists for the
 * Chromium normalization loop (the loaded URL does not match the
 * requested one exactly, so `guestUrl !== target` alone would never close and dom-ready +
 * loadURL would feed each other in an infinite ERR_ABORTED). But the lock can only apply
 * if the guest got to load SOMETHING: with a blank guest the previous attempt
 * did not commit, and insisting is the right thing — without that nothing loads anymore, because the
 * guard of navigateWebview also only looked at the REQUESTED URL, never at the guest.
 */
export function shouldRestoreGuest(
  target: string,
  guestUrl: string,
  requestedUrl: string | null,
): boolean {
  if (!isRealUrl(target) || guestUrl === target) return false
  return !(requestedUrl === target && isRealUrl(guestUrl))
}

/**
 * Decides whether navigateWebview should act. Pure for the same reason: skipping just because
 * `currentUrl === url` left the tab stuck when the guest was blank — the
 * current URL was already the right one, nobody loaded anything and the restore refused too.
 */
export function shouldNavigate(currentUrl: string, url: string, guestUrl: string): boolean {
  if (!isRealUrl(url)) return false
  return !(currentUrl === url && isRealUrl(guestUrl))
}

let hiddenHost: HTMLDivElement | null = null

function getHiddenHost(): HTMLDivElement {
  if (!hiddenHost) {
    const size = hiddenHostSize()
    hiddenHost = document.createElement("div")
    hiddenHost.style.cssText =
      `position: fixed; top: -10000px; left: -10000px; width: ${size.width}px; height: ${size.height}px;` +
      "opacity: 0; pointer-events: none; z-index: -1;"
    document.body.appendChild(hiddenHost)
  }
  return hiddenHost
}

/**
 * Keeps the hidden host at the size of the store viewport (the agent's
 * panel_resize). The visible UI is already sized by the wrapper of web-preview.tsx —
 * here is the equivalent for the background browser with the panel closed:
 * without that, the shot would always come out at 1280×800, ignoring the viewport.
 */
function applyHiddenHostSize(): void {
  if (!hiddenHost) return
  const { width, height } = hiddenHostSize()
  if (hiddenHost.style.width !== `${width}px`) hiddenHost.style.width = `${width}px`
  if (hiddenHost.style.height !== `${height}px`) hiddenHost.style.height = `${height}px`
}

// The hidden host follows the store viewport. If the resize arrives before
// any webview exists, getHiddenHost() already creates it at the current size — the
// subscribe only needs to update when the host has already been created.
usePanelStore.subscribe((state, prev) => {
  if (state.viewport !== prev.viewport) applyHiddenHostSize()
})

/**
 * The `src` stays FIXED at about:blank for the rest of the element's life. It is what
 * the recreated guest loads on every mount: if it pointed at a real page,
 * every tab switch would reload the OLD page before we went to the current one —
 * and touching `src` with the element attached triggers a navigation, which feeds
 * the navigation handler in a loop. What rules the page is `currentUrl`, via
 * restoreGuest.
 */
function createWebview(): WebviewElement {
  const el = document.createElement("webview") as WebviewElement
  // partition has to be set BEFORE attaching to the DOM (afterwards it is immutable)
  el.partition = BROWSER_PARTITION
  el.src = "about:blank"
  el.style.cssText = "width: 100%; height: 100%; display: flex; background: white; border: 0;"
  return el
}

// ─── Lifecycle ───────────────────────────────────────────────────────────

/** Applies to the guest the state that needs to survive the recreation: URL and selection. */
function restoreGuest(record: WebviewRecord): void {
  const el = record.el
  if (!el || !isWebviewReady(el)) return

  // Always REGISTERS, mounted or not: with the panel closed the guest lives in the hidden
  // host and remains the target of the agent's panel_* tools (it is the browser in
  // the background).
  registerGuest(record)

  const target = record.currentUrl
  if (shouldRestoreGuest(target, safeWebviewURL(el), record.requestedUrl)) {
    record.requestedUrl = target
    try {
      void el.loadURL(target).catch(() => {
        // Did not commit: releases the lock so the next dom-ready tries again.
        if (records.get(record.key) === record) record.requestedUrl = null
      })
    } catch {
      record.requestedUrl = null
    }
  }

  run(el, usePanelStore.getState().selectMode ? SELECT_ON : SELECT_OFF)
}

/** Registers the guest's webContents in the main process (target of the panel_* tools). */
function registerGuest(record: WebviewRecord): void {
  const el = record.el
  if (!el) return
  try {
    const wcId = el.getWebContentsId()
    if (wcId > 0) {
      record.wcId = wcId
      panelApi.register(sessionIdOf(record.key), wcId)
    }
  } catch {
    // the next dom-ready registers it
  }
}

/** Records the URL as the current one of the tab and propagates it to the UI and to the store. */
function reportUrl(record: WebviewRecord, url: string): void {
  if (!isRealUrl(url) || record.currentUrl === url) return
  // A server redirect during a restore also comes through here: the URL that
  // the guest actually loaded becomes the current one of the tab.
  record.currentUrl = url
  record.onNavigate?.(url)
  // Persists in the tab even with the component unmounted (agent navigating in
  // the background) — that is what makes the URL survive leaving and returning to the chat.
  usePanelStore.getState().setTabUrl(sessionIdOf(record.key), tabIdOf(record.key), url)
}

function handleConsoleMessage(message: string): void {
  if (!message.startsWith(SELECT_PREFIX)) return
  try {
    usePanelStore.getState().addSelection(JSON.parse(message.slice(SELECT_PREFIX.length)))
  } catch {
    // malformed payload — ignores it
  }
}

/** Creates the element and wires the listeners. Does NOT attach to the DOM — the caller decides
 *  where the element is born (visible container or hidden host), and it never changes
 *  parent after that. */
function createElement(record: WebviewRecord): WebviewElement {
  const el = createWebview()

  // dom-ready fires when the guest is born (once per element) — it is the hook
  // to return the guest to the state of the tab.
  el.addEventListener("dom-ready", () => {
    // element discarded along the way: the registry is already another one
    if (record.el !== el) return
    restoreGuest(record)
  })

  const syncUrl = (event: Event) => {
    if (record.el !== el) return
    const url = (event as Event & { url?: string }).url
    if (url) reportUrl(record, url)
  }
  el.addEventListener("did-navigate", syncUrl)
  el.addEventListener("did-navigate-in-page", syncUrl)
  el.addEventListener("console-message", (event) => {
    if (record.el !== el) return
    const message = (event as Event & { message?: string }).message
    if (message) handleConsoleMessage(message)
  })

  return el
}

/** Creates (or reuses) the registry entry of the key. */
function ensureRecord(key: string, src?: string): WebviewRecord {
  const existing = records.get(key)
  if (existing) return existing
  const record: WebviewRecord = {
    key,
    el: null,
    wcId: null,
    currentUrl: isRealUrl(src) ? src : "",
    requestedUrl: null,
    mounted: false,
    lastUsed: Date.now(),
  }
  records.set(key, record)
  return record
}

/**
 * Discards the element: it leaves the DOM (the guest dies with it) and the reference
 * is released. The registry (and the tab URL) stays alive.
 *
 * The element is DISCARDED, never moved to another parent: it was exactly the
 * re-parent that corrupted the guest (see the header of the file).
 */
function disposeElement(record: WebviewRecord): void {
  const el = record.el
  if (!el) return
  record.el = null
  record.requestedUrl = null

  try {
    el.remove()
  } catch {
    // it was already out of the DOM
  }

  // The guest died with the element: releases the registry in the main process (only if it is the
  // webContents of this webview — the session's agent browser is another one).
  if (record.wcId) {
    panelApi.unregister(sessionIdOf(record.key), record.wcId)
    record.wcId = null
  }
}

/**
 * Mounts the webview of the key in the visible container of the tab.
 *
 * Every mount creates a NEW `<webview>`, already in the container: the element never
 * changes parent (which is what kept the guest corrupted) and is born with a single guest.
 * The tab URL is re-applied on dom-ready, by the pool.
 */
export function mountWebview(
  key: string,
  container: HTMLElement,
  src?: string,
  onNavigate?: (url: string) => void,
): WebviewElement {
  const record = ensureRecord(key, src)
  record.onNavigate = onNavigate
  record.lastUsed = Date.now()

  // It is already in place (React re-render): re-applies the state without touching the DOM.
  const current = record.el
  if (current && record.mounted && current.parentElement === container) {
    restoreGuest(record)
    return current
  }

  // New element: the previous one (if any) is discarded, never re-attached.
  disposeElement(record)

  const el = createElement(record)
  record.el = el
  record.mounted = true
  record.requestedUrl = null
  container.appendChild(el)

  // New guest on the way: the restore of this generation has not been tried yet.
  restoreGuest(record)
  return el
}

/** Unmounts: the element leaves the DOM and dies. The tab URL stays in the registry. */
export function unmountWebview(key: string): void {
  const record = records.get(key)
  if (!record) return
  record.onNavigate = undefined
  record.mounted = false
  disposeElement(record)
}

export function getWebview(key: string): WebviewElement | null {
  const record = records.get(key)
  if (record) record.lastUsed = Date.now()
  return record?.el ?? null
}

/** Known current URL of the tab — does not touch the guest, so it never throws. */
export function getWebviewUrl(key: string): string {
  return records.get(key)?.currentUrl ?? ""
}

/** Canonical key of the agent browser in a session (chat/task). */
function agentKey(sessionId: string): string {
  return `${sessionId}:browser-agent`
}

/**
 * Ensures the AGENT webview of the session exists in the HIDDEN host (without opening the
 * UI). Used when the agent needs the browser with the panel closed: the guest
 * is born hidden, registers in the main process on dom-ready and the panel_* tools start
 * acting on it.
 *
 * The agent element is born IN the hidden host and is never moved. When the session's
 * Browser tab is opened on screen, the pool creates a new element for the
 * visible container (same URL, same session) — the one in the hidden host is discarded.
 */
export function ensureAgentBrowser(sessionId: string, url?: string): void {
  if (!sessionId) return
  const key = agentKey(sessionId)
  const record = ensureRecord(key, url)
  if (!record.el) {
    const el = createElement(record)
    record.el = el
    record.requestedUrl = null
    getHiddenHost().appendChild(el)
  }
  if (url) navigateWebview(key, url)
  // The main process may still have the webContents of a guest that already died: re-registers
  // the live one so the panel_* tools find the target.
  registerGuest(record)
}

/** Navigates the tab. Guest not ready: the URL stays as the current one and dom-ready applies it. */
export function navigateWebview(key: string, url: string): void {
  const record = records.get(key)
  if (!record) return
  const guestUrl = record.el ? safeWebviewURL(record.el) : ""
  if (!shouldNavigate(record.currentUrl, url, guestUrl)) return
  record.lastUsed = Date.now()
  record.currentUrl = url
  if (!record.el || !isWebviewReady(record.el)) {
    // Guest not ready: dom-ready takes it to the new URL.
    record.requestedUrl = null
    return
  }
  record.requestedUrl = url
  try {
    void record.el.loadURL(url).catch(() => {
      // Did not commit: releases the lock so the next attempt loads again.
      if (records.get(key) === record) record.requestedUrl = null
    })
  } catch {
    record.requestedUrl = null // the next dom-ready restores it
  }
}

/** Reloads the page of the tab, without recreating the element. */
export function reloadWebview(key: string): void {
  const record = records.get(key)
  if (!record || !record.el || !isWebviewReady(record.el)) return
  record.lastUsed = Date.now()
  try {
    record.el.reload()
  } catch {
    // guest swapped between the check and the call — nothing to reload
  }
}

/** Turns selection mode on/off in the page of the tab (re-applied on every new guest). */
export function applySelectMode(key: string, on: boolean): void {
  const record = records.get(key)
  if (!record) return
  record.lastUsed = Date.now()
  if (!record.el) return
  run(record.el, on ? SELECT_ON : SELECT_OFF)
}

/**
 * Destroys unmounted and inactive webviews. Skips:
 * - mounted tabs (visible in the UI);
 * - sessions whose agent used the browser recently (the background
 *   browser CANNOT die in the middle of the agent's work — `agentBrowser.at`
 *   is updated by the main process on every browser tool).
 * Called periodically by the App. Returns how many it destroyed.
 */
export function evictInactiveWebviews(now = Date.now()): number {
  const agentBrowser = usePanelStore.getState().agentBrowser
  let removidos = 0
  for (const [key, record] of records) {
    if (record.mounted) continue
    if (now - record.lastUsed < EVICT_TTL_MS) continue
    const sId = sessionIdOf(key)
    const entry = agentBrowser[sId]
    if (entry && now - entry.at < EVICT_TTL_MS) continue
    destroyWebview(key)
    removidos++
  }
  return removidos
}

/** Destroys the webview of the key (tab close) — clears the registry in the main process. */
export function destroyWebview(key: string): void {
  const record = records.get(key)
  if (!record) return
  disposeElement(record)
  records.delete(key)
}
