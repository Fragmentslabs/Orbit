import { BrowserWindow, app, utilityProcess, type UtilityProcess } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { saveMedia, type MediaSource } from './media'
import { panelActivity } from './panel-browser'
import { tNow } from './i18n'
import { resolveArtifactPath } from './artifact-path'
import {
  ConsoleBuffer,
  attachConsole,
  dragBetween,
  formatConsoleEntries,
  mouseMove,
  mouseUp,
  resolveTarget,
  type BrowserTarget,
} from './browser-input'

/**
 * Orbit's headless capture engine.
 *
 * The agent writes a JS script (run_browser_script) or asks for a batch of photos
 * (capture_batch); both run here. The agent's script does NOT run in the main:
 * it goes to a `utilityProcess` (Electron's Node, a separate process), which talks
 * to the main over IPC and drives a hidden `BrowserWindow`. That way an infinite
 * loop or a throw in the script does not bring the app down — it is enough to kill the process on
 * timeout.
 *
 * The hidden window uses the SAME persistent partition as the right panel's `<webview>`
 * (BROWSER_PARTITION) — cookies, logins and localStorage are
 * shared: what is logged in in the panel is logged in here.
 *
 * Playwright does not enter the bundle: the engine is Electron's own Chromium.
 */

/** Persistent session shared with the panel's `<webview>` (cookies/logins).
 *  It has to be identical to the renderer's BROWSER_PARTITION (webview-session.ts). */
export const BROWSER_PARTITION = 'persist:orbit-browser'

/** Maximum height of a fullPage capture (avoids blowing memory on infinite pages). */
const MAX_FULL_PAGE_HEIGHT = 8000
export const DEFAULT_VIEWPORT = { width: 1280, height: 800 }
const DEFAULT_TIMEOUT_MS = 120_000
const LOAD_TIMEOUT_MS = 20_000
const MAX_LOGS = 200
/** Character limit per orbit.fetch response (the body crosses IPC). */
const MAX_FETCH_CHARS = 200_000

export type CaptureFormat = 'webp' | 'png' | 'jpeg'

export interface CaptureItem {
  name: string
  mediaUrl: string
  width: number
  height: number
  size: number
}

/** Text artifact saved by the script (orbit.save). */
export interface ArtifactItem {
  name: string
  path: string
  bytes: number
}

export interface ScriptRunResult {
  taskId: string
  captures: CaptureItem[]
  artifacts: ArtifactItem[]
  /** Folder where the artifacts were written (undefined if the script saved nothing). */
  artifactsDir?: string
  logs: string[]
  returned?: unknown
  error?: string
  timedOut?: boolean
}

export interface RunScriptOptions {
  script: string
  sessionId: string
  /** Task identifier — becomes the folder in orbit-data/scripts/<taskId> */
  taskId?: string
  /** Source recorded on the saved images */
  source?: MediaSource
  /** Preserves the script's folder after execution (default: deletes) */
  keep?: boolean
  timeoutMs?: number
  viewport?: { width: number; height: number }
  /** Folder (absolute) where orbit.save writes the artifacts. Without it, the
   *  artifacts go to the task folder and it is preserved. */
  outDir?: string
}

function scriptsDir(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'scripts')
}

/** taskId safe to become a folder name (the agent may send anything). */
function safeTaskId(raw?: string): string {
  const cleaned = (raw ?? '').replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  if (cleaned) return cleaned
  return `task-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Bridge that runs INSIDE the utilityProcess. It lives here as text because the main
 * is bundled into a single bundle (vite-plugin-electron) — there is no second
 * entry for the child process; the file is generated in the task folder on every
 * execution, along with the agent's run.js.
 *
 * Every browser operation becomes an IPC call to the main; the agent's script
 * only sees the global `orbit` object.
 */
const RUNNER_SOURCE = `'use strict'
const fs = require('node:fs')
const parentPort = process.parentPort

let seq = 0
const pending = new Map()

parentPort.on('message', (event) => {
  const msg = event.data
  if (!msg || msg.type !== 'reply') return
  const entry = pending.get(msg.id)
  if (!entry) return
  pending.delete(msg.id)
  if (msg.error) entry.reject(new Error(msg.error))
  else entry.resolve(msg.value)
})
parentPort.start()

function call(op, args) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    parentPort.postMessage({ type: 'call', id, op, args: args || {} })
  })
}

function asCode(fn, arg) {
  if (typeof fn === 'function') return '(' + fn.toString() + ')(' + JSON.stringify(arg === undefined ? null : arg) + ')'
  return String(fn)
}

const orbit = {
  goto: (url, options) => call('goto', { url, options: options || {} }),
  evaluate: (fn, arg) => call('evaluate', { code: asCode(fn, arg) }),
  capture: (name, options) => call('capture', { name, options: options || {} }),
  waitFor: (selector, options) => call('waitFor', { selector, options: options || {} }),
  resize: (width, height) => call('resize', { width, height }),
  manifest: () => call('manifest', {}),
  console: (options) => call('console', { options: options || {} }),
  hover: (target) => call('hover', { target }),
  drag: (from, to, options) => call('drag', { from, to, options: options || {} }),
  mouseUp: () => call('mouseUp', {}),
  fetch: (url, options) => call('fetch', { url, options: options || {} }),
  save: (name, data, options) => call('save', { name, data, options: options || {} }),
  log: (...parts) => call('log', { message: parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ') }),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

globalThis.orbit = orbit
const nativeLog = console.log
console.log = (...parts) => {
  nativeLog(...parts)
  void orbit.log(...parts).catch(() => {})
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const source = fs.readFileSync(process.argv[2], 'utf8')

;(async () => {
  try {
    const fn = new AsyncFunction('orbit', source)
    const returned = await fn(orbit)
    let safe
    try {
      safe = returned === undefined ? undefined : JSON.parse(JSON.stringify(returned))
    } catch {
      safe = String(returned)
    }
    parentPort.postMessage({ type: 'done', returned: safe })
  } catch (err) {
    parentPort.postMessage({ type: 'done', error: (err && err.stack) || String(err) })
  }
})()
`

interface CallMessage {
  type: 'call'
  id: number
  op: string
  args: Record<string, unknown>
}

interface DoneMessage {
  type: 'done'
  returned?: unknown
  error?: string
}

/** Creates the hidden capture window (used here and by the recording — browser-record). */
export function createHiddenWindow(viewport: { width: number; height: number }): BrowserWindow {
  return new BrowserWindow({
    show: false,
    width: viewport.width,
    height: viewport.height,
    useContentSize: true,
    // Without this Chromium does not paint a window that was never shown and the
    // capturePage comes back blank/black (the classic macOS case).
    paintWhenInitiallyHidden: true,
    webPreferences: {
      partition: BROWSER_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
}

/**
 * Runs an agent script in the hidden engine and returns the manifest of the images.
 * It never throws because of the script — the error comes back in the `error` field.
 */
export async function runBrowserScript(options: RunScriptOptions): Promise<ScriptRunResult> {
  const taskId = safeTaskId(options.taskId)
  const viewport = options.viewport ?? DEFAULT_VIEWPORT
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const source: MediaSource = options.source ?? 'script'

  const taskDir = path.join(scriptsDir(), taskId)
  await fsp.mkdir(taskDir, { recursive: true })
  const scriptFile = path.join(taskDir, 'run.js')
  const runnerFile = path.join(taskDir, 'runner.cjs')
  await fsp.writeFile(scriptFile, options.script, 'utf8')
  await fsp.writeFile(runnerFile, RUNNER_SOURCE, 'utf8')

  const captures: CaptureItem[] = []
  const artifacts: ArtifactItem[] = []
  // Artifacts go to the requested folder (inside the working folder) or, without
  // it, to the task folder — which is then preserved at the end.
  const artifactsBase = options.outDir ? path.resolve(options.outDir) : path.join(taskDir, 'artifacts')
  const logs: string[] = []
  const pushLog = (line: string) => {
    if (logs.length < MAX_LOGS) logs.push(line)
  }

  const win = createHiddenWindow(viewport)
  let timedOut = false
  // Page console: errors also enter the result (the agent sees why
  // a screenshot came out blank without having to ask).
  const pageConsole = new ConsoleBuffer()
  attachConsole(win.webContents, () => pageConsole)
  let heldPointer: { x: number; y: number } | null = null
  /** Script target: CSS selector (string) or { x, y } / { selector }. */
  const toTarget = (raw: unknown): BrowserTarget =>
    typeof raw === 'string' ? { selector: raw } : ((raw ?? {}) as BrowserTarget)
  const point = async (raw: unknown, scroll: boolean) => {
    const resolved = await resolveTarget(win.webContents, toTarget(raw), scroll)
    if (typeof resolved === 'string') throw new Error(resolved)
    return resolved
  }

  const waitForLoad = async () => {
    const deadline = Date.now() + LOAD_TIMEOUT_MS
    while (win.webContents.isLoading() && Date.now() < deadline) await delay(150)
    await delay(400) // lets SPAs hydrate
  }

  /** Captures the viewport (or the whole page, stretching the hidden window). */
  const capture = async (name: string, opts: { fullPage?: boolean; format?: CaptureFormat; maxWidth?: number }) => {
    const format = opts.format ?? 'webp'
    const originalSize = win.getContentSize()
    if (opts.fullPage) {
      const height = (await win.webContents.executeJavaScript(
        `Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0, ${viewport.height})`,
      )) as number
      win.setContentSize(originalSize[0], Math.min(Math.ceil(height), MAX_FULL_PAGE_HEIGHT))
      await delay(400) // repaint at the new height
    }
    try {
      const image = await win.webContents.capturePage()
      let pipeline = sharp(image.toPNG())
      if (opts.maxWidth && image.getSize().width > opts.maxWidth) {
        pipeline = pipeline.resize({ width: opts.maxWidth })
      }
      const buffer =
        format === 'png'
          ? await pipeline.png().toBuffer()
          : format === 'jpeg'
            ? await pipeline.jpeg({ quality: 85 }).toBuffer()
            : await pipeline.webp({ quality: 80 }).toBuffer()
      const meta = await sharp(buffer).metadata()
      const mediaUrl = await saveMedia(buffer, format === 'jpeg' ? 'jpg' : format, {
        source,
        sessionId: options.sessionId,
        taskId,
        name,
      })
      const item: CaptureItem = {
        name,
        mediaUrl,
        width: meta.width ?? 0,
        height: meta.height ?? 0,
        size: buffer.length,
      }
      captures.push(item)
      return item
    } finally {
      if (opts.fullPage) {
        win.setContentSize(originalSize[0], originalSize[1])
        await delay(150)
      }
    }
  }

  const handleCall = async (op: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (op) {
      case 'goto': {
        const url = String(args.url ?? '')
        const opts = (args.options ?? {}) as { viewport?: { width: number; height: number } }
        if (opts.viewport?.width && opts.viewport?.height) {
          win.setContentSize(Math.round(opts.viewport.width), Math.round(opts.viewport.height))
          await delay(200)
        }
        panelActivity(tNow('panel.activity.scriptOpen', { url }))
        try {
          await Promise.race([win.loadURL(url), delay(LOAD_TIMEOUT_MS)])
        } catch (err) {
          // ERR_ABORTED (-3) is normal in SPAs/redirects
          if ((err as { errno?: number }).errno !== -3) throw err
        }
        await waitForLoad()
        return { title: win.webContents.getTitle(), url: win.webContents.getURL() }
      }
      case 'evaluate':
        return await win.webContents.executeJavaScript(String(args.code ?? ''), true)
      case 'capture': {
        const name = String(args.name ?? `shot-${captures.length + 1}`)
        panelActivity(tNow('panel.activity.scriptCapture', { name }))
        return await capture(name, (args.options ?? {}) as { fullPage?: boolean; format?: CaptureFormat; maxWidth?: number })
      }
      case 'waitFor': {
        const selector = String(args.selector ?? '')
        const opts = (args.options ?? {}) as { timeout?: number }
        const deadline = Date.now() + (opts.timeout ?? 10_000)
        while (Date.now() < deadline) {
          const found = (await win.webContents.executeJavaScript(
            `!!document.querySelector(${JSON.stringify(selector)})`,
          )) as boolean
          if (found) return true
          await delay(200)
        }
        throw new Error(`waitFor: selector did not appear within ${opts.timeout ?? 10_000}ms — ${selector}`)
      }
      case 'resize': {
        const width = Math.round(Number(args.width) || viewport.width)
        const height = Math.round(Number(args.height) || viewport.height)
        win.setContentSize(width, height)
        await delay(300)
        return { width, height }
      }
      case 'manifest':
        return captures
      case 'console': {
        const opts = (args.options ?? {}) as { level?: 'all' | 'warning' | 'error'; pattern?: string; limit?: number }
        return pageConsole.query({ limit: 200, ...opts })
      }
      case 'hover': {
        const target = await point(args.target, true)
        mouseMove(win.webContents, target, heldPointer !== null)
        await delay(250)
        return target
      }
      case 'drag': {
        const opts = (args.options ?? {}) as { steps?: number; release?: boolean }
        if (args.from != null && heldPointer) {
          mouseUp(win.webContents, heldPointer)
          heldPointer = null
        }
        const from = args.from != null ? await point(args.from, true) : null
        const to = await point(args.to, false)
        const end = await dragBetween(win.webContents, from, to, { held: heldPointer, ...opts })
        heldPointer = opts.release === false ? end : null
        return end
      }
      case 'mouseUp':
        if (heldPointer) {
          mouseUp(win.webContents, heldPointer)
          heldPointer = null
          await delay(250)
        }
        return true
      case 'log':
        pushLog(String(args.message ?? ''))
        return true
      case 'fetch': {
        // Fetches in the browser session (panel cookies/logins included) —
        // useful for robots.txt, sitemap, JS bundles and authenticated APIs.
        const url = String(args.url ?? '')
        const opts = (args.options ?? {}) as {
          method?: string
          headers?: Record<string, string>
          body?: string
          as?: 'text' | 'json'
        }
        const response = await win.webContents.session.fetch(url, {
          method: opts.method,
          headers: opts.headers,
          body: opts.body,
        })
        const text = await response.text()
        let body: unknown = text
        if (opts.as === 'json') {
          try {
            body = JSON.parse(text)
          } catch {
            body = text
          }
        }
        return {
          status: response.status,
          url: response.url,
          headers: Object.fromEntries(response.headers.entries()),
          body: typeof body === 'string' ? body.slice(0, MAX_FETCH_CHARS) : body,
        }
      }
      case 'save': {
        const name = String(args.name ?? '')
        const opts = (args.options ?? {}) as { format?: 'text' | 'json' | 'base64' }
        const data = args.data
        const target = resolveArtifactPath(artifactsBase, name)
        await fsp.mkdir(path.dirname(target), { recursive: true })
        let buffer: Buffer
        if (opts.format === 'base64') buffer = Buffer.from(String(data ?? ''), 'base64')
        else if (typeof data === 'string') buffer = Buffer.from(data, 'utf8')
        else buffer = Buffer.from(JSON.stringify(data, null, 2) ?? 'null', 'utf8')
        await fsp.writeFile(target, buffer)
        const relative = path.relative(artifactsBase, target).split(path.sep).join('/')
        artifacts.push({ name: relative, path: target, bytes: buffer.length })
        return { path: target, name: relative, bytes: buffer.length }
      }
      default:
        throw new Error(`Unknown operation: ${op}`)
    }
  }

  const child: UtilityProcess = utilityProcess.fork(runnerFile, [scriptFile], { stdio: 'pipe' })
  child.stdout?.on('data', (chunk: Buffer) => pushLog(chunk.toString().trimEnd()))
  child.stderr?.on('data', (chunk: Buffer) => pushLog(`[stderr] ${chunk.toString().trimEnd()}`))

  const outcome = await new Promise<{ returned?: unknown; error?: string }>((resolve) => {
    let settled = false
    const finish = (value: { returned?: unknown; error?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    const timer = setTimeout(() => {
      timedOut = true
      finish({ error: `The script exceeded the ${Math.round(timeoutMs / 1000)}s time limit and was terminated.` })
    }, timeoutMs)

    // Answering a process that is already dead (timeout) throws — the script no longer
    // exists to receive it, and the failure cannot bring the turn down.
    const reply = (payload: Record<string, unknown>) => {
      try {
        child.postMessage({ type: 'reply', ...payload })
      } catch {
        // process already gone
      }
    }

    child.on('message', (message: CallMessage | DoneMessage) => {
      if (!message || typeof message !== 'object') return
      if (message.type === 'done') {
        finish({ returned: message.returned, error: message.error })
        return
      }
      if (message.type !== 'call') return
      const { id, op, args } = message
      void handleCall(op, args ?? {}).then(
        (value) => reply({ id, value }),
        (err: unknown) => reply({ id, error: (err as Error)?.message ?? String(err) }),
      )
    })

    child.on('exit', (code) => {
      finish(code === 0 ? {} : { error: `The script process exited with code ${code}.` })
    })
  })

  try {
    child.kill()
  } catch {
    // already dead
  }
  if (!win.isDestroyed()) win.destroy()
  // The task folder is only deleted when there is no artifact inside it: with
  // outDir, the artifacts are outside and the cleanup still applies.
  if (!options.keep && artifacts.length === 0) {
    await fsp.rm(taskDir, { recursive: true, force: true })
  }

  // Only the page's errors go into the result on their own — the rest the script
  // asks for with orbit.console() when it wants.
  const pageErrors = pageConsole.query({ level: 'error', limit: 20 })
  if (pageErrors.length > 0) {
    pushLog(`[page] ${pageErrors.length} error(s) in the console:\n${formatConsoleEntries(pageErrors)}`)
  }

  return {
    taskId,
    captures,
    artifacts,
    artifactsDir: artifacts.length > 0 ? artifactsBase : undefined,
    logs,
    returned: outcome.returned,
    error: outcome.error,
    timedOut,
  }
}

/** Single capture outside a script (used by panel_screenshot with fullPage). */
export async function captureUrl(options: {
  url: string
  sessionId: string
  fullPage?: boolean
  format?: CaptureFormat
  maxWidth?: number
  viewport?: { width: number; height: number }
}): Promise<Buffer> {
  const viewport = options.viewport ?? DEFAULT_VIEWPORT
  const win = createHiddenWindow(viewport)
  try {
    panelActivity(tNow('panel.activity.fullPage'))
    try {
      await Promise.race([win.loadURL(options.url), delay(LOAD_TIMEOUT_MS)])
    } catch (err) {
      if ((err as { errno?: number }).errno !== -3) throw err
    }
    const deadline = Date.now() + LOAD_TIMEOUT_MS
    while (win.webContents.isLoading() && Date.now() < deadline) await delay(150)
    await delay(400)

    if (options.fullPage) {
      const height = (await win.webContents.executeJavaScript(
        `Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0, ${viewport.height})`,
      )) as number
      win.setContentSize(viewport.width, Math.min(Math.ceil(height), MAX_FULL_PAGE_HEIGHT))
      await delay(400)
    }
    const image = await win.webContents.capturePage()
    let pipeline = sharp(image.toPNG())
    if (options.maxWidth && image.getSize().width > options.maxWidth) {
      pipeline = pipeline.resize({ width: options.maxWidth })
    }
    if (options.format === 'png') return await pipeline.png().toBuffer()
    if (options.format === 'jpeg') return await pipeline.jpeg({ quality: 85 }).toBuffer()
    return await pipeline.webp({ quality: 80 }).toBuffer()
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}
