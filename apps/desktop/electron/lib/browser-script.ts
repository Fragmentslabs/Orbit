import { BrowserWindow, app, utilityProcess, type UtilityProcess } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { saveMedia, type MediaSource } from './media'
import { panelActivity } from './panel-browser'

/**
 * Engine de captura headless do Orbit.
 *
 * O agente escreve um script JS (run_browser_script) ou pede um lote de fotos
 * (capture_batch); os dois rodam aqui. O script do agente NÃO roda no main:
 * vai para um `utilityProcess` (Node do Electron, processo separado), que fala
 * com o main por IPC e controla uma `BrowserWindow` oculta. Assim um laço
 * infinito ou um throw do script não derruba o app — basta matar o processo no
 * timeout.
 *
 * A janela oculta usa a MESMA partition persistente do `<webview>` do painel
 * direito (BROWSER_PARTITION) — cookies, logins e localStorage são
 * compartilhados: o que está logado no painel está logado aqui.
 *
 * Playwright não entra no bundle: a engine é o próprio Chromium do Electron.
 */

/** Sessão persistente compartilhada com o `<webview>` do painel (cookies/logins).
 *  Precisa ser idêntica à BROWSER_PARTITION do renderer (webview-session.ts). */
const BROWSER_PARTITION = 'persist:orbit-browser'

/** Altura máxima de uma captura fullPage (evita estourar memória em páginas infinitas). */
const MAX_FULL_PAGE_HEIGHT = 8000
const DEFAULT_VIEWPORT = { width: 1280, height: 800 }
const DEFAULT_TIMEOUT_MS = 120_000
const LOAD_TIMEOUT_MS = 20_000
const MAX_LOGS = 200

export type CaptureFormat = 'webp' | 'png' | 'jpeg'

export interface CaptureItem {
  name: string
  mediaUrl: string
  width: number
  height: number
  size: number
}

export interface ScriptRunResult {
  taskId: string
  captures: CaptureItem[]
  logs: string[]
  returned?: unknown
  error?: string
  timedOut?: boolean
}

export interface RunScriptOptions {
  script: string
  sessionId: string
  /** Identificador da tarefa — vira a pasta em orbit-data/scripts/<taskId> */
  taskId?: string
  /** Origem registrada nas imagens salvas */
  source?: MediaSource
  /** Preserva a pasta do script após a execução (padrão: apaga) */
  keep?: boolean
  timeoutMs?: number
  viewport?: { width: number; height: number }
}

function scriptsDir(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'scripts')
}

/** taskId seguro para virar nome de pasta (o agente pode mandar qualquer coisa). */
function safeTaskId(raw?: string): string {
  const cleaned = (raw ?? '').replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  if (cleaned) return cleaned
  return `task-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Ponte que roda DENTRO do utilityProcess. Fica aqui como texto porque o main
 * é empacotado num bundle único (vite-plugin-electron) — não há um segundo
 * entry para o processo filho; o arquivo é gerado na pasta da tarefa a cada
 * execução, junto do run.js do agente.
 *
 * Todas as operações de browser viram chamadas IPC para o main; o script do
 * agente só enxerga o objeto global `orbit`.
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

/** Cria a janela oculta de captura. */
function createHiddenWindow(viewport: { width: number; height: number }): BrowserWindow {
  return new BrowserWindow({
    show: false,
    width: viewport.width,
    height: viewport.height,
    useContentSize: true,
    // Sem isto o Chromium não pinta uma janela que nunca foi exibida e o
    // capturePage volta em branco/preto (o caso clássico do macOS).
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
 * Roda um script do agente na engine oculta e devolve o manifesto das imagens.
 * Nunca lança por culpa do script — o erro volta no campo `error`.
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
  const logs: string[] = []
  const pushLog = (line: string) => {
    if (logs.length < MAX_LOGS) logs.push(line)
  }

  const win = createHiddenWindow(viewport)
  let timedOut = false

  const waitForLoad = async () => {
    const deadline = Date.now() + LOAD_TIMEOUT_MS
    while (win.webContents.isLoading() && Date.now() < deadline) await delay(150)
    await delay(400) // deixa SPAs hidratarem
  }

  /** Captura a viewport (ou a página inteira, esticando a janela oculta). */
  const capture = async (name: string, opts: { fullPage?: boolean; format?: CaptureFormat; maxWidth?: number }) => {
    const format = opts.format ?? 'webp'
    const originalSize = win.getContentSize()
    if (opts.fullPage) {
      const height = (await win.webContents.executeJavaScript(
        `Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0, ${viewport.height})`,
      )) as number
      win.setContentSize(originalSize[0], Math.min(Math.ceil(height), MAX_FULL_PAGE_HEIGHT))
      await delay(400) // repaint na nova altura
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
        panelActivity(`Script: abrindo ${url}`)
        try {
          await Promise.race([win.loadURL(url), delay(LOAD_TIMEOUT_MS)])
        } catch (err) {
          // ERR_ABORTED (-3) é normal em SPAs/redirects
          if ((err as { errno?: number }).errno !== -3) throw err
        }
        await waitForLoad()
        return { title: win.webContents.getTitle(), url: win.webContents.getURL() }
      }
      case 'evaluate':
        return await win.webContents.executeJavaScript(String(args.code ?? ''), true)
      case 'capture': {
        const name = String(args.name ?? `shot-${captures.length + 1}`)
        panelActivity(`Script: capturando ${name}`)
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
        throw new Error(`waitFor: seletor não apareceu em ${opts.timeout ?? 10_000}ms — ${selector}`)
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
      case 'log':
        pushLog(String(args.message ?? ''))
        return true
      default:
        throw new Error(`Operação desconhecida: ${op}`)
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
      finish({ error: `O script excedeu o tempo limite de ${Math.round(timeoutMs / 1000)}s e foi encerrado.` })
    }, timeoutMs)

    // Responder um processo já morto (timeout) lança — o script não existe
    // mais para receber, e a falha não pode derrubar o turno.
    const reply = (payload: Record<string, unknown>) => {
      try {
        child.postMessage({ type: 'reply', ...payload })
      } catch {
        // processo encerrado
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
      finish(code === 0 ? {} : { error: `O processo do script terminou com código ${code}.` })
    })
  })

  try {
    child.kill()
  } catch {
    // já morreu
  }
  if (!win.isDestroyed()) win.destroy()
  if (!options.keep) await fsp.rm(taskDir, { recursive: true, force: true })

  return { taskId, captures, logs, returned: outcome.returned, error: outcome.error, timedOut }
}

/** Captura única fora de um script (usada pelo panel_screenshot com fullPage). */
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
    panelActivity('Capturando a página inteira')
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
