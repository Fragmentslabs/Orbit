import type { Frame } from './types'

/**
 * Edição da gravação do Computer Use. A janela é gravada sem parar; o que vai
 * para o vídeo é decidido depois, a partir das ações do agente: cada ação
 * ganha um respiro antes e depois, trechos próximos se juntam, e o resto
 * (o agente pensando, esperando aprovação, escrevendo a resposta) sai. Cortar
 * depois — em vez de pausar o gravador — não depende da latência do
 * pause/resume do MediaRecorder, que podia engolir o começo de uma ação.
 *
 * Tudo aqui é puro (tempos em ms desde o início da gravação) e testado; o
 * ffmpeg só executa o plano.
 */

export interface RecordedAction {
  /** ms desde o início da gravação */
  start: number
  end: number
  label: string
  /** `wait` fica inteiro no vídeo: é o agente segurando um estado de propósito */
  hold?: boolean
  /** Onde a ação mirou, em pontos globais, e o frame da janela naquele momento */
  target?: { frame?: Frame; point?: [number, number] }
  window?: Frame
}

export interface RecordedMark {
  at: number
  label: string
}

export interface PlanOptions {
  /** Respiro antes de cada ação (a interface antes de mudar) */
  padBefore: number
  /** Respiro depois (a interface reagindo) */
  padAfter: number
  /** Trechos separados por menos que isto viram um só */
  joinGap: number
  /** Mantém a gravação inteira (sem cortar o ocioso) */
  keepIdle?: boolean
}

export const DEFAULT_PLAN: PlanOptions = { padBefore: 300, padAfter: 900, joinGap: 500 }

export interface PlannedSegment {
  /** ms na gravação */
  from: number
  to: number
}

export interface TimelineEntry {
  /** ms no vídeo final */
  start: number
  end: number
  label: string
}

export interface Pulse {
  /** ms no vídeo final */
  at: number
  /** Retângulo no vídeo (px), já com margem */
  box: { x: number; y: number; w: number; h: number }
}

export interface RecordingPlan {
  segments: PlannedSegment[]
  timeline: TimelineEntry[]
  marks: TimelineEntry[]
  pulses: Pulse[]
  durationMs: number
  /** Tempo da gravação que saiu (ocioso) */
  cutMs: number
}

/** Trechos mantidos: cada ação com respiro, juntando os próximos, dentro da gravação. */
export function planSegments(actions: RecordedAction[], recordedMs: number, options: PlanOptions): PlannedSegment[] {
  if (options.keepIdle || actions.length === 0) return [{ from: 0, to: recordedMs }]
  const raw = actions
    .map((a) => ({ from: Math.max(0, a.start - options.padBefore), to: Math.min(recordedMs, a.end + (a.hold ? 0 : options.padAfter)) }))
    .filter((s) => s.to > s.from)
    .sort((a, b) => a.from - b.from)
  const merged: PlannedSegment[] = []
  for (const s of raw) {
    const last = merged[merged.length - 1]
    if (last && s.from - last.to <= options.joinGap) last.to = Math.max(last.to, s.to)
    else merged.push({ ...s })
  }
  return merged
}

/** Tempo da gravação → tempo no vídeo final (null se caiu num trecho cortado). */
export function toOutputTime(segments: PlannedSegment[], t: number): number | null {
  let offset = 0
  for (const s of segments) {
    if (t >= s.from && t <= s.to) return offset + (t - s.from)
    offset += s.to - s.from
  }
  return null
}

/**
 * Frame global → retângulo no vídeo. O vídeo é a janela inteira em pixels
 * (pontos × escala), então a conversão é a razão entre o tamanho do vídeo e o
 * da janela no momento da ação.
 */
export function targetBox(
  target: NonNullable<RecordedAction['target']>,
  window: Frame,
  video: { width: number; height: number },
  margin = 10,
): Pulse['box'] | null {
  const sx = video.width / window[2]
  const sy = video.height / window[3]
  const minSide = 36
  let x: number, y: number, w: number, h: number
  if (target.frame && target.frame[2] > 0 && target.frame[3] > 0) {
    x = (target.frame[0] - window[0]) * sx - margin
    y = (target.frame[1] - window[1]) * sy - margin
    w = target.frame[2] * sx + margin * 2
    h = target.frame[3] * sy + margin * 2
  } else if (target.point) {
    x = (target.point[0] - window[0]) * sx - minSide / 2
    y = (target.point[1] - window[1]) * sy - minSide / 2
    w = minSide
    h = minSide
  } else {
    return null
  }
  // Fora da janela (ela mudou de lugar, elemento rolado): sem pulso.
  if (x + w < 0 || y + h < 0 || x > video.width || y > video.height) return null
  const cx = Math.max(0, Math.round(x))
  const cy = Math.max(0, Math.round(y))
  return {
    x: cx,
    y: cy,
    w: Math.max(4, Math.min(video.width - cx, Math.round(w))),
    h: Math.max(4, Math.min(video.height - cy, Math.round(h))),
  }
}

export function planRecording(
  actions: RecordedAction[],
  marks: RecordedMark[],
  recordedMs: number,
  video: { width: number; height: number },
  options: PlanOptions = DEFAULT_PLAN,
): RecordingPlan {
  const segments = planSegments(actions, recordedMs, options)
  const durationMs = segments.reduce((sum, s) => sum + (s.to - s.from), 0)
  const timeline: TimelineEntry[] = []
  const pulses: Pulse[] = []
  for (const a of actions) {
    const start = toOutputTime(segments, a.start)
    const end = toOutputTime(segments, Math.min(a.end, recordedMs))
    if (start === null) continue
    timeline.push({ start, end: end ?? start, label: a.label })
    if (a.target && a.window && !a.hold) {
      const box = targetBox(a.target, a.window, video)
      if (box) pulses.push({ at: start, box })
    }
  }
  const markEntries: TimelineEntry[] = []
  for (const m of marks) {
    const at = toOutputTime(segments, m.at)
    if (at !== null) markEntries.push({ start: at, end: at, label: m.label })
  }
  return { segments, timeline, marks: markEntries, pulses, durationMs, cutMs: Math.max(0, recordedMs - durationMs) }
}

/** Duração de cada pulso de clique no vídeo. */
const PULSE_MS = 650

/**
 * Filtro do ffmpeg: fps constante, os trechos mantidos (trim + concat) e um
 * retângulo amarelo pulsando no alvo de cada ação. O amarelo é o primário do
 * Orbit (#F5C400, perto do oklch do tema).
 */
export function buildFilter(plan: RecordingPlan, fps = 30): { filter: string; output: string } {
  const parts: string[] = [`[0:v]fps=${fps},format=yuv420p,split=${plan.segments.length}${plan.segments.map((_, i) => `[s${i}]`).join('')}`]
  plan.segments.forEach((s, i) => {
    parts.push(`[s${i}]trim=start=${(s.from / 1000).toFixed(3)}:end=${(s.to / 1000).toFixed(3)},setpts=PTS-STARTPTS[c${i}]`)
  })
  parts.push(`${plan.segments.map((_, i) => `[c${i}]`).join('')}concat=n=${plan.segments.length}:v=1:a=0[cut]`)
  let last = 'cut'
  plan.pulses.forEach((p, i) => {
    const from = (p.at / 1000).toFixed(3)
    const to = ((p.at + PULSE_MS) / 1000).toFixed(3)
    const next = `p${i}`
    parts.push(
      `[${last}]drawbox=x=${p.box.x}:y=${p.box.y}:w=${p.box.w}:h=${p.box.h}:color=0xF5C400@0.95:t=6:enable='between(t,${from},${to})'[${next}]`,
    )
    last = next
  })
  return { filter: parts.join(';'), output: last }
}

/** "0.0–1.4s  left_click on element 3" — o que o agente lê para saber o que está em cada segundo. */
export function formatTimeline(plan: RecordingPlan): string {
  const s = (ms: number) => (ms / 1000).toFixed(1)
  const entries = [
    ...plan.timeline.map((e) => ({ at: e.start, text: `${s(e.start)}–${s(e.end)}s  ${e.label}` })),
    ...plan.marks.map((m) => ({ at: m.start, text: `${s(m.start)}s  ◆ ${m.label}` })),
  ]
  return entries
    .sort((a, b) => a.at - b.at)
    .map((e) => e.text)
    .join('\n')
}
