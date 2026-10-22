import { BrowserWindow, app } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  ConsoleBuffer,
  attachConsole,
  formatConsoleEntries,
  mouseDown,
  mouseMove,
  mouseUp,
} from './browser-input'
import { DEFAULT_VIEWPORT, createHiddenWindow } from './browser-script'
import { panelActivity } from './panel-browser'
import { tNow } from './i18n'
import { detectMachine } from './machine'
import { runFfmpeg } from './video/ffmpeg'
import {
  describeProfile,
  resolveRecordProfile,
  type RecordPreset,
  type RecordQuality,
} from './video/record-profile'

/**
 * Gravação de um ROTEIRO no browser oculto (tool `browser_record`).
 *
 * A ideia: em vez de filmar o agente trabalhando (que espera o modelo pensar
 * entre cada passo), o roteiro é uma lista de ações que o main executa em
 * sequência — clicar, digitar, rolar, esperar — enquanto o framebuffer da
 * janela oculta é capturado e vira um MP4. O vídeo é determinístico e curto:
 * dura o tempo das ações, não o tempo do raciocínio.
 *
 * Captura em dois modos, escolhidos em tempo de execução:
 *
 * - `screencast` (preferido): CDP `Page.startScreencast` no webContents. O
 *   Chromium emite um JPEG por quadro pintado, com ack obrigatório — é o mesmo
 *   mecanismo do DevTools, barato e com o timing real das animações.
 * - `capturePage` (fallback): se nenhum quadro chegar (janela oculta que não
 *   compõe), um laço chama `webContents.capturePage()` no ritmo do fps. Mais
 *   caro, mas conhecido por funcionar com `paintWhenInitiallyHidden`.
 *
 * Nos dois casos o que se grava são quadros com TIMESTAMP. O vídeo é montado
 * depois: cada quadro vira uma entrada com `duration` no concat demuxer do
 * ffmpeg, que normaliza para fps constante — quadro repetido não custa nada e
 * um trecho parado mantém a última imagem pelo tempo real que durou.
 *
 * O cursor é um elemento injetado NA PÁGINA, posicionado com a MESMA
 * coordenada que o clique usa (`pointFor`): não há conversão entre o desenho e
 * o evento, então ele cai exatamente sobre o alvo por construção. Nas telas em
 * que a página navega, o elemento é reinjetado na ação seguinte.
 */

export type RecordStep =
  | { do: 'goto'; url: string; waitMs?: number }
  | { do: 'click'; selector?: string; text?: string; x?: number; y?: number; waitMs?: number }
  | {
      do: 'type'
      selector?: string
      text?: string
      x?: number
      y?: number
      value: string
      clear?: boolean
      submit?: boolean
      typeDelayMs?: number
      waitMs?: number
    }
  | { do: 'hover'; selector?: string; text?: string; x?: number; y?: number }
  | { do: 'scroll'; dy?: number; to?: 'top' | 'bottom'; selector?: string }
  | { do: 'wait'; ms: number }
  | { do: 'waitFor'; selector: string; timeoutMs?: number }
  | { do: 'press'; key: string }
  | { do: 'move'; x: number; y: number }

export interface RecordOptions {
  sessionId: string
  /** Página inicial — carregada ANTES de começar a gravar (o vídeo abre nela pronta). */
  url?: string
  steps: RecordStep[]
  viewport?: { width: number; height: number }
  /**
   * Perfil de qualidade. `auto` (padrão) segue a máquina — forte grava a 60 fps
   * em qualidade alta. Um nível explícito SEMPRE vence o tier.
   */
  quality?: RecordQuality
  /** Quadros por segundo (10-60). Vence o perfil. */
  fps?: number
  /** Largura final do vídeo (par, em px). Ausente = tamanho capturado. */
  width?: number
  /** Cursor desenhado na página (padrão: true). */
  cursor?: boolean
  /** Quadros parados no fim, para a última transição terminar dentro do vídeo. */
  tailMs?: number
  /** Nome do arquivo (vira o título na galeria). */
  name?: string
  /** Qualidade do x264 (menor = melhor/maior arquivo). Vence o perfil. */
  crf?: number
  /** Preserva a pasta dos quadros (depuração). */
  keepFrames?: boolean
  timeoutMs?: number
  signal?: AbortSignal
}

export interface RecordResult {
  file: string
  durationMs: number
  frames: number
  engine: 'screencast' | 'capturePage'
  /** fps do vídeo final (o que foi pedido/perfil). */
  fps: number
  /**
   * Quadros distintos por segundo que a página produziu. NÃO é a capacidade da
   * máquina: o Chromium só emite quadro quando algo muda, então uma tela
   * parada dá um número baixo e um vídeo perfeito (o fps final é `fps`, com os
   * quadros repetidos pelo encoder).
   */
  capturedFps: number
  /** Perfil resolvido (quality nunca é `auto`). */
  quality: Exclude<RecordQuality, 'auto'>
  crf: number
  /** Tier da máquina usado quando a qualidade foi `auto`. */
  tier: 'weak' | 'balanced' | 'strong'
  steps: number
  logs: string[]
}

export interface FrameMark {
  file: string
  /** Quando o quadro foi recebido (ms, relógio do main). */
  at: number
}

/** Uma entrada do concat demuxer: arquivo + quanto tempo ele fica na tela. */
export interface TimelineEntry {
  file: string
  durationMs: number
}

export interface TimelineOptions {
  /** Fim da gravação (ms) — alimenta a duração do último quadro. */
  endedAt: number
  /** Espera extra no último quadro (a transição final precisa caber no vídeo). */
  tailMs?: number
}

/**
 * Converte quadros com timestamp numa timeline de durações.
 *
 * O vídeo COMEÇA no primeiro quadro (o tempo gasto para a página carregar antes
 * dele não entra) e cada quadro dura até o próximo. Quadros que chegaram
 * juntos ganham o mínimo de 1ms para não gerar `duration 0` no concat.
 */
export function frameTimeline(frames: FrameMark[], options: TimelineOptions): TimelineEntry[] {
  if (frames.length === 0) return []
  const ordered = [...frames].sort((a, b) => a.at - b.at)
  const minMs = 1
  const entries = ordered.map((frame, index) => {
    const next = ordered[index + 1]
    const end = next ? next.at : Math.max(options.endedAt + (options.tailMs ?? 0), frame.at + minMs)
    return { file: frame.file, durationMs: Math.max(minMs, end - frame.at) }
  })
  return entries
}

export function timelineDurationMs(entries: TimelineEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.durationMs, 0)
}

/** Concat demuxer: `file` + `duration` por quadro, com o último repetido
 *  (senão o ffmpeg descarta a duração da última entrada). */
export function concatList(entries: TimelineEntry[]): string {
  const lines = ['ffconcat version 1.0']
  for (const entry of entries) {
    lines.push(`file '${entry.file.replace(/'/g, "'\\''")}'`)
    lines.push(`duration ${(entry.durationMs / 1000).toFixed(4)}`)
  }
  if (entries.length > 0) lines.push(`file '${entries[entries.length - 1].file.replace(/'/g, "'\\''")}'`)
  return `${lines.join('\n')}\n`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function recordingsDir(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'recordings')
}

function safeName(raw?: string): string {
  const cleaned = (raw ?? '')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return cleaned || `rec-${Date.now().toString(36)}`
}

/** Seta do cursor, preta/branca para aparecer em qualquer fundo. */
const CURSOR_SVG =
  '<svg width="22" height="22" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M5 3.2 L5 19.6 L9.3 15.3 L12.2 21.3 L15 20 L12.1 14.2 L18 14.2 Z" ' +
  'fill="#ffffff" stroke="#111111" stroke-width="1.4" stroke-linejoin="round"/></svg>'

/** Cria (se preciso) e move o cursor. `ripple` acende a onda do clique.
 *  Exportado para o teste executar o MESMO código dentro de uma página. */
export function cursorScript(point: { x: number; y: number }, ripple: boolean, enabled: boolean): string {
  const x = Math.round(point.x)
  const y = Math.round(point.y)
  return `(() => {
  if (!${enabled}) return false
  const root = document.body || document.documentElement
  let cursor = document.getElementById('__orbit_cursor')
  if (!cursor) {
    cursor = document.createElement('div')
    cursor.id = '__orbit_cursor'
    cursor.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;pointer-events:none;'
      + 'z-index:2147483647;will-change:transform;transition:transform .2s cubic-bezier(.2,.8,.2,1);'
      + 'filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))'
    cursor.innerHTML = ${JSON.stringify(CURSOR_SVG)}
    root.appendChild(cursor)
  }
  // -4.6/-2.9 é a ponta da seta dentro do viewBox 24×24 desenhado em 22px:
  // assim a PONTA cai no ponto clicado, não o canto do div.
  cursor.style.transform = 'translate3d(' + (${x} - 4.6) + 'px,' + (${y} - 2.9) + 'px,0)'
  if (${ripple}) {
    const ring = document.createElement('div')
    ring.style.cssText = 'position:fixed;left:0;top:0;width:38px;height:38px;'
      + 'margin:-19px 0 0 -19px;border-radius:50%;pointer-events:none;z-index:2147483646;'
      + 'background:radial-gradient(circle,rgba(255,255,255,.9) 0%,rgba(120,170,255,.55) 55%,rgba(120,170,255,0) 72%);'
      + 'transform:translate3d(${x}px,${y}px,0) scale(.3);opacity:.95;'
      + 'transition:transform .42s ease-out,opacity .42s ease-out'
    root.appendChild(ring)
    requestAnimationFrame(() => {
      ring.style.transform = 'translate3d(${x}px,${y}px,0) scale(1)'
      ring.style.opacity = '0'
    })
    setTimeout(() => ring.remove(), 700)
  }
  return true
})()`
}

interface PointTarget {
  selector?: string
  text?: string
  x?: number
  y?: number
}

/**
 * Ponto (px CSS da viewport) de um alvo: coordenadas cruas, seletor CSS ou
 * texto visível. Rola o elemento para o centro ANTES de medir — a medida e o
 * clique usam exatamente o mesmo número.
 */
export function pointScript(target: PointTarget): string {
  const t = JSON.stringify(target)
  return `(() => {
  const T = ${t}
  if (typeof T.x === 'number' && typeof T.y === 'number') return { x: T.x, y: T.y }
  const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim().toLowerCase()
  let el = null
  if (T.selector) {
    el = document.querySelector(T.selector)
    if (!el) return { error: 'element not found: ' + T.selector }
  } else {
    const want = norm(T.text)
    if (!want) return { error: 'provide selector, text or x/y' }
    const sel = 'a,button,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],'
      + 'input:not([type="hidden"]),select,textarea,label,summary,li,h1,h2,h3,h4,h5,p,span,div'
    let bestEl = null
    let bestScore = 0
    let bestArea = Infinity
    for (const candidate of document.querySelectorAll(sel)) {
      const rect = candidate.getBoundingClientRect()
      if (rect.width < 4 || rect.height < 4) continue
      const hits = [
        norm(candidate.textContent),
        norm(candidate.getAttribute('aria-label')),
        norm(candidate.getAttribute('placeholder')),
        norm(candidate.getAttribute('title')),
        norm(candidate.value),
      ]
      let score = 0
      for (const hit of hits) {
        if (!hit) continue
        if (hit === want) { score = 4; break }
        if (hit.includes(want)) score = Math.max(score, hit.length <= want.length + 24 ? 3 : 2)
      }
      if (!score) continue
      const area = rect.width * rect.height
      if (score > bestScore || (score === bestScore && area < bestArea)) {
        bestEl = candidate
        bestScore = score
        bestArea = area
      }
    }
    if (!bestEl) return { error: 'no element matching the text: ' + T.text }
    el = bestEl
  }
  el.scrollIntoView({ block: 'center', inline: 'center' })
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
})()`
}

/** Texto curto para o log/atividade: "click «Entrar»". */
function describeStep(step: RecordStep): string {
  switch (step.do) {
    case 'goto':
      return `goto ${step.url}`
    case 'click':
      return `click ${step.selector ?? (step.text ? `"${step.text}"` : `${step.x},${step.y}`)}`
    case 'type':
      return `type ${step.selector ?? (step.text ? `"${step.text}"` : `${step.x},${step.y}`)}`
    case 'hover':
      return `hover ${step.selector ?? (step.text ? `"${step.text}"` : `${step.x},${step.y}`)}`
    case 'scroll':
      return `scroll ${step.to ?? `${step.dy ?? 600}px`}`
    case 'wait':
      return `wait ${step.ms}ms`
    case 'waitFor':
      return `waitFor ${step.selector}`
    case 'press':
      return `press ${step.key}`
    case 'move':
      return `move ${step.x},${step.y}`
  }
}

/** Espera o carregamento terminar e dá um tempo para SPA hidratar. */
async function settle(win: BrowserWindow, graceMs = 300): Promise<void> {
  const deadline = Date.now() + 15_000
  while (win.webContents.isLoading() && Date.now() < deadline) await delay(120)
  await delay(graceMs)
}

async function scrollSettle(win: BrowserWindow): Promise<void> {
  let last = Number.NaN
  let stable = 0
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const y = (await win.webContents.executeJavaScript('window.scrollY', true).catch(() => 0)) as number
    if (y === last) {
      stable += 1
      if (stable >= 3) return
    } else {
      stable = 0
      last = y
    }
    await delay(80)
  }
}

/**
 * Gravador de quadros. Um dos dois modos, escolhido na partida: se o screencast
 * não entregar o primeiro quadro em `PROBE_MS`, cai no laço de `capturePage`.
 */
class FrameRecorder {
  private frames: FrameMark[] = []
  private seq = 0
  private dir: string
  private writing: Promise<void> = Promise.resolve()
  private startedAt = 0
  private stoppedAt = 0
  private mode: 'screencast' | 'capturePage' = 'screencast'
  private loopTimer: NodeJS.Timeout | null = null
  private loopStopped = false
  private failing = 0
  private readonly PROBE_MS = 600

  constructor(
    private readonly win: BrowserWindow,
    private readonly options: { dir: string; fps: number; quality: number; maxWidth: number; maxHeight: number },
  ) {
    this.dir = options.dir
  }

  get engine(): 'screencast' | 'capturePage' {
    return this.mode
  }

  get count(): number {
    return this.frames.length
  }

  async start(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true })
    this.startedAt = Date.now()
    try {
      await this.startScreencast()
      const works = await this.waitForFirstFrame(this.PROBE_MS)
      if (works) return
      await this.stopScreencast()
    } catch {
      // CDP indisponível nesta página/Electron: segue para o capturePage
    }
    this.mode = 'capturePage'
    this.startCaptureLoop()
  }

  private async startScreencast(): Promise<void> {
    const dbg = this.win.webContents.debugger
    if (!dbg.isAttached()) dbg.attach('1.3')
    dbg.on('message', (_event, method, params) => {
      if (method !== 'Page.screencastFrame') return
      const frame = params as { data: string; sessionId: number }
      const at = Date.now()
      const file = path.join(this.dir, `f${String(++this.seq).padStart(5, '0')}.jpg`)
      this.frames.push({ file, at })
      // Grava em série e faz o ack imediatamente: esperar o disco antes do ack
      // faz o Chromium parar de emitir quadros.
      this.writing = this.writing
        .then(() => fsp.writeFile(file, Buffer.from(frame.data, 'base64')))
        .catch(() => undefined)
      void dbg.sendCommand('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined)
    })
    await dbg.sendCommand('Page.enable')
    await dbg.sendCommand('Page.startScreencast', {
      format: 'jpeg',
      quality: this.options.quality,
      maxWidth: this.options.maxWidth,
      maxHeight: this.options.maxHeight,
      everyNthFrame: 1,
    })
  }

  private async waitForFirstFrame(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.frames.length > 0) return true
      await delay(40)
    }
    return this.frames.length > 0
  }

  private async stopScreencast(): Promise<void> {
    const dbg = this.win.webContents.debugger
    if (!dbg.isAttached()) return
    await dbg.sendCommand('Page.stopScreencast').catch(() => undefined)
    try {
      dbg.detach()
    } catch {
      // já desanexado
    }
  }

  private startCaptureLoop(): void {
    const budget = Math.max(16, Math.round(1000 / this.options.fps))
    const tick = async () => {
      if (this.loopStopped) return
      const started = Date.now()
      try {
        const image = await this.win.webContents.capturePage()
        const file = path.join(this.dir, `f${String(++this.seq).padStart(5, '0')}.png`)
        await fsp.writeFile(file, image.toPNG())
        this.frames.push({ file, at: Date.now() })
        this.failing = 0
      } catch {
        // Janela destruída/fechando: duas falhas seguidas encerram o laço.
        this.failing += 1
        if (this.failing >= 2) return
      }
      const elapsed = Date.now() - started
      this.loopTimer = setTimeout(tick, Math.max(0, budget - elapsed))
    }
    void tick()
  }

  async stop(): Promise<void> {
    this.stoppedAt = Date.now()
    this.loopStopped = true
    if (this.loopTimer) clearTimeout(this.loopTimer)
    if (this.mode === 'screencast') await this.stopScreencast()
    await this.writing
  }

  /** Timeline final, já com a cauda pedida. */
  timeline(tailMs: number): TimelineEntry[] {
    return frameTimeline(this.frames, { endedAt: this.stoppedAt || Date.now(), tailMs })
  }

  get firstAt(): number {
    return this.frames[0]?.at ?? this.startedAt
  }

  /** Quando a gravação parou — ancora a duração do último quadro. */
  get endedAt(): number {
    return this.stoppedAt
  }
}

/** Codifica os quadros em MP4 (H.264, yuv420p, faststart). */
async function encodeFrames(
  entries: TimelineEntry[],
  output: string,
  opts: { fps: number; width?: number; crf: number; preset: RecordPreset },
): Promise<void> {
  const listFile = `${output}.concat.txt`
  await fsp.writeFile(listFile, concatList(entries), 'utf8')
  const width = opts.width && opts.width > 0 ? Math.round(opts.width / 2) * 2 : 0
  // `in_range=full:out_range=tv` é obrigatório, não enfeite: os quadros vêm de
  // JPEG/PNG, que são faixa COMPLETA (0-255). Sem a conversão, o ffmpeg marca o
  // H.264 como `yuvj420p` e players que ignoram essa flag (QuickTime entre
  // eles) mostram o vídeo lavado. O `-pix_fmt yuv420p` sozinho NÃO resolve —
  // quem manda é a conversão de range no scale.
  const range = 'in_range=full:out_range=tv'
  const scale = width
    ? `scale=${width}:-2:flags=lanczos:${range},format=yuv420p`
    : `scale=trunc(iw/2)*2:trunc(ih/2)*2:${range},format=yuv420p`
  try {
    await runFfmpeg(
      [
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listFile,
        '-fps_mode',
        'cfr',
        '-r',
        String(opts.fps),
        '-vf',
        scale,
        '-c:v',
        'libx264',
        '-preset',
        opts.preset,
        '-crf',
        String(opts.crf),
        '-movflags',
        '+faststart',
        '-an',
        output,
      ],
      // Sem `signal`: o encode de poucos segundos não deve ser abortado no meio
      // (o sinal já foi consumido no roteiro, e um MP4 truncado seria pior).
    )
  } finally {
    await fsp.rm(listFile, { force: true })
  }
}

/**
 * Roda o roteiro e devolve o MP4. Diferente de `runBrowserScript`, o script
 * NÃO é JS livre: são passos declarativos, para o vídeo ser previsível.
 */
export async function recordBrowserScript(options: RecordOptions): Promise<RecordResult> {
  const viewport = options.viewport ?? DEFAULT_VIEWPORT
  // A máquina decide o PADRÃO; um nível pedido explicitamente manda mais que ela.
  const machine = detectMachine()
  const profile = resolveRecordProfile(
    { quality: options.quality, fps: options.fps, crf: options.crf },
    machine.tier,
  )
  const fps = profile.fps
  const timeoutMs = options.timeoutMs ?? 180_000
  const deadline = Date.now() + timeoutMs
  const logs: string[] = []
  const pushLog = (line: string) => {
    if (logs.length < 200) logs.push(line)
  }

  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const framesDir = path.join(recordingsDir(), `frames-${stamp}`)
  const name = safeName(options.name)
  const output = path.join(recordingsDir(), `${name}-${stamp}.mp4`)

  const win = createHiddenWindow(viewport)
  const pageConsole = new ConsoleBuffer()
  attachConsole(win.webContents, () => pageConsole)

  const checkAbort = () => {
    if (options.signal?.aborted) throw new Error('recording cancelled')
    if (Date.now() > deadline) {
      throw new Error(`the scripted recording exceeded ${Math.round(timeoutMs / 1000)}s`)
    }
  }

  const evaluate = async <T>(code: string): Promise<T> => {
    return (await win.webContents.executeJavaScript(code, true)) as T
  }

  const pointFor = async (target: PointTarget): Promise<{ x: number; y: number }> => {
    const result = await evaluate<{ x?: number; y?: number; error?: string }>(pointScript(target))
    if (result?.error) throw new Error(result.error)
    if (typeof result?.x !== 'number' || typeof result?.y !== 'number') throw new Error('could not resolve the target')
    return { x: result.x, y: result.y }
  }

  const showCursor = async (point: { x: number; y: number }, ripple = false) => {
    await evaluate(cursorScript(point, ripple, options.cursor !== false)).catch(() => false)
  }

  const goto = async (url: string) => {
    panelActivity(tNow('panel.activity.scriptOpen', { url }))
    try {
      await Promise.race([win.loadURL(url), delay(20_000)])
    } catch (err) {
      // ERR_ABORTED (-3) é normal em SPA/redirect
      if ((err as { errno?: number }).errno !== -3) throw err
    }
    await settle(win, 400)
  }

  /** Põe o cursor no canto de descanso para a primeira ação ser um movimento. */
  const restCursor = async () => {
    if (options.cursor === false) return
    await showCursor({ x: viewport.width * 0.68, y: viewport.height * 0.64 })
  }

  const press = async (key: string) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key })
    if (key.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode: key })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key })
  }

  let recorder: FrameRecorder | null = null
  let ran = 0
  let error: string | undefined

  try {
    // Preparação FORA do vídeo: carregar a página inicial e um `goto` que seja
    // o primeiro passo. O vídeo abre na página pronta, sem tela branca.
    if (options.url) await goto(options.url)
    let start = 0
    if (options.steps[0]?.do === 'goto') {
      await goto(options.steps[0].url)
      start = 1
    }
    await restCursor()

    // Teto do screencast = o do perfil, limitado pelo tamanho real da janela em
    // pixels de device (2x num Retina). A altura acompanha o aspecto para o
    // Chromium não cortar a imagem ao reduzir.
    const capWidth = Math.min(profile.maxWidth, Math.round(viewport.width * 2))
    const capHeight = Math.min(
      Math.round(capWidth / (viewport.width / viewport.height)),
      Math.round(viewport.height * 2),
    )
    recorder = new FrameRecorder(win, {
      dir: framesDir,
      fps,
      quality: profile.jpegQuality,
      maxWidth: capWidth,
      maxHeight: capHeight,
    })
    await recorder.start()
    panelActivity(tNow('panel.activity.recordStart', { url: win.webContents.getURL() || 'about:blank' }))
    pushLog(`engine: ${recorder.engine} · ${describeProfile(profile, machine.tier)}`)
    pushLog(
      `máquina: ${machine.tier} · ${machine.cpus} núcleos · ${machine.totalMemGb} GB · ${machine.arch}`,
    )

    for (let index = start; index < options.steps.length; index += 1) {
      checkAbort()
      const step = options.steps[index]
      panelActivity(tNow('panel.activity.recordStep', { label: describeStep(step) }))
      switch (step.do) {
        case 'goto':
          await goto(step.url)
          await restCursor()
          if (step.waitMs) await delay(step.waitMs)
          break
        case 'click': {
          const point = await pointFor(step)
          await showCursor(point)
          await delay(230) // a transição do cursor termina antes do clique
          await showCursor(point, true)
          mouseDown(win.webContents, point)
          await delay(60)
          mouseUp(win.webContents, point)
          await settle(win, step.waitMs ?? 320)
          break
        }
        case 'type': {
          const point = await pointFor(step)
          await showCursor(point)
          await delay(230)
          mouseDown(win.webContents, point)
          await delay(50)
          mouseUp(win.webContents, point)
          await delay(140)
          if (step.clear) {
            const modifier = process.platform === 'darwin' ? 'meta' : 'control'
            win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'a', modifiers: [modifier] })
            win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'a', modifiers: [modifier] })
            await delay(60)
          }
          const typingDelay = Math.min(120, Math.max(0, step.typeDelayMs ?? 40))
          for (const char of step.value) {
            win.webContents.insertText(char)
            if (typingDelay) await delay(typingDelay)
          }
          if (step.submit) {
            await delay(120)
            await press('Enter')
          }
          await settle(win, step.waitMs ?? 260)
          break
        }
        case 'hover': {
          const point = await pointFor(step)
          await showCursor(point)
          mouseMove(win.webContents, point)
          await delay(350)
          break
        }
        case 'scroll': {
          if (step.selector) {
            await evaluate(
              `(() => { const el = document.querySelector(${JSON.stringify(step.selector)}); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); return !!el })()`,
            )
          } else if (step.to === 'top') {
            await evaluate(`window.scrollTo({ top: 0, behavior: 'smooth' })`)
          } else if (step.to === 'bottom') {
            await evaluate(
              `window.scrollTo({ top: Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0), behavior: 'smooth' })`,
            )
          } else {
            await evaluate(`window.scrollBy({ top: ${Math.round(step.dy ?? 600)}, behavior: 'smooth' })`)
          }
          await scrollSettle(win)
          await delay(200)
          break
        }
        case 'wait':
          await delay(Math.max(0, step.ms))
          break
        case 'waitFor': {
          const limit = Date.now() + Math.min(step.timeoutMs ?? 10_000, 30_000)
          let found = false
          while (Date.now() < limit) {
            found = (await evaluate<boolean>(`!!document.querySelector(${JSON.stringify(step.selector)})`).catch(
              () => false,
            )) as boolean
            if (found) break
            await delay(150)
          }
          if (!found) throw new Error(`waitFor: selector never appeared — ${step.selector}`)
          await delay(120)
          break
        }
        case 'press':
          await press(step.key)
          await settle(win, 200)
          break
        case 'move': {
          const point = { x: step.x, y: step.y }
          await showCursor(point)
          await delay(240)
          break
        }
      }
      ran += 1
    }

    // Segura o último quadro para a animação final caber no vídeo.
    await delay(Math.max(0, options.tailMs ?? 500))
    checkAbort()
  } catch (err) {
    error = (err as Error)?.message ?? String(err)
  } finally {
    if (recorder) {
      try {
        await recorder.stop()
      } catch {
        // janela fechando
      }
    }
    if (!win.isDestroyed()) win.destroy()
  }

  if (!recorder || recorder.count === 0) {
    if (!options.keepFrames) await fsp.rm(framesDir, { recursive: true, force: true })
    throw new Error(error ?? 'no frames were captured — the page may never have painted')
  }
  if (error) pushLog(`aviso: ${error}`)

  // A cauda JÁ está nos quadros: o `delay` acima manteve a gravação rodando
  // depois da última ação, e a timeline mede isso por `endedAt`. Somar a cauda
  // de novo aqui daria o dobro do tempo parado no fim.
  const entries = recorder.timeline(0)
  if (entries.length === 0) throw new Error('no frames were captured')

  panelActivity(tNow('panel.activity.recordSave'))
  await fsp.mkdir(recordingsDir(), { recursive: true })
  await encodeFrames(entries, output, {
    fps,
    width: options.width,
    crf: profile.crf,
    preset: profile.preset,
  })

  if (!options.keepFrames) await fsp.rm(framesDir, { recursive: true, force: true })

  const pageErrors = pageConsole.query({ level: 'error', limit: 10 })
  if (pageErrors.length > 0) pushLog(`[página] ${pageErrors.length} erro(s) no console:\n${formatConsoleEntries(pageErrors)}`)

  // Quanto a máquina entregou de fato: `count` sobre o intervalo em que os
  // quadros chegaram (não sobre a duração do vídeo, que inclui as repetições).
  const span = Math.max(1, recorder.endedAt - recorder.firstAt)
  return {
    file: output,
    durationMs: timelineDurationMs(entries),
    frames: recorder.count,
    engine: recorder.engine,
    fps,
    capturedFps: Math.round((recorder.count / (span / 1000)) * 10) / 10,
    quality: profile.quality,
    crf: profile.crf,
    tier: machine.tier,
    steps: ran,
    logs,
  }
}
