import { z } from 'zod'

/**
 * EDL (edit decision list): what the agent decides about a cut, in JSON.
 *
 * The model does NOT write ffmpeg commands to edit: it writes WHICH
 * ranges go in, in what order and with what finish, and the render (render.ts)
 * turns that into deterministic commands. The production rules that
 * a model forgets in the middle of a filtergraph — not cutting in the middle of a
 * word, audio fade at every cut, subtitles last, the timing of the
 * subtitles on the OUTPUT timeline — live here, in the code, and not in the
 * model's memory. (The idea comes from video-use, from browser-use.)
 *
 * Everything in this file is pure: EDL + transcripts in, plan out. That is what the
 * tests exercise.
 */

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const GRADE_PRESETS: Record<string, string> = {
  // Teal in the shadows, orange in the highlights, a little less saturated.
  warm_cinematic: 'colorbalance=rs=-0.03:gs=-0.01:bs=0.04:rh=0.04:gh=0.01:bh=-0.03,eq=contrast=1.05:saturation=0.92',
  // Contrast only (soft S-curve) and a touch of saturation.
  neutral_punch: 'curves=preset=medium_contrast,eq=saturation=1.04',
  // Cooler and cleaner, for screen/product.
  cool_clean: 'colorbalance=rs=-0.02:bs=0.03:rm=-0.01:bm=0.02,eq=contrast=1.03:brightness=0.01',
  none: '',
}

const seconds = z.number().finite().min(0)

export const edlRangeSchema = z.object({
  source: z.string().min(1).describe('Key in `sources`'),
  start: seconds.describe('Start in the SOURCE, seconds'),
  end: seconds.describe('End in the SOURCE, seconds'),
  beat: z.string().optional().describe('Narrative label (HOOK, PROBLEM, PAYOFF…)'),
  quote: z.string().optional().describe('What is said in this range (for review)'),
  reason: z.string().optional().describe('Why this take/range'),
  grade: z.string().optional().describe('Overrides the global grade for this range'),
  volumeDb: z.number().min(-60).max(20).optional().describe('Gain for this range, dB'),
})

export const edlOverlaySchema = z.object({
  file: z.string().min(1).describe('Video (mp4/mov/webm — alpha kept for mov ProRes 4444 / webm VP9) or image (png/jpg)'),
  start: seconds.describe('Start in the OUTPUT timeline, seconds'),
  duration: z.number().positive().optional().describe('Seconds; default = the file length (images: required)'),
  x: z.union([z.number(), z.string()]).optional().describe('ffmpeg overlay x (number or expression like "(W-w)/2"); default 0'),
  y: z.union([z.number(), z.string()]).optional().describe('ffmpeg overlay y; default 0'),
  width: z.number().int().positive().optional().describe('Scale the overlay to this width (keeps aspect)'),
})

export const edlSubtitlesSchema = z.object({
  style: z.enum(['bold-overlay', 'natural-sentence']).optional().describe(
    'bold-overlay: 2-word UPPERCASE chunks, bold, lower third (social). natural-sentence: sentence case, up to ~7 words (documentary)',
  ),
  wordsPerChunk: z.number().int().min(1).max(12).optional(),
  uppercase: z.boolean().optional(),
  font: z.string().optional().describe('Font family installed on the machine; default Arial'),
  fontSize: z.number().positive().optional().describe('Pixels at output height'),
  position: z.enum(['bottom', 'middle', 'top']).optional(),
  marginV: z.number().min(0).optional().describe('Vertical margin in pixels'),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  outlineColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  file: z.string().optional().describe('Use this .srt/.ass instead of generating from the transcript (times in the OUTPUT timeline)'),
})

export const edlMusicSchema = z.object({
  file: z.string().min(1),
  volumeDb: z.number().min(-60).max(10).optional().describe('Music gain, default -18 dB'),
  duck: z.boolean().optional().describe('Lower the music under speech (sidechain), default true'),
  start: seconds.optional().describe('Offset INTO the music file, seconds'),
  fadeIn: z.number().min(0).optional(),
  fadeOut: z.number().min(0).optional(),
})

export const edlSchema = z.object({
  version: z.literal(1).optional(),
  sources: z.record(z.string(), z.string().min(1)).describe('id → video path (relative to the working folder, or absolute)'),
  ranges: z.array(edlRangeSchema).min(1),
  output: z
    .object({
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      fps: z.number().positive().max(120).optional(),
      fit: z.enum(['cover', 'contain']).optional().describe('cover crops to fill, contain letterboxes; default contain'),
    })
    .optional(),
  grade: z.string().optional().describe(`Preset (${Object.keys(GRADE_PRESETS).join(', ')}) or a raw ffmpeg video filter chain`),
  overlays: z.array(edlOverlaySchema).optional(),
  subtitles: z.union([edlSubtitlesSchema, z.literal(false)]).optional(),
  music: edlMusicSchema.optional(),
  loudness: z.union([z.object({ target: z.number().min(-30).max(-8).optional() }), z.literal(false)]).optional(),
  snap: z.boolean().optional().describe('Snap cut edges to word boundaries (default true when a transcript exists)'),
  padMs: z.number().min(0).max(400).optional().describe('Air kept around each cut edge, default 80 ms'),
})

export type Edl = z.infer<typeof edlSchema>
export type EdlRange = z.infer<typeof edlRangeSchema>
export type EdlSubtitles = z.infer<typeof edlSubtitlesSchema>

/** Word with its time in the SOURCE file (ms). */
export interface TimedWord {
  startMs: number
  endMs: number
  text: string
}

// ---------------------------------------------------------------------------
// Snapping to words
// ---------------------------------------------------------------------------

export interface SnapNote {
  range: number
  edge: 'start' | 'end'
  fromMs: number
  toMs: number
  why: string
}

export interface PlannedRange extends EdlRange {
  startMs: number
  endMs: number
  /** Where the range starts on the OUTPUT timeline. */
  outStartMs: number
}

/**
 * Moves every cut edge out of the word it fell in and gives it a bit of
 * air (`padMs`) without invading the neighbouring word. It is the "never cut
 * inside a word" + "30–200 ms of air to absorb the drift of the
 * timestamps" rule from video-use, applied by the code.
 */
export function snapRanges(
  ranges: EdlRange[],
  wordsBySource: Record<string, TimedWord[] | undefined>,
  opts: { padMs?: number; snap?: boolean; durationsMs?: Record<string, number> } = {},
): { ranges: PlannedRange[]; notes: SnapNote[] } {
  const pad = opts.padMs ?? 80
  const notes: SnapNote[] = []
  const out: PlannedRange[] = []
  let cursor = 0
  ranges.forEach((range, i) => {
    let startMs = Math.round(range.start * 1000)
    let endMs = Math.round(range.end * 1000)
    const words = opts.snap === false ? undefined : wordsBySource[range.source]
    if (words && words.length) {
      const inside = (t: number) => words.find((w) => w.startMs < t && t < w.endMs)
      const hitStart = inside(startMs)
      if (hitStart) {
        notes.push({ range: i, edge: 'start', fromMs: startMs, toMs: hitStart.startMs, why: `was inside "${hitStart.text}"` })
        startMs = hitStart.startMs
      }
      const hitEnd = inside(endMs)
      if (hitEnd) {
        notes.push({ range: i, edge: 'end', fromMs: endMs, toMs: hitEnd.endMs, why: `was inside "${hitEnd.text}"` })
        endMs = hitEnd.endMs
      }
      // Air: up to `pad`, without going past the end of the previous word / start of the next.
      const prev = [...words].reverse().find((w) => w.endMs <= startMs)
      const next = words.find((w) => w.startMs >= endMs)
      startMs = Math.max(prev ? prev.endMs : 0, startMs - pad, 0)
      endMs = Math.min(next ? next.startMs : Number.POSITIVE_INFINITY, endMs + pad)
    } else {
      startMs = Math.max(0, startMs)
    }
    const limit = opts.durationsMs?.[range.source]
    if (limit && endMs > limit) endMs = limit
    if (endMs - startMs < 40) return
    out.push({ ...range, startMs, endMs, outStartMs: cursor })
    cursor += endMs - startMs
  })
  return { ranges: out, notes }
}

export function totalDurationMs(ranges: PlannedRange[]): number {
  return ranges.reduce((sum, r) => sum + (r.endMs - r.startMs), 0)
}

/** Cut boundaries on the OUTPUT (where the self-evaluation should look). */
export function cutPointsMs(ranges: PlannedRange[]): number[] {
  return ranges.slice(1).map((r) => r.outStartMs)
}

/**
 * Words that survived the cut, in OUTPUT time. A word goes in
 * when its middle is inside a kept range.
 */
export function outputWords(ranges: PlannedRange[], wordsBySource: Record<string, TimedWord[] | undefined>): TimedWord[] {
  const out: TimedWord[] = []
  for (const r of ranges) {
    for (const w of wordsBySource[r.source] ?? []) {
      const mid = (w.startMs + w.endMs) / 2
      if (mid < r.startMs || mid > r.endMs) continue
      const s = Math.max(w.startMs, r.startMs) - r.startMs + r.outStartMs
      const e = Math.min(w.endMs, r.endMs) - r.startMs + r.outStartMs
      out.push({ startMs: s, endMs: e, text: w.text })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Subtitles (ASS)
// ---------------------------------------------------------------------------

export interface Cue {
  startMs: number
  endMs: number
  text: string
}

/**
 * Groups words into subtitle blocks: at most `wordsPerChunk`, and breaks
 * earlier on a long pause (≥ 500 ms) or end of sentence.
 */
export function chunkWords(words: TimedWord[], wordsPerChunk: number, uppercase: boolean): Cue[] {
  const cues: Cue[] = []
  let current: TimedWord[] = []
  const flush = () => {
    if (!current.length) return
    const text = current.map((w) => w.text).join(' ').replace(/\s+([,.!?;:])/g, '$1')
    cues.push({ startMs: current[0].startMs, endMs: current[current.length - 1].endMs, text: uppercase ? text.toUpperCase() : text })
    current = []
  }
  for (const w of words) {
    const last = current[current.length - 1]
    if (last && (w.startMs - last.endMs >= 500 || current.length >= wordsPerChunk)) flush()
    current.push(w)
    if (/[.!?]$/.test(w.text)) flush()
  }
  flush()
  // No blinking hole between glued blocks: extends up to the next one (≤ 300 ms).
  for (let i = 0; i < cues.length - 1; i++) {
    const gap = cues[i + 1].startMs - cues[i].endMs
    if (gap > 0 && gap <= 300) cues[i].endMs = cues[i + 1].startMs
  }
  return cues
}

function assTime(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10))
  const h = Math.floor(cs / 360000)
  const m = Math.floor((cs % 360000) / 6000)
  const s = Math.floor((cs % 6000) / 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`
}

/** #RRGGBB → &H00BBGGRR (ASS order). */
function assColor(hex: string): string {
  const h = hex.replace('#', '')
  return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase()
}

export function subtitleDefaults(style: EdlSubtitles['style'], height: number) {
  const bold = style !== 'natural-sentence'
  return {
    bold,
    wordsPerChunk: bold ? 2 : 7,
    uppercase: bold,
    fontSize: Math.round(height * (bold ? 0.068 : 0.046)),
    marginV: Math.round(height * (bold ? 0.16 : 0.07)),
    outline: Math.max(2, Math.round(height * (bold ? 0.006 : 0.0035))),
  }
}

export function buildAss(cues: Cue[], cfg: EdlSubtitles, size: { width: number; height: number }): string {
  const d = subtitleDefaults(cfg.style, size.height)
  const alignment = cfg.position === 'top' ? 8 : cfg.position === 'middle' ? 5 : 2
  const style = [
    'Default',
    cfg.font ?? 'Arial',
    cfg.fontSize ?? d.fontSize,
    assColor(cfg.primaryColor ?? '#FFFFFF'),
    '&H000000FF',
    assColor(cfg.outlineColor ?? '#000000'),
    '&H64000000',
    d.bold ? -1 : 0,
    0,
    0,
    0,
    100,
    100,
    0,
    0,
    1,
    d.outline,
    d.bold ? 0 : 1,
    alignment,
    Math.round(size.width * 0.06),
    Math.round(size.width * 0.06),
    cfg.marginV ?? d.marginV,
    1,
  ].join(',')
  const escape = (t: string) => t.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\n/g, '\\N')
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${size.width}`,
    `PlayResY: ${size.height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: ${style}`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...cues.map((c) => `Dialogue: 0,${assTime(c.startMs)},${assTime(c.endMs)},Default,,0,0,0,,${escape(c.text)}`),
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** Preset → chain; anything else is treated as a raw filter (lightly validated). */
export function gradeFilter(grade: string | undefined): string {
  if (!grade) return ''
  if (grade in GRADE_PRESETS) return GRADE_PRESETS[grade]
  // Simple chain only: labels and ';' would open a graph inside the range.
  if (/[;[\]]/.test(grade)) throw new Error(`grade must be a preset or a simple filter chain (no ';' or '[label]'): ${grade}`)
  return grade
}

/** Fits the frame to the output size — always ends in yuv420p and SAR 1. */
export function fitFilter(width: number, height: number, fps: number, fit: 'cover' | 'contain'): string {
  const scale =
    fit === 'cover'
      ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
      : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`
  return `${scale},setsar=1,fps=${fps},format=yuv420p`
}

/** 30 ms fades at both ends: a cut without a click. */
export function edgeFadeFilter(durationMs: number, volumeDb?: number): string {
  const d = Math.min(0.03, durationMs / 1000 / 4)
  const end = Math.max(0, durationMs / 1000 - d)
  const gain = volumeDb ? `,volume=${volumeDb}dB` : ''
  return `aresample=48000,aformat=channel_layouts=stereo${gain},afade=t=in:st=0:d=${d.toFixed(3)},afade=t=out:st=${end.toFixed(3)}:d=${d.toFixed(3)}`
}

/** Output size: the requested one, or the first video's; always even. */
export function outputSize(
  edl: Edl,
  firstDisplay: { width: number; height: number } | undefined,
  preview: boolean,
): { width: number; height: number } {
  let width = edl.output?.width ?? firstDisplay?.width ?? 1920
  let height = edl.output?.height ?? firstDisplay?.height ?? 1080
  if (preview && height > 720) {
    width = Math.round((width * 720) / height)
    height = 720
  }
  return { width: width - (width % 2), height: height - (height % 2) }
}
