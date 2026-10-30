import type { Frame } from './types'

/**
 * Editing of the Computer Use recording. The window is recorded without stopping;
 * what goes into the video is decided afterwards, from the agent's actions: each
 * action gets a breath before and after, nearby stretches merge, and the rest (the
 * agent thinking, waiting for approval, writing the answer) is cut out. Cutting
 * afterwards — instead of pausing the recorder — does not depend on the latency of
 * MediaRecorder's pause/resume, which could swallow the beginning of an action.
 *
 * Everything here is pure (times in ms since the start of the recording) and tested;
 * ffmpeg only executes the plan.
 */

export interface RecordedAction {
  /** ms since the start of the recording */
  start: number
  end: number
  label: string
  /** `wait` stays whole in the video: it is the agent holding a state on purpose */
  hold?: boolean
  /** Draws the pulse on the target (clicks only: on a scroll the target is the center of the window) */
  pulse?: boolean
  /** Where the action aimed, in global points, and the window frame at that moment */
  target?: { frame?: Frame; point?: [number, number] }
  window?: Frame
}

export interface RecordedMark {
  at: number
  label: string
}

export interface PlanOptions {
  /** Breath before each action (the interface before it changes) */
  padBefore: number
  /** Breath after (the interface reacting) */
  padAfter: number
  /** Stretches separated by less than this become a single one */
  joinGap: number
  /** Keeps the whole recording (without cutting the idle) */
  keepIdle?: boolean
}

export const DEFAULT_PLAN: PlanOptions = { padBefore: 300, padAfter: 900, joinGap: 500 }

export interface PlannedSegment {
  /** ms in the recording */
  from: number
  to: number
}

export interface TimelineEntry {
  /** ms in the final video */
  start: number
  end: number
  label: string
}

export interface Pulse {
  /** ms in the final video */
  at: number
  /** Rectangle in the video (px), margin included */
  box: { x: number; y: number; w: number; h: number }
}

/** Where the drawn cursor is at the instant of an action (final video, px). */
export interface CursorStop {
  at: number
  x: number
  y: number
}

export interface RecordingPlan {
  segments: PlannedSegment[]
  /** Stops of the drawn cursor, in order */
  cursor: CursorStop[]
  timeline: TimelineEntry[]
  marks: TimelineEntry[]
  pulses: Pulse[]
  durationMs: number
  /** Recording time that was cut out (idle) */
  cutMs: number
}

/** Stretches kept: each action with its breath, merging the close ones, inside the recording. */
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

/** Recording time → time in the final video (null if it fell in a cut stretch). */
export function toOutputTime(segments: PlannedSegment[], t: number): number | null {
  let offset = 0
  for (const s of segments) {
    if (t >= s.from && t <= s.to) return offset + (t - s.from)
    offset += s.to - s.from
  }
  return null
}

/**
 * Global frame → rectangle in the video. The video is the whole window in pixels
 * (points × scale), so the conversion is the ratio between the size of the video and
 * that of the window at the moment of the action.
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
  // Outside the window (it moved, element scrolled): no pulse.
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

/** Center of the target in the video (where the tip of the drawn cursor goes). */
export function targetPoint(
  target: NonNullable<RecordedAction['target']>,
  window: Frame,
  video: { width: number; height: number },
): { x: number; y: number } | null {
  const sx = video.width / window[2]
  const sy = video.height / window[3]
  let gx: number, gy: number
  if (target.frame && target.frame[2] > 0 && target.frame[3] > 0) {
    gx = target.frame[0] + target.frame[2] / 2
    gy = target.frame[1] + target.frame[3] / 2
  } else if (target.point) {
    gx = target.point[0]
    gy = target.point[1]
  } else {
    return null
  }
  const x = Math.round((gx - window[0]) * sx)
  const y = Math.round((gy - window[1]) * sy)
  if (x < 0 || y < 0 || x > video.width || y > video.height) return null
  return { x, y }
}

/** How long the drawn cursor takes to reach the next target. */
const CURSOR_MOVE_MS = 450

/**
 * ffmpeg expression for the cursor position along the video: stopped at the first
 * target, it slides to each following target (eased at the ends) and arrives at the
 * instant of the action; after the last one, it stays put. `axis` chooses x or y.
 */
export function cursorExpression(stops: CursorStop[], axis: 'x' | 'y', offset = 0): string {
  if (stops.length === 0) return '0'
  const v = (i: number) => stops[i][axis] - offset
  let expr = String(v(stops.length - 1))
  for (let i = stops.length - 1; i >= 1; i--) {
    const t1 = stops[i].at / 1000
    const t0 = Math.max(stops[i - 1].at, stops[i].at - CURSOR_MOVE_MS) / 1000
    const span = Math.max(0.001, t1 - t0)
    const u = `clip((t-${t0.toFixed(3)})/${span.toFixed(3)},0,1)`
    const eased = `(3*pow(${u},2)-2*pow(${u},3))`
    expr = `if(lt(t,${t1.toFixed(3)}),${v(i - 1)}+(${v(i) - v(i - 1)})*${eased},${expr})`
  }
  return expr
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
  const cursor: CursorStop[] = []
  for (const a of actions) {
    const start = toOutputTime(segments, a.start)
    const end = toOutputTime(segments, Math.min(a.end, recordedMs))
    if (start === null) continue
    timeline.push({ start, end: end ?? start, label: a.label })
    if (a.target && a.window && !a.hold) {
      const point = targetPoint(a.target, a.window, video)
      if (point) cursor.push({ at: start, ...point })
      if (a.pulse) {
        const box = targetBox(a.target, a.window, video)
        if (box) pulses.push({ at: start, box })
      }
    }
  }
  const markEntries: TimelineEntry[] = []
  for (const m of marks) {
    const at = toOutputTime(segments, m.at)
    if (at !== null) markEntries.push({ start: at, end: at, label: m.label })
  }
  return { segments, timeline, marks: markEntries, pulses, cursor, durationMs, cutMs: Math.max(0, recordedMs - durationMs) }
}

/** Duration of each click pulse in the video. */
const PULSE_MS = 650

/**
 * ffmpeg filter: constant fps, the stretches kept (trim + concat) and a yellow
 * rectangle pulsing on the target of each action. The yellow is Orbit's primary
 * (#F5C400, close to the theme's oklch).
 */
export function buildFilter(plan: RecordingPlan, fps = 30, options: { cursorInput?: number } = {}): { filter: string; output: string } {
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
  // Drawn cursor (directed mode): the image of the 2nd input overlaid on the
  // path between the targets. The tip of the arrow sits at (2,2) of the image.
  if (options.cursorInput !== undefined && plan.cursor.length > 0) {
    const x = cursorExpression(plan.cursor, 'x', 2)
    const y = cursorExpression(plan.cursor, 'y', 2)
    parts.push(`[${last}][${options.cursorInput}:v]overlay=x='${x}':y='${y}':format=auto[cur]`)
    last = 'cur'
  }
  return { filter: parts.join(';'), output: last }
}

/** "0.0–1.4s  left_click on element 3" — what the agent reads to know what is in each second. */
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
