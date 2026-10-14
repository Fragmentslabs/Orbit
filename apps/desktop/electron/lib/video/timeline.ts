import type { TimedWord } from './edl'
import { runFfmpeg } from './ffmpeg'

/**
 * A "olhada" do agente num trecho: uma imagem com tira de quadros, forma de
 * onda e as palavras na posição em que são ditas — com os silêncios que dão
 * corte limpo destacados. É o `timeline_view` do video-use: chamado nos pontos
 * de decisão (pausa ambígua, comparar takes, conferir um corte), não para
 * varrer o vídeo.
 */

const WIDTH = 1600
const FRAME_ROW = 150
const WAVE_ROW = 110
const WORD_ROW = 64
const AXIS_ROW = 26
const PAD = 12

export interface TimelineInput {
  file: string
  startMs: number
  endMs: number
  frames: number
  words: TimedWord[]
  /** Marcas verticais (ex.: os cortes de uma saída renderizada), em ms. */
  marks?: number[]
  hasVideo: boolean
  hasAudio: boolean
}

/** Silêncios ≥ `minMs` entre palavras dentro da janela (candidatos a corte). */
export function silencesIn(words: TimedWord[], startMs: number, endMs: number, minMs = 400): { startMs: number; endMs: number }[] {
  const inside = words.filter((w) => w.endMs > startMs && w.startMs < endMs)
  const gaps: { startMs: number; endMs: number }[] = []
  let cursor = startMs
  for (const w of inside) {
    if (w.startMs - cursor >= minMs) gaps.push({ startMs: cursor, endMs: w.startMs })
    cursor = Math.max(cursor, w.endMs)
  }
  if (endMs - cursor >= minMs) gaps.push({ startMs: cursor, endMs })
  return gaps
}

async function frameAt(file: string, ms: number, height: number): Promise<Buffer | null> {
  try {
    const { stdout } = await runFfmpeg([
      '-v', 'error',
      '-ss', (ms / 1000).toFixed(3),
      '-i', file,
      '-frames:v', '1',
      '-vf', `scale=-2:${height}`,
      '-f', 'image2pipe',
      '-c:v', 'mjpeg',
      '-q:v', '5',
      'pipe:1',
    ])
    return stdout.length ? stdout : null
  } catch {
    return null
  }
}

/** Pico absoluto por coluna (PCM16 mono 8 kHz é de sobra para desenhar). */
async function peaks(file: string, startMs: number, endMs: number, columns: number): Promise<Float32Array> {
  const { stdout } = await runFfmpeg([
    '-v', 'error',
    '-ss', (startMs / 1000).toFixed(3),
    '-t', ((endMs - startMs) / 1000).toFixed(3),
    '-i', file,
    '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1',
  ])
  const samples = stdout.length / 2
  const out = new Float32Array(columns)
  const per = samples / columns
  for (let c = 0; c < columns; c++) {
    let max = 0
    const from = Math.floor(c * per)
    const to = Math.min(samples, Math.floor((c + 1) * per))
    for (let i = from; i < to; i++) max = Math.max(max, Math.abs(stdout.readInt16LE(i * 2)))
    out[c] = max / 32768
  }
  return out
}

function label(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`
}

export async function renderTimeline(input: TimelineInput): Promise<{ image: Buffer; silences: { startMs: number; endMs: number }[] }> {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas')
  const { startMs, endMs } = input
  const span = Math.max(1, endMs - startMs)
  const innerW = WIDTH - PAD * 2
  const height = PAD + (input.hasVideo ? FRAME_ROW + PAD : 0) + WAVE_ROW + WORD_ROW + AXIS_ROW + PAD
  const canvas = createCanvas(WIDTH, height)
  const g = canvas.getContext('2d')
  const x = (ms: number) => PAD + ((ms - startMs) / span) * innerW

  g.fillStyle = '#111317'
  g.fillRect(0, 0, WIDTH, height)
  let y = PAD

  // Quadros: N amostras igualmente espaçadas, no meio de cada fatia.
  if (input.hasVideo) {
    const n = Math.max(1, Math.min(16, input.frames))
    const times = Array.from({ length: n }, (_, i) => startMs + ((i + 0.5) * span) / n)
    const shots = await Promise.all(times.map((t) => frameAt(input.file, t, FRAME_ROW)))
    const slot = innerW / n
    for (let i = 0; i < n; i++) {
      const shot = shots[i]
      if (!shot) continue
      const img = await loadImage(shot)
      const w = Math.min(slot - 4, (img.width * FRAME_ROW) / img.height)
      const left = PAD + i * slot + (slot - w) / 2
      g.drawImage(img, left, y, w, FRAME_ROW)
      g.fillStyle = 'rgba(0,0,0,0.6)'
      g.fillRect(left, y + FRAME_ROW - 18, 62, 18)
      g.fillStyle = '#e6e6e6'
      g.font = '12px sans-serif'
      g.fillText(label(times[i]), left + 4, y + FRAME_ROW - 5)
    }
    y += FRAME_ROW + PAD
  }

  // Silêncios ≥ 400 ms (corte limpo) em verde, por trás da onda e das palavras.
  const silences = silencesIn(input.words, startMs, endMs)
  g.fillStyle = 'rgba(46, 160, 67, 0.22)'
  for (const s of silences) g.fillRect(x(s.startMs), y, x(s.endMs) - x(s.startMs), WAVE_ROW + WORD_ROW)

  // Forma de onda.
  const mid = y + WAVE_ROW / 2
  g.strokeStyle = '#3a3f4a'
  g.beginPath()
  g.moveTo(PAD, mid)
  g.lineTo(PAD + innerW, mid)
  g.stroke()
  if (input.hasAudio) {
    const cols = Math.floor(innerW / 2)
    const p = await peaks(input.file, startMs, endMs, cols)
    g.fillStyle = '#5fb3f9'
    for (let c = 0; c < cols; c++) {
      const h = Math.max(1, p[c] * (WAVE_ROW / 2 - 4))
      g.fillRect(PAD + c * 2, mid - h, 1.5, h * 2)
    }
  }
  y += WAVE_ROW

  // Palavras: uma faixa por palavra, alternando altura para não encavalar.
  g.font = '13px sans-serif'
  const visible = input.words.filter((w) => w.endMs > startMs && w.startMs < endMs)
  visible.forEach((w, i) => {
    const left = x(Math.max(startMs, w.startMs))
    const right = x(Math.min(endMs, w.endMs))
    const row = y + 6 + (i % 2) * 28
    g.fillStyle = 'rgba(255,255,255,0.10)'
    g.fillRect(left, row, Math.max(2, right - left), 22)
    g.fillStyle = '#f2f2f2'
    g.fillText(w.text, left + 2, row + 16, Math.max(24, right - left + 40))
  })
  y += WORD_ROW

  // Eixo de tempo.
  g.fillStyle = '#9aa0aa'
  g.font = '12px sans-serif'
  const step = [100, 250, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000].find((s) => span / s <= 12) ?? 60_000
  for (let t = Math.ceil(startMs / step) * step; t <= endMs; t += step) {
    g.fillRect(x(t), y, 1, 6)
    g.fillText(label(t), x(t) + 3, y + 18)
  }

  // Marcas (cortes de uma saída): linhas vermelhas de cima a baixo.
  g.strokeStyle = '#ff5a5a'
  g.lineWidth = 2
  for (const m of input.marks ?? []) {
    if (m < startMs || m > endMs) continue
    g.beginPath()
    g.moveTo(x(m), PAD)
    g.lineTo(x(m), height - PAD)
    g.stroke()
  }

  return { image: await canvas.encode('webp', 82), silences }
}
