import { BrowserWindow } from 'electron'
import path from 'node:path'
import { capturePageReliably } from './capture'
import { MOTION_SPEC } from './motion-runtime'
import { prepareMotionPreview } from './motion-preview'

/**
 * A olhada BARATA numa composição de motion: em vez de renderizar o clipe
 * inteiro para saber como ele está, captura só os instantes pedidos e devolve
 * uma folha de contato (webp) com o tempo e o número do quadro em cada célula.
 *
 * UMA janela offscreen serve a composição pelo scheme `orbit-motion://` (o mesmo
 * do preview) e dá seek em cada instante, na ordem pedida — sem ffmpeg e sem
 * vídeo: milissegundos, não segundos. É o degrau entre o preview (a aba do
 * painel, para o humano) e o render final.
 *
 * Irmão do motion-preview: a conversão tempo→quadro e a geometria da folha são
 * PURAS (testadas sem Electron); só `captureMotionFrames` toca na janela.
 */

/** Teto de instantes por folha: é uma olhada, não uma varredura do clipe. */
export const MAX_FRAME_TIMES = 8

/** Largura da folha (a mesma do video_timeline) e geometria das células. */
const SHEET_WIDTH = 1600
const SHEET_PAD = 12
const SHEET_GAP = 10
const SHEET_HEADER = 26
/** Faixa do rótulo, sobreposta no rodapé da célula. */
const LABEL_HEIGHT = 20

// ----------------------------------------------------------- tempo → quadro

/**
 * Converte os instantes pedidos (em SEGUNDOS) em quadros INTEIROS, validando:
 * 1 a MAX_FRAME_TIMES instantes, cada um finito e > 0 e — quando a duração da
 * composição é conhecida — dentro dela. O arredondamento é o mesmo do runtime
 * (quadro mais próximo) e o resultado fica preso em [0, durationInFrames-1]:
 * pedir 4 s de um clipe de 4 s devolve o ÚLTIMO quadro, não um quadro que não
 * existe. Um instante além do fim é erro (com o máximo, para o agente se
 * corrigir).
 */
export function framesFromTimes(times: number[], opts: { fps: number; durationInFrames?: number }): number[] {
  const { fps, durationInFrames } = opts
  if (!Number.isFinite(fps) || fps <= 0) throw new Error(`invalid fps: ${fps}`)
  if (!Array.isArray(times) || times.length === 0) throw new Error('pass at least one instant, in seconds')
  if (times.length > MAX_FRAME_TIMES) {
    throw new Error(`at most ${MAX_FRAME_TIMES} instants per sheet (got ${times.length})`)
  }
  // A duração em segundos é durationInFrames / fps: um instante no fim exato do
  // clipe é aceito e cai no último quadro.
  const maxSeconds = durationInFrames && durationInFrames > 0 ? durationInFrames / fps : Infinity
  return times.map((seconds) => {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
      throw new Error(`invalid instant: ${seconds} — pass seconds greater than 0`)
    }
    if (seconds > maxSeconds) {
      throw new Error(
        `instant ${seconds}s is past the end of the composition (${maxSeconds.toFixed(2)}s max at ${fps} fps)`,
      )
    }
    const frame = Math.round(seconds * fps)
    return durationInFrames && durationInFrames > 0 ? Math.min(frame, durationInFrames - 1) : Math.max(0, frame)
  })
}

// -------------------------------------------------------- geometria da folha

/**
 * Colunas da grade: 1 instante ocupa a folha, 2 a 4 vão em duas colunas e 5 a 8
 * em quatro — a célula fica grande o bastante para julgar o quadro.
 */
export function sheetColumns(count: number): number {
  if (count <= 1) return 1
  if (count <= 4) return 2
  return 4
}

export interface SheetGeometry {
  width: number
  height: number
  columns: number
  rows: number
  cellWidth: number
  cellHeight: number
  pad: number
  gap: number
  header: number
}

/** Grade da folha: `count` células de `aspect` dentro de `width` px. Pura. */
export function sheetLayout(input: { count: number; aspect?: number; width?: number; columns?: number }): SheetGeometry {
  const count = Math.max(1, Math.floor(input.count) || 1)
  const width = input.width ?? SHEET_WIDTH
  const aspect = input.aspect && Number.isFinite(input.aspect) && input.aspect > 0 ? input.aspect : 16 / 9
  const columns = input.columns ?? sheetColumns(count)
  const rows = Math.ceil(count / columns)
  const cellWidth = (width - SHEET_PAD * 2 - SHEET_GAP * (columns - 1)) / columns
  const cellHeight = cellWidth / aspect
  return {
    width,
    height: Math.round(SHEET_PAD * 2 + SHEET_HEADER + rows * cellHeight + SHEET_GAP * (rows - 1)),
    columns,
    rows,
    cellWidth,
    cellHeight,
    pad: SHEET_PAD,
    gap: SHEET_GAP,
    header: SHEET_HEADER,
  }
}

/** Retângulo da célula `index` (a imagem; o rótulo vai sobreposto no rodapé). */
export function sheetCell(geometry: SheetGeometry, index: number): { x: number; y: number; width: number; height: number } {
  const column = index % geometry.columns
  const row = Math.floor(index / geometry.columns)
  return {
    x: Math.round(geometry.pad + column * (geometry.cellWidth + geometry.gap)),
    y: Math.round(geometry.pad + geometry.header + row * (geometry.cellHeight + geometry.gap)),
    width: Math.round(geometry.cellWidth),
    height: Math.round(geometry.cellHeight),
  }
}

/**
 * Rótulo da célula: o tempo *pedido* (não o do quadro arredondado — o agente
 * precisa reconhecer o instante que ele mesmo escolheu) e o quadro inteiro em
 * que ele caiu.
 */
export function frameLabel(timeMs: number, frame: number): string {
  return `${(timeMs / 1000).toFixed(2)}s · f${frame}`
}

/**
 * Nome do arquivo da folha, a partir da pasta da composição: o que não é seguro
 * em nome de arquivo vira '-', separadores repetidos viram um só (nada de
 * "aaa---bbb") e o nome não pode começar nem terminar em ponto ou hífen — no
 * Windows isso criaria arquivo invisível ou inválido.
 */
export function sheetFileName(name: string): string {
  const base = (name ?? '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return `${base || 'motion'}.webp`
}

// ------------------------------------------------------------ folha (canvas)

export interface FrameShot {
  /** Quadro capturado na janela (PNG). */
  png: Buffer
  /** Instante pedido, em ms. */
  timeMs: number
  /** Quadro inteiro capturado. */
  frame: number
}

export interface FrameSheet {
  /** Nome da composição — vira o cabeçalho da folha. */
  title: string
  fps: number
  durationInFrames?: number
  shots: FrameShot[]
}

/**
 * Monta a folha de contato (webp) com `@napi-rs/canvas` — a mesma biblioteca do
 * video_timeline. Uma célula por instante, na ordem pedida, com o tempo e o
 * quadro impressos nela; o cabeçalho diz de que composição e de que formato é a
 * folha.
 */
export async function renderFrameSheet(sheet: FrameSheet): Promise<Buffer> {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas')
  const images = await Promise.all(sheet.shots.map((shot) => loadImage(shot.png)))
  const first = images[0]
  if (!first) throw new Error('no frames to draw')
  const geometry = sheetLayout({ count: images.length, aspect: first.width / first.height })
  const canvas = createCanvas(geometry.width, geometry.height)
  const g = canvas.getContext('2d')

  g.fillStyle = '#111317'
  g.fillRect(0, 0, geometry.width, geometry.height)

  g.fillStyle = '#9aa0aa'
  g.font = '16px sans-serif'
  const total = sheet.durationInFrames ? ` · ${sheet.durationInFrames} frames` : ''
  g.fillText(`${sheet.title} · ${sheet.fps} fps${total}`, geometry.pad, geometry.pad + 17)

  sheet.shots.forEach((shot, i) => {
    const cell = sheetCell(geometry, i)
    g.drawImage(images[i], cell.x, cell.y, cell.width, cell.height)
    const label = frameLabel(shot.timeMs, shot.frame)
    g.font = '13px sans-serif'
    const width = Math.ceil(g.measureText(label).width) + 10
    g.fillStyle = 'rgba(0,0,0,0.65)'
    g.fillRect(cell.x, cell.y + cell.height - LABEL_HEIGHT, Math.min(width, cell.width), LABEL_HEIGHT)
    g.fillStyle = '#e6e6e6'
    g.fillText(label, cell.x + 5, cell.y + cell.height - 5)
  })

  return canvas.encode('webp', 82)
}

// -------------------------------------------------------------- captura

/** Foto do estado da composição publicada pelo runtime (ver MOTION_SPEC). */
interface MotionPageSpec {
  width?: number
  height?: number
  fps?: number
  durationInFrames?: number
  failedFonts?: string[]
}

/** O runtime expõe o seek por accessor; sem ele, não há o que capturar. */
const BRIDGE_CHECK = '!!(window.orbitMotion && typeof window.orbitMotion.seek === "function")'

export interface MotionFrameRequest {
  /** Alvo já resolvido (absoluto): o .html de entrada ou a pasta dele. */
  target: string
  /** Instantes em SEGUNDOS, na ordem em que devem ser capturados. */
  times: number[]
  /** Pasta de trabalho que registra a composição e a sessão. */
  root?: string
  sessionId?: string
  signal?: AbortSignal
}

export interface MotionFrameResult {
  /** Folha de contato (webp). */
  image: Buffer
  /** Nome da composição (a pasta dela) — o cabeçalho da folha. */
  name: string
  /** Entrada servida e a URL do scheme de onde ela veio. */
  file: string
  url: string
  fps: number
  durationInFrames: number
  /** Tamanho capturado (o que a janela pintou), útil para julgar o enquadramento. */
  width: number
  height: number
  /** Fontes que falharam (o texto caiu no fallback, em silêncio). */
  failedFonts: string[]
  /** Um por instante pedido, na MESMA ordem. */
  cells: { timeMs: number; frame: number }[]
}

/**
 * Captura os instantes pedidos numa única janela offscreen e devolve a folha.
 * O formato (fps, duração, tamanho) é o que a própria composição declarou — lido
 * do runtime, o mesmo que o render usa, então a folha mostra o que o render
 * produziria naqueles quadros.
 */
export async function captureMotionFrames(req: MotionFrameRequest): Promise<MotionFrameResult> {
  const preview = await prepareMotionPreview(req.target, { root: req.root, sessionId: req.sessionId })
  const win = new BrowserWindow({
    show: false,
    width: 1920,
    height: 1080,
    useContentSize: true,
    frame: false,
    backgroundColor: '#000000',
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  // A composição é uma página de vídeo, não um navegador: nada de sair dela.
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const onAbort = () => {
    if (!win.isDestroyed()) win.destroy()
  }
  req.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    // O runtime entra como PRIMEIRO script do <head> — é o protocolo do scheme
    // que serve a entrada (o mesmo caminho do preview).
    await win.loadURL(preview.url)
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)', true)
    const spec = (await win.webContents.executeJavaScript(MOTION_SPEC, true)) as MotionPageSpec | null
    if (!spec) throw new Error('motion runtime did not load in the capture window')
    const fps = spec.fps ?? 30
    const durationInFrames = spec.durationInFrames
    if (!durationInFrames) {
      throw new Error(
        'unknown duration: declare <meta name="orbit-motion" content="duration=…">, window.orbitMotion.durationInFrames or window.orbitTimeline',
      )
    }
    // Sem o bridge o seek falharia lá dentro com um TypeError opaco: melhor dizer
    // na hora por que a janela não serve para capturar.
    if (!(await win.webContents.executeJavaScript(BRIDGE_CHECK, true))) {
      throw new Error('window.orbitMotion.seek(frame) is missing in the capture window — the runtime did not take over the composition')
    }
    const frames = framesFromTimes(req.times, { fps, durationInFrames })
    win.setContentSize(Math.round(spec.width ?? 1920), Math.round(spec.height ?? 1080))
    await win.webContents.executeJavaScript(`window.orbitMotion.fps = ${fps}`, true)

    const shots: FrameShot[] = []
    let width = Math.round(spec.width ?? 1920)
    let height = Math.round(spec.height ?? 1080)
    for (let i = 0; i < frames.length; i++) {
      if (req.signal?.aborted) throw new Error('cancelled')
      // Quadro inteiro, na ordem pedida: o runtime converte para segundos lá dentro.
      await win.webContents.executeJavaScript(`window.orbitMotion.seek(${frames[i]})`, true)
      const image = await capturePageReliably(win.webContents)
      if (i === 0) {
        const size = image.getSize()
        if (size.width > 0 && size.height > 0) {
          width = size.width
          height = size.height
        }
      }
      shots.push({ png: image.toPNG(), timeMs: req.times[i] * 1000, frame: frames[i] })
    }

    const name = path.basename(preview.folder)
    const sheet = await renderFrameSheet({ title: name, fps, durationInFrames, shots })
    return {
      image: sheet,
      name,
      file: preview.file,
      url: preview.url,
      fps,
      durationInFrames,
      width,
      height,
      failedFonts: spec.failedFonts ?? [],
      cells: shots.map((shot) => ({ timeMs: shot.timeMs, frame: shot.frame })),
    }
  } finally {
    req.signal?.removeEventListener('abort', onAbort)
    if (!win.isDestroyed()) win.destroy()
  }
}
