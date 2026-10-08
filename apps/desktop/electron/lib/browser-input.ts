import type { WebContents } from 'electron'

/**
 * Entrada "de verdade" para os browsers do agente (webview do painel e janela
 * oculta do run_browser_script): mouse via `sendInputEvent`, console da página
 * e avaliação de JS.
 *
 * O `el.click()` do panel_click basta para botões, mas arrastar (dnd-kit,
 * sortables, sliders) e hover dependem de pointer events confiáveis numa
 * sequência — down, vários moves, up. `sendInputEvent` entra pelo mesmo
 * caminho do mouse físico (isTrusted = true), então as bibliotecas reagem como
 * reagiriam a um usuário.
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

/** Buffer circular de mensagens do console de um WebContents. */
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

/** Página inline (data:/blob:) traria o HTML inteiro como "arquivo" da mensagem. */
function shortSource(source: string): string {
  if (source.startsWith('data:')) return 'data:…'
  return source.length > 160 ? `…${source.slice(-160)}` : source
}

/**
 * Liga o console (e as falhas de carga/crash) do WebContents ao buffer. Erros
 * não capturados e promises rejeitadas chegam aqui também: o Chromium os
 * registra no console como `error`.
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
    // ERR_ABORTED (-3) é redirect/SPA, não falha
    if (code === -3) return
    sink()?.push({
      level: 'error',
      message: `Falha ao carregar ${isMainFrame ? 'a página' : 'um frame'} ${url}: ${description} (${code})`,
    })
  })
  wc.on('did-start-navigation', (event) => {
    if (!event.isMainFrame || event.isSameDocument) return
    sink()?.push({ level: 'info', message: `── navegou para ${event.url} ──` })
  })
  wc.on('render-process-gone', (_event, details) => {
    sink()?.push({ level: 'error', message: `O processo da página caiu (${details.reason}, código ${details.exitCode})` })
  })
}

// ─── JavaScript ─────────────────────────────────────────────────────────────

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => unknown

/**
 * Semântica de REPL: uma expressão sozinha devolve o próprio valor; código com
 * várias instruções precisa de `return`. O teste só PARSEIA o código aqui no
 * main (construir a função não a executa) — rodar `new Function` dentro da
 * página esbarraria na CSP de muitos sites.
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

/** Roda JS na página e devolve o resultado serializado (ou o erro, com stack). */
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
    return `Erro ao executar: ${(err as Error)?.message ?? String(err)}`
  }
  if (outcome === TIMED_OUT) return `O código não terminou em ${EVAL_TIMEOUT_MS / 1000}s (promise pendente ou laço longo).`
  if (outcome && typeof outcome === 'object' && '__orbitError' in outcome) {
    return `Erro na página:\n${String((outcome as { __orbitError: string }).__orbitError).slice(0, 4000)}`
  }
  const text = String(outcome)
  return text.length > MAX_EVAL_CHARS ? `${text.slice(0, MAX_EVAL_CHARS)}\n… (cortado em ${MAX_EVAL_CHARS} caracteres)` : text
}

// ─── Mouse ──────────────────────────────────────────────────────────────────

/**
 * Converte o alvo (ref do panel_read, seletor CSS ou coordenadas) num ponto da
 * viewport, em px CSS. `scroll` traz o elemento para a tela antes — só vale
 * para o ponto de partida: rolar no meio de um arrasto mudaria o destino.
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
  if (!finder) return 'Informe ref, selector ou x/y.'
  const point = (await wc.executeJavaScript(`(() => {
    const el = ${finder}
    if (!el) return null
    ${scroll ? "el.scrollIntoView({ block: 'center', inline: 'center' })" : ''}
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)) as { x: number; y: number } | null
  if (!point) {
    return `Elemento não encontrado (${target.ref != null ? `ref=${target.ref}` : target.selector}). Rode panel_read para atualizar as refs.`
  }
  return point
}

/** px CSS → coordenadas do sendInputEvent (que respeitam o zoom da página). */
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
 * Arrasta com o botão esquerdo. `from` ausente continua um arrasto anterior
 * que ficou com o botão pressionado (release: false) — é assim que o agente
 * pausa no meio para tirar print do estado "arrastando".
 * Devolve onde o ponteiro terminou.
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
    if (!options.held) throw new Error('Nenhum arrasto em andamento — informe from.')
    start = options.held
  }
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps
    mouseMove(wc, { x: start.x + (to.x - start.x) * t, y: start.y + (to.y - start.y) * t }, true)
    await delay(16)
  }
  // Muitas libs só confirmam o alvo no frame seguinte ao último move
  await delay(80)
  if (options.release !== false) {
    mouseUp(wc, to)
    await delay(250) // animação de soltar / re-render
  }
  return to
}
