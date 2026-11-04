/**
 * Sound effects synthesised from nothing — a whoosh, a hit, a pop, a bell, a riser, a glitch, a tick.
 * Pure: the same request gives the same samples (a seeded noise source, no clock, no I/O), so a
 * render that uses one is reproducible, and there is no licence to credit because nothing was
 * downloaded or sampled.
 *
 * They are designed to sit UNDER a piece: short, with a clean attack and a faded tail, peak
 * normalised (default -3 dBFS) so a boost in the mix does not clip them. They sound like a
 * library effect, not like a recording: for a cinematic whoosh the user brings their own file.
 */

export const SFX_RATE = 44100

export const SFX_KINDS = ['whoosh', 'hit', 'pop', 'bell', 'riser', 'glitch', 'tick'] as const
export type SfxKind = (typeof SFX_KINDS)[number]

export interface SfxRequest {
  kind: SfxKind
  /** Seconds. Each kind has a sensible default and a range; outside it the value is clamped. */
  duration?: number
  /** Hz of the body: hit (the thump), pop, bell (the fundamental). Ignored by noise-based kinds. */
  pitch?: number
  /** whoosh / riser: 'up' sweeps from dark to bright, 'down' the other way. whoosh defaults to 'up', riser is always up. */
  direction?: 'up' | 'down'
  /** Another take of the same kind (noise and glitch pattern). Default 1. */
  seed?: number
  /** Peak of the result in dBFS (default -3, range -24..-0.5). */
  peakDb?: number
}

export interface SfxResult {
  samples: Float32Array
  rate: number
  durationSec: number
  peakDb: number
  /** The request with every default filled in — what was really made. */
  params: Required<Omit<SfxRequest, 'direction'>> & { direction: 'up' | 'down' }
}

const RANGE: Record<SfxKind, { def: number; min: number; max: number }> = {
  whoosh: { def: 0.7, min: 0.15, max: 3 },
  hit: { def: 0.8, min: 0.2, max: 3 },
  pop: { def: 0.14, min: 0.04, max: 0.6 },
  bell: { def: 1.8, min: 0.3, max: 6 },
  riser: { def: 1.5, min: 0.4, max: 8 },
  glitch: { def: 0.4, min: 0.1, max: 2 },
  tick: { def: 0.03, min: 0.01, max: 0.15 },
}

/** Deterministic noise in [-1, 1] (an LCG: all that is needed to make the same hiss every time). */
function noiseSource(seed: number): () => number {
  let s = (Math.imul(Math.floor(seed) | 0, 2654435761) ^ 0x9e3779b9) >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return (s / 0xffffffff) * 2 - 1
  }
}

/** A band-pass state-variable filter whose centre can change on every sample. */
function bandpass() {
  let low = 0
  let band = 0
  return (x: number, freq: number, q: number, rate: number): number => {
    const f = 2 * Math.sin((Math.PI * Math.min(freq, rate * 0.45)) / rate)
    const damp = 1 / q
    low += f * band
    const high = x - low - damp * band
    band += f * high
    return band
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
/** Exponential glide from a to b over p in 0..1. */
const glide = (a: number, b: number, p: number) => a * Math.pow(b / a, clamp(p, 0, 1))

function render(kind: SfxKind, n: number, p: Required<Omit<SfxRequest, 'direction'>> & { direction: 'up' | 'down' }): Float32Array {
  const out = new Float32Array(n)
  const rate = SFX_RATE
  const rnd = noiseSource(p.seed)
  const dur = n / rate

  switch (kind) {
    case 'whoosh': {
      // Noise through a band that sweeps, under a bell-shaped swell: it rushes toward you, then past.
      const bp = bandpass()
      const lo = 250
      const hi = 6500
      for (let i = 0; i < n; i++) {
        const t = i / n
        const sweep = p.direction === 'up' ? t : 1 - t
        const swell = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.8)), 2)
        out[i] = bp(rnd(), glide(lo, hi, sweep), 1.4, rate) * swell * 2.2
      }
      break
    }
    case 'hit': {
      // A thump (a sine falling in pitch) plus a short bright click, a touch of saturation.
      const bp = bandpass()
      let phase = 0
      for (let i = 0; i < n; i++) {
        const t = i / rate
        const freq = p.pitch * (0.4 + 2.2 * Math.exp(-t / 0.03))
        phase += (2 * Math.PI * freq) / rate
        const body = Math.sin(phase) * Math.exp(-t / (dur * 0.28))
        const click = bp(rnd(), 2400, 0.9, rate) * Math.exp(-t / 0.012) * 1.6
        out[i] = Math.tanh((body + click) * 1.6)
      }
      break
    }
    case 'pop': {
      // A short bubble: a sine that falls fast and dies.
      let phase = 0
      for (let i = 0; i < n; i++) {
        const t = i / rate
        const freq = p.pitch * (0.45 + 1.1 * Math.exp(-t / 0.012))
        phase += (2 * Math.PI * freq) / rate
        out[i] = Math.sin(phase) * Math.exp(-t / (dur * 0.3))
      }
      break
    }
    case 'bell': {
      // Inharmonic partials that die at different rates: bright at the strike, a pure ring after.
      const ratios = [1, 2.0, 2.76, 5.4, 8.93]
      const amps = [1, 0.6, 0.42, 0.25, 0.14]
      for (let i = 0; i < n; i++) {
        const t = i / rate
        let v = 0
        for (let k = 0; k < ratios.length; k++) {
          const decay = (dur * 0.5) / (1 + k * 0.9)
          v += amps[k] * Math.sin(2 * Math.PI * p.pitch * ratios[k] * t) * Math.exp(-t / decay)
        }
        out[i] = v * Math.min(1, t / 0.002)
      }
      break
    }
    case 'riser': {
      // Rising noise and a rising tone that swell and stop dead: the breath before an impact.
      const bp = bandpass()
      let phase = 0
      for (let i = 0; i < n; i++) {
        const t = i / n
        const swell = Math.pow(t, 2.2)
        const freq = glide(180, 1800, t)
        phase += (2 * Math.PI * freq) / rate
        out[i] = (bp(rnd(), glide(250, 9000, t), 1.6, rate) * 2 + Math.sin(phase) * 0.35) * swell
      }
      break
    }
    case 'glitch': {
      // Stuttered bursts of band-limited noise, bit-crushed, with gaps.
      let i = 0
      const bp = bandpass()
      while (i < n) {
        const len = Math.floor((0.008 + Math.abs(rnd()) * 0.035) * rate)
        const gap = Math.abs(rnd()) < 0.4 ? Math.floor(Math.abs(rnd()) * 0.02 * rate) : 0
        const freq = 400 + Math.abs(rnd()) * 6000
        const bits = 3 + Math.floor(Math.abs(rnd()) * 3)
        const levels = Math.pow(2, bits)
        for (let k = 0; k < len && i + k < n; k++) {
          const v = bp(rnd(), freq, 2.5, rate)
          out[i + k] = Math.round(clamp(v, -1, 1) * levels) / levels
        }
        i += len + gap
      }
      break
    }
    case 'tick': {
      const bp = bandpass()
      for (let i = 0; i < n; i++) out[i] = bp(rnd(), 4200, 0.8, rate) * Math.exp(-(i / rate) / (dur * 0.25))
      break
    }
  }
  return out
}

/** The defaults of each kind, so the result can say what was really made. */
function resolve(req: SfxRequest): Required<Omit<SfxRequest, 'direction'>> & { direction: 'up' | 'down' } {
  if (!SFX_KINDS.includes(req.kind)) throw new Error(`sfx: unknown kind "${req.kind}" — use ${SFX_KINDS.join(', ')}`)
  const r = RANGE[req.kind]
  const pitchDefault = { whoosh: 0, hit: 90, pop: 520, bell: 880, riser: 0, glitch: 0, tick: 0 }[req.kind]
  const direction: 'up' | 'down' = req.kind === 'riser' ? 'up' : (req.direction ?? 'up')
  return {
    kind: req.kind,
    duration: clamp(req.duration ?? r.def, r.min, r.max),
    pitch: clamp(req.pitch ?? pitchDefault, 30, 4000),
    direction,
    seed: Math.floor(req.seed ?? 1),
    peakDb: clamp(req.peakDb ?? -3, -24, -0.5),
  }
}

/** Makes the effect. Pure and deterministic. */
export function synthesizeSfx(req: SfxRequest): SfxResult {
  const params = resolve(req)
  const n = Math.max(1, Math.round(params.duration * SFX_RATE))
  const samples = render(params.kind, n, params)

  // A 1 ms fade-in and a fade-out (the last 8 ms, longer for tails) so no kind ends on a click.
  const fadeIn = Math.min(n, Math.round(0.001 * SFX_RATE))
  const fadeOut = Math.min(n, Math.round((params.kind === 'riser' ? 0.012 : 0.008) * SFX_RATE))
  for (let i = 0; i < fadeIn; i++) samples[i] *= i / fadeIn
  for (let i = 0; i < fadeOut; i++) samples[n - 1 - i] *= i / fadeOut

  let peak = 0
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(samples[i]))
  const target = Math.pow(10, params.peakDb / 20)
  if (peak > 0) {
    const g = target / peak
    for (let i = 0; i < n; i++) samples[i] *= g
  }
  return { samples, rate: SFX_RATE, durationSec: n / SFX_RATE, peakDb: peak > 0 ? params.peakDb : -Infinity, params }
}

/** RMS in dBFS of a window of the samples (a rough loudness, to tell how it will sit in a mix). */
export function rmsDb(samples: Float32Array): number {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  const rms = Math.sqrt(sum / Math.max(1, samples.length))
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity
}

/** Where in the file the sound HITS (the loudest instant): to land it on a beat, start the track this much earlier. */
export function peakTimeSec(samples: Float32Array, rate: number): number {
  let best = 0
  let at = 0
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i])
    if (v > best) { best = v; at = i }
  }
  return at / rate
}

/** The text the agent reads: what was made and how to put it in the mix. Pure. */
export function describeSfx(r: SfxResult, opts: { ref: string; label?: string }): string {
  const p = r.params
  const hitAt = peakTimeSec(r.samples, r.rate)
  const lead = r.params.kind === 'whoosh' || r.params.kind === 'riser'
  return [
    `${opts.label ?? p.kind} generated: ${r.durationSec.toFixed(2)} s, peak ${r.peakDb.toFixed(1)} dBFS, RMS ${rmsDb(r.samples).toFixed(1)} dBFS (mono ${r.rate} Hz wav, ref ${opts.ref}).`,
    `Made with: kind ${p.kind}, duration ${p.duration}, ${p.pitch ? `pitch ${p.pitch} Hz, ` : ''}${p.kind === 'whoosh' ? `direction ${p.direction}, ` : ''}seed ${p.seed}. Same request = same sound; change seed for another take.`,
    `Its loudest instant is at ${hitAt.toFixed(2)} s into the file${lead ? ` — a ${p.kind} swells TOWARD that point: start the track ${hitAt.toFixed(2)} s BEFORE the moment it should land (the cut, the beat, the transition's end)` : ''}.`,
    `In a piece: motion_asset({ name, ref: "${opts.ref}" }), then an audio.json track { "file": "<its name>", "start": <seconds>, "gain": -10 } — about -8 to -14 dB under music and -16 to -20 under a voice; never on every transition, only where something visible happens.`,
  ].join('\n')
}
