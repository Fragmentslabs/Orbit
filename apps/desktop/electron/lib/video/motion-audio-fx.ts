/**
 * The TREATMENT of a motion piece's audio: what is done with a track beyond
 * positioning it and setting the level — removing the region that fights with the voice, holding
 * the dynamics, drawing a volume curve along the piece, and locking the final
 * result into a ceiling and a delivery loudness.
 *
 * It lives apart from motion-audio.ts (which resolves FILES and instants) and from
 * motion-render-args.ts (which builds the ffmpeg): here there is only the vocabulary of the
 * manifest — what `audio.json` accepts, validated, with the numbers inside
 * sane limits — and its translation into filters. All pure, testable without ffmpeg.
 *
 * Two product decisions:
 *
 *  - an invalid entry is an ERROR with the reason, not an ignored filter. A
 *    track the author treated and that comes out raw, silently, is worse than a render
 *    that says "eq band 2: gain 40 is outside −24…24";
 *  - the PRESETS (voice, bed, phone) are only shortcuts for fields the manifest already
 *    has. What the track declares on its own wins over the preset, field by field.
 *
 * The treatment only exists in the RENDER. The tab plays the raw track, as it already does with
 * the level and the ramps; the agent is told about that in the guide's notes.
 */

export interface EqBand {
  /** Center frequency, Hz. */
  freq: number
  /** Gain in dB (negative cuts). */
  gain: number
  /** Band width: smaller = wider. */
  q: number
}

export interface Compressor {
  /** Level above which compression acts, dB. */
  threshold: number
  ratio: number
  /** ms. */
  attack: number
  /** ms. */
  release: number
  /** Makeup gain after compressing, dB. */
  makeup: number
}

/** A point of the volume curve: the level in dB at that second OF THE PIECE. */
export interface AutomationPoint {
  at: number
  db: number
}

/** The treatment of ONE track. Empty is the normal case. */
export interface TrackFx {
  highpass?: number
  lowpass?: number
  eq: EqBand[]
  compress?: Compressor
  automation: AutomationPoint[]
}

/** How the bed (`duck`) goes down under the front tracks. */
export interface DuckSettings {
  /** LINEAR level above which the front triggers the bed (0.02 ≈ −34 dB). */
  threshold: number
  ratio: number
  /** ms. */
  attack: number
  /** ms. */
  release: number
}

/** The finishing of the whole mix. */
export interface MasterFx {
  /** Peak ceiling, dBFS: nothing goes past here. */
  limit?: number
  /** Delivery loudness, LUFS (−16 is the voice one on platforms, −14 the music one). */
  loudness?: number
}

export const NO_FX: TrackFx = { eq: [], automation: [] }

/** The usual duck — the numbers the EDL render already uses. */
export const DEFAULT_DUCK: DuckSettings = { threshold: 0.02, ratio: 10, attack: 15, release: 350 }

const DEFAULT_COMPRESSOR: Compressor = { threshold: -18, ratio: 3, attack: 10, release: 250, makeup: 0 }

/** Shortcuts: they only fill in what the track did not declare. */
const PRESETS: Record<string, Partial<Omit<TrackFx, 'automation'>>> = {
  // Voice: takes out the low rumble, opens a bit of presence and holds the peaks.
  voice: {
    highpass: 80,
    eq: [
      { freq: 250, gain: -2, q: 1 },
      { freq: 3500, gain: 2.5, q: 1 },
    ],
    compress: { threshold: -20, ratio: 3, attack: 8, release: 200, makeup: 3 },
  },
  // Bed: opens room in the band where the voice lives, so the music sits BEHIND it
  // without having to be too low.
  bed: {
    lowpass: 14000,
    eq: [
      { freq: 300, gain: -3, q: 0.8 },
      { freq: 2500, gain: -4, q: 0.8 },
    ],
  },
  // Phone: the narrow band of a call.
  phone: {
    highpass: 400,
    lowpass: 3400,
    compress: { threshold: -22, ratio: 4, attack: 5, release: 150, makeup: 4 },
  },
}

export const MOTION_AUDIO_PRESETS = Object.keys(PRESETS)

const MAX_EQ_BANDS = 6
const MAX_AUTOMATION_POINTS = 24

function fail(where: string, message: string): never {
  throw new Error(`${where}: ${message}`)
}

/** Finite number inside [min, max], or an error with the reason. */
function bounded(value: unknown, where: string, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(where, `${label} must be a number`)
  if (value < min || value > max) fail(where, `${label} ${value} is outside ${min}…${max}`)
  return value
}

function optional(value: unknown, where: string, label: string, min: number, max: number, fallback: number): number {
  return value === undefined ? fallback : bounded(value, where, label, min, max)
}

function parseEq(value: unknown, where: string): EqBand[] {
  if (!Array.isArray(value)) fail(where, '"eq" must be a list of bands like { "freq": 3000, "gain": 2, "q": 1 }')
  if (value.length > MAX_EQ_BANDS) fail(where, `"eq" takes at most ${MAX_EQ_BANDS} bands`)
  return value.map((entry, index) => {
    const label = `eq band ${index + 1}`
    const band = (entry ?? {}) as Record<string, unknown>
    if (band.freq === undefined) fail(where, `${label} needs "freq"`)
    return {
      freq: bounded(band.freq, where, `${label} freq`, 20, 20000),
      gain: optional(band.gain, where, `${label} gain`, -24, 24, 0),
      q: optional(band.q, where, `${label} q`, 0.1, 10, 1),
    }
  })
}

function parseCompress(value: unknown, where: string): Compressor | undefined {
  if (value === false || value === null) return undefined
  if (value === true) return { ...DEFAULT_COMPRESSOR }
  if (typeof value !== 'object') fail(where, '"compress" must be true, false or an object')
  const c = value as Record<string, unknown>
  return {
    threshold: optional(c.threshold, where, 'compress threshold', -60, 0, DEFAULT_COMPRESSOR.threshold),
    ratio: optional(c.ratio, where, 'compress ratio', 1, 20, DEFAULT_COMPRESSOR.ratio),
    attack: optional(c.attack, where, 'compress attack', 0.01, 2000, DEFAULT_COMPRESSOR.attack),
    release: optional(c.release, where, 'compress release', 0.01, 9000, DEFAULT_COMPRESSOR.release),
    makeup: optional(c.makeup, where, 'compress makeup', 0, 24, DEFAULT_COMPRESSOR.makeup),
  }
}

/** Accepts `{ at, db }` and the short form `[at, db]`. Returns in time order. */
function parseAutomation(value: unknown, where: string): AutomationPoint[] {
  if (!Array.isArray(value)) fail(where, '"automation" must be a list of { "at": seconds, "db": level }')
  if (value.length > MAX_AUTOMATION_POINTS) fail(where, `"automation" takes at most ${MAX_AUTOMATION_POINTS} points`)
  const points = value.map((entry, index) => {
    const label = `automation point ${index + 1}`
    const pair = Array.isArray(entry) ? { at: entry[0], db: entry[1] } : ((entry ?? {}) as Record<string, unknown>)
    return {
      at: bounded(pair.at, where, `${label} at`, 0, 36000),
      db: bounded(pair.db, where, `${label} db`, -60, 12),
    }
  })
  points.sort((a, b) => a.at - b.at)
  for (let i = 1; i < points.length; i++) {
    if (points[i].at === points[i - 1].at) fail(where, `automation has two points at ${points[i].at}s`)
  }
  return points
}

/**
 * The treatment of a track from what the manifest declared. `where` is the
 * prefix of the messages ("audio.json: track 2"), so the error says WHERE.
 */
export function parseTrackFx(spec: Record<string, unknown>, where: string): TrackFx {
  let base: Partial<Omit<TrackFx, 'automation'>> = {}
  if (spec.preset !== undefined) {
    const preset = typeof spec.preset === 'string' ? PRESETS[spec.preset] : undefined
    if (!preset) fail(where, `unknown preset ${JSON.stringify(spec.preset)} (use ${MOTION_AUDIO_PRESETS.join(', ')})`)
    base = preset
  }
  const fx: TrackFx = {
    highpass: base.highpass,
    lowpass: base.lowpass,
    eq: base.eq ? base.eq.map((band) => ({ ...band })) : [],
    compress: base.compress ? { ...base.compress } : undefined,
    automation: [],
  }
  if (spec.highpass !== undefined) fx.highpass = bounded(spec.highpass, where, 'highpass', 20, 2000)
  if (spec.lowpass !== undefined) fx.lowpass = bounded(spec.lowpass, where, 'lowpass', 500, 20000)
  if (spec.eq !== undefined) fx.eq = parseEq(spec.eq, where)
  if (spec.compress !== undefined) fx.compress = parseCompress(spec.compress, where)
  if (spec.automation !== undefined) fx.automation = parseAutomation(spec.automation, where)
  if (fx.highpass !== undefined && fx.lowpass !== undefined && fx.highpass >= fx.lowpass) {
    fail(where, `highpass ${fx.highpass} Hz is not below lowpass ${fx.lowpass} Hz — nothing would pass`)
  }
  return fx
}

/** `duck: true` (the usual numbers) or an object with what to change. */
export function parseDuck(value: unknown, where: string): { duck: boolean; settings?: DuckSettings } {
  if (value === undefined || value === false || value === null) return { duck: false }
  if (value === true) return { duck: true }
  if (typeof value !== 'object') fail(where, '"duck" must be true, false or an object')
  const d = value as Record<string, unknown>
  const thresholdDb = optional(d.threshold, where, 'duck threshold', -60, 0, -34)
  return {
    duck: true,
    settings: {
      threshold: Math.pow(10, thresholdDb / 20),
      ratio: optional(d.ratio, where, 'duck ratio', 1, 20, DEFAULT_DUCK.ratio),
      // Seconds in the manifest (like the rest of its times), ms in the filter.
      attack: optional(d.attack, where, 'duck attack', 0.001, 2, DEFAULT_DUCK.attack / 1000) * 1000,
      release: optional(d.release, where, 'duck release', 0.01, 9, DEFAULT_DUCK.release / 1000) * 1000,
    },
  }
}

export function parseMasterFx(value: unknown): MasterFx | null {
  if (value === undefined || value === null) return null
  const where = 'audio.json: master'
  if (typeof value !== 'object' || Array.isArray(value)) fail(where, 'must be an object like { "limit": -1, "loudness": -16 }')
  const m = value as Record<string, unknown>
  // "limiter" is what people write for it; a key that means nothing would silently leave the mix without one.
  const unknown = Object.keys(m).filter((key) => !['limit', 'limiter', 'loudness'].includes(key))
  if (unknown.length) fail(where, `unknown key "${unknown[0]}" — use "limit" (dB ceiling) and/or "loudness" (LUFS target)`)
  const master: MasterFx = {}
  const ceiling = m.limit ?? m.limiter
  if (ceiling !== undefined) master.limit = bounded(ceiling, where, 'limit', -24, 0)
  if (m.loudness !== undefined) master.loudness = bounded(m.loudness, where, 'loudness', -40, -5)
  return master.limit === undefined && master.loudness === undefined ? null : master
}

// ------------------------------------------------------------------ filters

/** Short, stable number for the graph: no trailing zeros, no scientific notation. */
function num(value: number): string {
  return String(Number(value.toFixed(4)))
}

const linear = (db: number): number => Math.pow(10, db / 20)

export function hasTrackFx(fx: TrackFx | undefined): boolean {
  return !!fx && (fx.highpass !== undefined || fx.lowpass !== undefined || fx.eq.length > 0 || !!fx.compress || fx.automation.length > 0)
}

export function hasMasterFx(master: MasterFx | null | undefined): boolean {
  return !!master && (master.limit !== undefined || master.loudness !== undefined)
}

/**
 * What comes BEFORE the level and the ramps: taking out what does not help, shaping the
 * timbre and holding the dynamics — in this order, so the compressor does not react to a
 * region the filter was going to cut anyway.
 */
export function toneFilters(fx: TrackFx): string[] {
  const out: string[] = []
  if (fx.highpass !== undefined) out.push(`highpass=f=${num(fx.highpass)}`)
  if (fx.lowpass !== undefined) out.push(`lowpass=f=${num(fx.lowpass)}`)
  for (const band of fx.eq) out.push(`equalizer=f=${num(band.freq)}:t=q:w=${num(band.q)}:g=${num(band.gain)}`)
  if (fx.compress) {
    const c = fx.compress
    out.push(
      `acompressor=threshold=${num(linear(c.threshold))}:ratio=${num(c.ratio)}:attack=${num(c.attack)}:release=${num(c.release)}:makeup=${num(linear(c.makeup))}`,
    )
  }
  return out
}

/**
 * The volume curve, in dB, interpolated in a straight line between the points and pinned at the
 * extremes. It goes AFTER the track's delay: there the filter's `t` is already the PIECE's
 * time, which is the ruler in which the manifest writes the points.
 *
 * The expression stays inside single quotes — the commas of the `if(…)` cannot be
 * read as a filter separator. Returns null without points.
 */
export function automationFilter(points: AutomationPoint[]): string | null {
  if (points.length === 0) return null
  if (points.length === 1) return `volume=${num(points[0].db)}dB`
  const last = points[points.length - 1]
  let expr = num(last.db)
  for (let i = points.length - 2; i >= 0; i--) {
    const a = points[i]
    const b = points[i + 1]
    const slope = (b.db - a.db) / (b.at - a.at)
    expr = `if(lt(t,${num(b.at)}),${num(a.db)}+${num(slope)}*(t-${num(a.at)}),${expr})`
  }
  expr = `if(lt(t,${num(points[0].at)}),${num(points[0].db)},${expr})`
  return `volume='pow(10,(${expr})/20)':eval=frame`
}

/** The bed's `sidechaincompress`. The defaults produce exactly the filter from before. */
export function duckFilter(settings: DuckSettings = DEFAULT_DUCK): string {
  return `sidechaincompress=threshold=${num(settings.threshold)}:ratio=${num(settings.ratio)}:attack=${num(settings.attack)}:release=${num(settings.release)}`
}

/**
 * The finishing of the whole mix. The delivery loudness comes first and the limiter
 * after: normalizing can push a peak above the ceiling, and the limiter exists
 * to catch it. `loudnorm` returns the audio at 192 kHz, so it goes back to 48 kHz.
 */
export function masterFilters(master: MasterFx | null | undefined): string[] {
  if (!master) return []
  const out: string[] = []
  if (master.loudness !== undefined) {
    const peak = master.limit ?? -1.5
    out.push(`loudnorm=I=${num(master.loudness)}:TP=${num(peak)}:LRA=11`, 'aresample=48000')
  }
  if (master.limit !== undefined) out.push(`alimiter=limit=${num(linear(master.limit))}:level=0`)
  return out
}

/** The treatment in a few words, for the report (empty when there is none). */
export function describeTrackFx(fx: TrackFx | undefined): string {
  if (!hasTrackFx(fx) || !fx) return ''
  const parts: string[] = []
  if (fx.highpass !== undefined) parts.push(`highpass ${fx.highpass}Hz`)
  if (fx.lowpass !== undefined) parts.push(`lowpass ${fx.lowpass}Hz`)
  if (fx.eq.length) parts.push(`eq×${fx.eq.length}`)
  if (fx.compress) parts.push('compressor')
  if (fx.automation.length) parts.push(`volume curve×${fx.automation.length}`)
  return parts.join(', ')
}

export function describeMasterFx(master: MasterFx | null | undefined): string {
  if (!hasMasterFx(master) || !master) return ''
  const parts: string[] = []
  if (master.loudness !== undefined) parts.push(`${master.loudness} LUFS`)
  if (master.limit !== undefined) parts.push(`peak limit ${master.limit} dB`)
  return parts.join(', ')
}
