import type { WebContents } from 'electron'

/**
 * "Real" input for the agent's browsers (the panel's webview and the hidden
 * window of run_browser_script): mouse via `sendInputEvent`, the page's console
 * and JS evaluation.
 *
 * panel_click's `el.click()` is enough for buttons, but dragging (dnd-kit,
 * sortables, sliders) and hover depend on reliable pointer events in a
 * sequence — down, several moves, up. `sendInputEvent` enters through the same
 * path as the physical mouse (isTrusted = true), so the libraries react as
 * they would to a user.
 */

export type BrowserTarget = { ref?: number; selector?: string; x?: number; y?: number }

export interface ConsoleEntry {
  at: number
  level: 'debug' | 'info' | 'warning' | 'error'
  message: string
  source?: string
}

const MAX_CONSOLE_ENTRIES = 500
const EVAL_TIMEOUT_MS = 30_000
const MAX_EVAL_CHARS = 20_000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── Console ────────────────────────────────────────────────────────────────

/** Circular buffer of a WebContents' console messages. */
export class ConsoleBuffer {
  private entries: ConsoleEntry[] = []

  push(entry: Omit<ConsoleEntry, 'at'>): void {
    this.entries.push({ at: Date.now(), ...entry })
    if (this.entries.length > MAX_CONSOLE_ENTRIES) this.entries.splice(0, this.entries.length - MAX_CONSOLE_ENTRIES)
  }

  clear(): void {
    this.entries = []
  }

  get size(): number {
    return this.entries.length
  }

  query(options: { level?: 'all' | 'warning' | 'error'; pattern?: string; limit?: number } = {}): ConsoleEntry[] {
    const level = options.level ?? 'all'
    const pattern = options.pattern?.toLowerCase()
    const filtered = this.entries.filter((e) => {
      if (level === 'error' && e.level !== 'error') return false
      if (level === 'warning' && e.level !== 'error' && e.level !== 'warning') return false
      return !pattern || e.message.toLowerCase().includes(pattern)
    })
    return filtered.slice(-(options.limit ?? 50))
  }
}

export function formatConsoleEntries(entries: ConsoleEntry[]): string {
  return entries
    .map((e) => {
      const time = new Date(e.at).toISOString().slice(11, 19)
      return `${time} [${e.level}] ${e.message}${e.source ? `  (${e.source})` : ''}`
    })
    .join('\n')
}

/** Inline page (data:/blob:) would bring the whole HTML as the message's "file". */
function shortSource(source: string): string {
  if (source.startsWith('data:')) return 'data:…'
  return source.length > 160 ? `…${source.slice(-160)}` : source
}

/**
 * Connects the WebContents' console (and load/crash failures) to the buffer. Uncaught
 * errors and rejected promises arrive here too: Chromium logs them
 * to the console as `error`.
 */
export function attachConsole(wc: WebContents, sink: () => ConsoleBuffer | undefined): void {
  wc.on('console-message', (event) => {
    sink()?.push({
      level: event.level,
      message: event.message,
      source: event.sourceId ? `${shortSource(event.sourceId)}:${event.lineNumber}` : undefined,
    })
  })
  wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    // ERR_ABORTED (-3) is a redirect/SPA, not a failure
    if (code === -3) return
    sink()?.push({
      level: 'error',
      message: `Failed to load ${isMainFrame ? 'the page' : 'a frame'} ${url}: ${description} (${code})`,
    })
  })
  wc.on('did-start-navigation', (event) => {
    if (!event.isMainFrame || event.isSameDocument) return
    sink()?.push({ level: 'info', message: `── navigated to ${event.url} ──` })
  })
  wc.on('render-process-gone', (_event, details) => {
    sink()?.push({ level: 'error', message: `The page process crashed (${details.reason}, code ${details.exitCode})` })
  })
}

// ─── JavaScript ─────────────────────────────────────────────────────────────

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => unknown

/**
 * REPL semantics: a lone expression returns its own value; code with
 * several statements needs a `return`. The test only PARSES the code here in the
 * main (building the function does not run it) — running `new Function` inside the
 * page would hit many sites' CSP.
 */
function asFunctionBody(code: string): string {
  const expression = `return (${code}\n)`
  try {
    new AsyncFunction(expression)
    return expression
  } catch {
    return code
  }
}

/** Runs JS in the page and returns the serialized result (or the error, with a stack). */
export async function evaluateInPage(wc: WebContents, code: string): Promise<string> {
  const script = `(async () => {
  let __value
  try {
    __value = await (async () => {
${asFunctionBody(code)}
    })()
  } catch (e) {
    return { __orbitError: String((e && e.stack) || e) }
  }
  const seen = new WeakSet()
  if (__value === undefined) return 'undefined'
  if (typeof __value === 'function') return __value.toString().slice(0, 500)
  if (__value instanceof Element) return __value.outerHTML.slice(0, 4000)
  try {
    const json = JSON.stringify(__value, (_k, x) => {
      if (typeof x === 'bigint') return x.toString()
      if (x instanceof Element) return '<' + x.tagName.toLowerCase() + (x.id ? '#' + x.id : '') + '>'
      if (x instanceof Map) return Object.fromEntries(x)
      if (x instanceof Set) return [...x]
      if (typeof x === 'object' && x !== null) {
        if (seen.has(x)) return '[Circular]'
        seen.add(x)
      }
      return x
    }, 2)
    return json === undefined ? String(__value) : json
  } catch {
    return String(__value)
  }
})()`
  const TIMED_OUT = Symbol('evalTimedOut')
  let outcome: unknown
  try {
    outcome = await Promise.race([wc.executeJavaScript(script, true), delay(EVAL_TIMEOUT_MS).then(() => TIMED_OUT)])
  } catch (err) {
    return `Execution failed: ${(err as Error)?.message ?? String(err)}`
  }
  if (outcome === TIMED_OUT) return `The code did not finish within ${EVAL_TIMEOUT_MS / 1000}s (pending promise or long loop).`
  if (outcome && typeof outcome === 'object' && '__orbitError' in outcome) {
    return `Page error:\n${String((outcome as { __orbitError: string }).__orbitError).slice(0, 4000)}`
  }
  const text = String(outcome)
  return text.length > MAX_EVAL_CHARS ? `${text.slice(0, MAX_EVAL_CHARS)}\n… (cut at ${MAX_EVAL_CHARS} characters)` : text
}

// ─── Mouse ──────────────────────────────────────────────────────────────────

/**
 * Converts the target (panel_read ref, CSS selector or coordinates) into a point of the
 * viewport, in CSS px. `scroll` brings the element on screen first — it only counts
 * for the starting point: scrolling in the middle of a drag would change the destination.
 */
export async function resolveTarget(
  wc: WebContents,
  target: BrowserTarget,
  scroll: boolean,
): Promise<{ x: number; y: number } | string> {
  if (typeof target.x === 'number' && typeof target.y === 'number') return { x: target.x, y: target.y }
  const finder =
    target.ref != null
      ? `document.querySelector('[data-orbit-ref="${Number(target.ref)}"]')`
      : target.selector
        ? `document.querySelector(${JSON.stringify(target.selector)})`
        : null
  if (!finder) return 'Provide ref, selector or x/y.'
  const point = (await wc.executeJavaScript(`(() => {
    const el = ${finder}
    if (!el) return null
    ${scroll ? "el.scrollIntoView({ block: 'center', inline: 'center' })" : ''}
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)) as { x: number; y: number } | null
  if (!point) {
    return `Element not found (${target.ref != null ? `ref=${target.ref}` : target.selector}). Run panel_read to refresh the refs.`
  }
  return point
}

/** CSS px → sendInputEvent coordinates (which respect the page's zoom). */
function toInput(wc: WebContents, p: { x: number; y: number }) {
  const zoom = wc.getZoomFactor() || 1
  return { x: Math.round(p.x * zoom), y: Math.round(p.y * zoom) }
}

export function mouseMove(wc: WebContents, p: { x: number; y: number }, pressed = false): void {
  wc.sendInputEvent({
    type: 'mouseMove',
    ...toInput(wc, p),
    ...(pressed ? { button: 'left' as const, modifiers: ['leftbuttondown' as const] } : {}),
  })
}

export function mouseDown(wc: WebContents, p: { x: number; y: number }): void {
  wc.sendInputEvent({ type: 'mouseDown', ...toInput(wc, p), button: 'left', clickCount: 1 })
}

export function mouseUp(wc: WebContents, p: { x: number; y: number }): void {
  wc.sendInputEvent({ type: 'mouseUp', ...toInput(wc, p), button: 'left', clickCount: 1 })
}

/**
 * Drags with the left button. A missing `from` continues a previous drag
 * that was left with the button pressed (release: false) — that is how the agent
 * pauses in the middle to take a screenshot of the "dragging" state.
 * Returns where the pointer ended.
 */
export async function dragBetween(
  wc: WebContents,
  from: { x: number; y: number } | null,
  to: { x: number; y: number },
  options: { held: { x: number; y: number } | null; steps?: number; release?: boolean },
): Promise<{ x: number; y: number }> {
  const steps = Math.max(1, Math.min(100, options.steps ?? 12))
  let start: { x: number; y: number }
  if (from) {
    start = from
    mouseMove(wc, start)
    await delay(30)
    mouseDown(wc, start)
    await delay(60)
  } else {
    if (!options.held) throw new Error('No drag in progress — provide from.')
    start = options.held
  }
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps
    mouseMove(wc, { x: start.x + (to.x - start.x) * t, y: start.y + (to.y - start.y) * t }, true)
    await delay(16)
  }
  // Many libs only confirm the target on the frame after the last move
  await delay(80)
  if (options.release !== false) {
    mouseUp(wc, to)
    await delay(250) // drop animation / re-render
  }
  return to
}
