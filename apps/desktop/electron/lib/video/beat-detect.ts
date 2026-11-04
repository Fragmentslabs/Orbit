/**
 * Tempo and beat detection from raw audio — pure, no ffmpeg, no Electron.
 *
 * Why it exists: a motion piece that should hit on the music needs the REAL beat times, not a
 * guessed 120 bpm. The motion-style guide asks for `framesPerBeat = fps × 60 / bpm`; this is
 * where that bpm (and the beats themselves) come from.
 *
 * Method (the classic onset → tempo → beat-tracking chain, after Ellis 2007):
 *  1. ONSET ENVELOPE: short-time spectrum, log-compressed, half-wave-rectified difference
 *     between frames summed over the bins (spectral flux). Peaks where something starts.
 *  2. TEMPO: autocorrelation of the envelope over the lags of 60–200 bpm, weighted by a
 *     log-normal prior around 120 bpm (people tap there) to fight octave errors.
 *  3. BEATS: dynamic programming — each frame's score is its onset strength plus the best
 *     earlier beat, penalised by how far the gap is from the tempo period. Backtracked from
 *     the best late frame. Keeps a steady grid through a weak beat instead of jumping.
 *
 * Everything is a deterministic function of the samples.
 */

export interface BeatAnalysis {
  /** Beats per minute, one decimal. 0 when no tempo was found. */
  bpm: number
  /** 0..1 — how much the autocorrelation peak stands out. Under ~0.25 treat the tempo as a guess. */
  confidence: number
  /** The other likely readings (half / double time), best first. */
  alternatives: Array<{ bpm: number; score: number }>
  /** Beat times in seconds, ascending. */
  beats: number[]
  /** Seconds of the window analysed. */
  durationSec: number
  /** Why there is no result, when there is none. */
  reason?: string
}

export interface BeatOptions {
  minBpm?: number
  maxBpm?: number
  /** Where the prior is centred (bpm). */
  prior?: number
}

const FRAME = 1024
const HOP = 256
/** Measured on synthetic clicks: how late (s) the flux peak lands after the real attack. */
const BEAT_LATENCY_SEC = 0

/** In-place radix-2 FFT. `re`/`im` have a power-of-two length. */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr
      const ti = im[i]; im[i] = im[j]; im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k
        const b = a + len / 2
        const xr = re[b] * cr - im[b] * ci
        const xi = re[b] * ci + im[b] * cr
        re[b] = re[a] - xr
        im[b] = im[a] - xi
        re[a] += xr
        im[a] += xi
        const t = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = t
      }
    }
  }
}

/** Onset strength per frame (spectral flux), normalised to a mean of 0 and a max near 1. */
export function onsetEnvelope(pcm: Float32Array, rate: number): { env: Float32Array; frameRate: number } {
  const frames = Math.max(0, Math.floor((pcm.length - FRAME) / HOP) + 1)
  const frameRate = rate / HOP
  const env = new Float32Array(frames)
  if (frames < 3) return { env, frameRate }
  const window = new Float32Array(FRAME)
  for (let i = 0; i < FRAME; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1))
  const bins = FRAME / 2
  // Ignore the very bottom (rumble) and above ~10 kHz (hiss): where rhythm lives.
  const lo = Math.max(1, Math.floor((30 * FRAME) / rate))
  const hi = Math.min(bins, Math.ceil((10000 * FRAME) / rate))
  let prev = new Float32Array(bins)
  const re = new Float32Array(FRAME)
  const im = new Float32Array(FRAME)
  for (let f = 0; f < frames; f++) {
    const off = f * HOP
    for (let i = 0; i < FRAME; i++) {
      re[i] = pcm[off + i] * window[i]
      im[i] = 0
    }
    fft(re, im)
    const cur = new Float32Array(bins)
    let flux = 0
    for (let k = lo; k < hi; k++) {
      cur[k] = Math.log1p(100 * Math.hypot(re[k], im[k]) / FRAME)
      const d = cur[k] - prev[k]
      if (d > 0) flux += d
    }
    env[f] = f === 0 ? 0 : flux
    prev = cur
  }
  // Remove the slow trend (a moving mean over ~1.5 s) so a loud section does not look like a beat.
  const w = Math.max(3, Math.round(frameRate * 1.5))
  const out = new Float32Array(frames)
  let acc = 0
  const prefix = new Float64Array(frames + 1)
  for (let i = 0; i < frames; i++) { acc += env[i]; prefix[i + 1] = acc }
  let peak = 0
  for (let i = 0; i < frames; i++) {
    const a = Math.max(0, i - w)
    const b = Math.min(frames, i + w + 1)
    const mean = (prefix[b] - prefix[a]) / (b - a)
    const v = Math.max(0, env[i] - mean)
    out[i] = v
    if (v > peak) peak = v
  }
  if (peak > 0) for (let i = 0; i < frames; i++) out[i] /= peak
  return { env: out, frameRate }
}

interface TempoPick {
  period: number // in envelope frames
  score: number
  confidence: number
  alternatives: Array<{ bpm: number; score: number }>
}

function pickTempo(env: Float32Array, frameRate: number, opts: Required<BeatOptions>): TempoPick | null {
  const minLag = Math.max(2, Math.floor((frameRate * 60) / opts.maxBpm))
  const maxLag = Math.min(env.length - 1, Math.ceil((frameRate * 60) / opts.minBpm))
  if (maxLag <= minLag) return null
  const n = env.length
  const ac = new Float64Array(maxLag + 2)
  for (let lag = minLag - 1; lag <= maxLag + 1 && lag < n; lag++) {
    let s = 0
    for (let i = lag; i < n; i++) s += env[i] * env[i - lag]
    ac[lag] = s / (n - lag) // unbiased: long lags have fewer terms
  }
  const weighted = new Float64Array(maxLag + 2)
  let mean = 0
  let count = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (frameRate * 60) / lag
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / opts.prior) / 0.9, 2))
    weighted[lag] = ac[lag] * prior
    mean += weighted[lag]
    count++
  }
  mean /= Math.max(1, count)
  // Local maxima only.
  const peaks: Array<{ lag: number; v: number }> = []
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (weighted[lag] > weighted[lag - 1] && weighted[lag] >= weighted[lag + 1]) peaks.push({ lag, v: weighted[lag] })
  }
  if (!peaks.length) return null
  peaks.sort((a, b) => b.v - a.v)
  const best = peaks[0]
  if (best.v <= 0) return null
  // Parabolic interpolation around the peak for sub-frame precision.
  const y0 = ac[best.lag - 1], y1 = ac[best.lag], y2 = ac[best.lag + 1]
  const denom = y0 - 2 * y1 + y2
  const shift = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom)) : 0
  const period = best.lag + shift
  const confidence = Math.max(0, Math.min(1, (best.v - mean) / best.v))
  const alternatives = [period * 2, period / 2, period * 1.5, period / 1.5]
    .map((p) => ({ p, bpm: (frameRate * 60) / p }))
    .filter((a) => a.bpm >= opts.minBpm * 0.75 && a.bpm <= opts.maxBpm * 1.25)
    .map((a) => {
      const lag = Math.round(a.p)
      const v = lag >= minLag - 1 && lag <= maxLag + 1 ? ac[lag] : 0
      return { bpm: Math.round(a.bpm * 10) / 10, score: Math.round((v / (y1 || 1)) * 100) / 100 }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
  return { period, score: best.v, confidence, alternatives }
}

/** Dynamic-programming beat tracker: a steady grid that rides the strongest onsets. */
function trackBeats(env: Float32Array, period: number): number[] {
  const n = env.length
  const tightness = 100
  const score = new Float64Array(n)
  const back = new Int32Array(n).fill(-1)
  const lo = Math.round(period / 2)
  const hi = Math.round(period * 2)
  for (let i = 0; i < n; i++) {
    let best = 0
    let from = -1
    for (let j = Math.max(0, i - hi); j <= i - lo; j++) {
      const gap = Math.log((i - j) / period)
      const s = score[j] - tightness * gap * gap
      if (from < 0 || s > best) { best = s; from = j }
    }
    score[i] = env[i] + (from >= 0 ? Math.max(0, best) : 0)
    back[i] = from
  }
  // Start the backtrace from the best frame among the last beat period.
  let last = n - 1
  for (let i = Math.max(0, n - Math.round(period)); i < n; i++) if (score[i] > score[last]) last = i
  const out: number[] = []
  for (let i = last; i >= 0; i = back[i]) {
    out.push(i)
    if (back[i] < 0) break
  }
  return out.reverse()
}

/**
 * The tracker keeps a grid even where nothing happens (an intro of silence, a fade-out).
 * Drop the beats at either end that have no onset behind them, so the first beat is the first
 * real hit, not a point on the grid.
 */
function trimToOnsets(env: Float32Array, beats: number[]): number[] {
  if (beats.length < 3) return beats
  const strength = beats.map((b) => {
    let m = 0
    for (let k = Math.max(0, b - 2); k <= Math.min(env.length - 1, b + 2); k++) m = Math.max(m, env[k])
    return m
  })
  const sorted = [...strength].sort((a, b) => a - b)
  const floor = sorted[Math.floor(sorted.length / 2)] * 0.25
  let from = 0
  let to = beats.length
  while (from < to && strength[from] < floor) from++
  while (to > from && strength[to - 1] < floor) to--
  return beats.slice(from, to)
}

/** Tempo and beats of mono PCM at `rate` Hz. */
export function analyzeBeats(pcm: Float32Array, rate: number, options: BeatOptions = {}): BeatAnalysis {
  const opts: Required<BeatOptions> = { minBpm: options.minBpm ?? 60, maxBpm: options.maxBpm ?? 200, prior: options.prior ?? 120 }
  const durationSec = pcm.length / rate
  const none = (reason: string): BeatAnalysis => ({ bpm: 0, confidence: 0, alternatives: [], beats: [], durationSec, reason })
  if (durationSec < 4) return none('audio too short — a tempo needs at least ~4 s (15–30 s is better)')
  const { env, frameRate } = onsetEnvelope(pcm, rate)
  let energy = 0
  for (let i = 0; i < env.length; i++) energy += env[i]
  if (energy < 1) return none('no rhythmic content found (silence or a sustained sound)')
  const tempo = pickTempo(env, frameRate, opts)
  if (!tempo) return none('no stable tempo found')
  // Frame i is a window that STARTS at i × HOP; its energy is centred half a window later.
  const lead = FRAME / 2 / HOP
  const beats = trimToOnsets(env, trackBeats(env, tempo.period)).map((i) => Math.max(0, (i + lead) / frameRate - BEAT_LATENCY_SEC))
  return {
    bpm: Math.round(((frameRate * 60) / tempo.period) * 10) / 10,
    confidence: Math.round(tempo.confidence * 100) / 100,
    alternatives: tempo.alternatives,
    beats: beats.map((b) => Math.round(b * 1000) / 1000),
    durationSec,
  }
}

/** framesPerBeat for a piece at `fps`: fps × 60 / bpm. 0 when there is no tempo. */
export function framesPerBeat(bpm: number, fps: number): number {
  return bpm > 0 ? Math.round(((fps * 60) / bpm) * 100) / 100 : 0
}

/** The text the agent reads. Pure. */
export function describeBeats(a: BeatAnalysis, opts: { fps: number; label: string; offsetSec?: number; maxBeats?: number }): string {
  if (!a.bpm) return `${opts.label}: ${a.reason ?? 'no tempo found'}`
  const off = opts.offsetSec ?? 0
  const fpb = framesPerBeat(a.bpm, opts.fps)
  const max = opts.maxBeats ?? 48
  const shown = a.beats.slice(0, max).map((b) => (b + off).toFixed(2))
  const gaps = a.beats.slice(1).map((b, i) => b - a.beats[i])
  const steady = gaps.length ? Math.sqrt(gaps.reduce((s, g) => s + Math.pow(g - gaps.reduce((x, y) => x + y, 0) / gaps.length, 2), 0) / gaps.length) : 0
  const lines = [
    `${opts.label}: ${a.bpm} bpm (confidence ${a.confidence}${a.confidence < 0.25 ? ' — LOW: treat as a guess and check against the ear/known tempo' : ''}) over ${a.durationSec.toFixed(1)} s analysed`,
    `At ${opts.fps} fps: framesPerBeat = ${fpb} (${opts.fps} × 60 / ${a.bpm}); a bar of 4 beats = ${Math.round(fpb * 4 * 100) / 100} frames`,
    a.alternatives.length ? `Other readings (double / half time): ${a.alternatives.map((x) => `${x.bpm} bpm (${x.score})`).join(', ')} — pick the one that matches how the song feels` : '',
    `${a.beats.length} beats found, first at ${(a.beats[0] + off).toFixed(2)} s, spacing jitter ${(steady * 1000).toFixed(0)} ms${a.beats.length > max ? `; first ${max} shown` : ''}:`,
    shown.join(' '),
    `Use these beat times (seconds on the SOURCE clock${off ? `, offset ${off} s already added` : ''}) for hard cuts, pulses and letter pops; add the track's start on the piece. Do not extrapolate with a fixed bpm past a tempo change.`,
  ]
  return lines.filter(Boolean).join('\n')
}
