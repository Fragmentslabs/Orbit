import { describe, expect, it } from 'vitest'
import { MOTION_HELPERS_SCRIPT } from './motion-helpers'

type Easing = Record<string, any>
const h = new Function(
  `${MOTION_HELPERS_SCRIPT}; return { interpolate: orbitInterpolate, spring: orbitSpring, Easing: orbitEasing, sequence: orbitSequence, analyze: orbitAnalyzeAudio, bands: orbitReadBands, mix: orbitMixTracks, gain: orbitTrackGain }`,
)() as {
  interpolate(v: number, i: number[], o: number[], opts?: Record<string, unknown>): number
  spring(o: Record<string, unknown>): number
  Easing: Easing
  sequence(frame: number, from: number, dur?: number): { active: boolean; frame: number; progress: number }
  analyze(s: Float32Array, rate: number, fps: number, frames: number, bands?: number): { level: Float32Array; spec: Float32Array; bands: number; frames: number }
  bands(data: unknown, frame: number, n?: number): number[]
  mix(tracks: Record<string, unknown>[], rate: number, seconds: number): Float32Array
  gain(track: Record<string, unknown>): number
}

describe('interpolate', () => {
  it('maps linearly and clamps both ends by default', () => {
    expect(h.interpolate(15, [0, 30], [0, 1])).toBe(0.5)
    expect(h.interpolate(-5, [0, 30], [0, 1])).toBe(0)
    expect(h.interpolate(60, [0, 30], [0, 1])).toBe(1)
    expect(h.interpolate(60, [0, 30], [0, 1], { extrapolateRight: 'extend' })).toBe(2)
  })

  it('handles several segments (fade in, hold, fade out)', () => {
    const range = [0, 10, 50, 60]
    const out = [0, 1, 1, 0]
    expect(h.interpolate(5, range, out)).toBe(0.5)
    expect(h.interpolate(30, range, out)).toBe(1)
    expect(h.interpolate(55, range, out)).toBe(0.5)
  })

  it('applies the easing inside the segment', () => {
    const eased = h.interpolate(15, [0, 30], [0, 100], { easing: h.Easing.easeOut })
    expect(eased).toBeCloseTo(87.5)
    expect(h.interpolate(15, [0, 30], [0, 100], { easing: h.Easing.bezier(0.42, 0, 0.58, 1) })).toBeCloseTo(50, 1)
  })

  it('refuses ranges that make no sense', () => {
    expect(() => h.interpolate(1, [0, 0], [0, 1])).toThrow(/strictly increasing/)
    expect(() => h.interpolate(1, [0, 1], [0])).toThrow(/same length/)
  })
})

describe('spring', () => {
  it('starts at from, overshoots a little with the default damping and settles at to', () => {
    expect(h.spring({ frame: 0, fps: 30 })).toBe(0)
    const values = Array.from({ length: 60 }, (_, f) => h.spring({ frame: f, fps: 30 }))
    expect(Math.max(...values)).toBeGreaterThan(1)
    expect(values[59]).toBeCloseTo(1, 2)
  })

  it('a critically damped or heavier spring never overshoots; delay holds it', () => {
    const heavy = Array.from({ length: 90 }, (_, f) => h.spring({ frame: f, fps: 30, damping: 30 }))
    expect(Math.max(...heavy)).toBeLessThanOrEqual(1)
    expect(h.spring({ frame: 10, fps: 30, delay: 15, from: 5, to: 9 })).toBe(5)
  })
})

describe('sequence', () => {
  it('gives the scene its local frame and progress', () => {
    expect(h.sequence(40, 30, 20)).toEqual({ active: true, frame: 10, progress: 0.5 })
    expect(h.sequence(10, 30, 20).active).toBe(false)
    expect(h.sequence(60, 30, 20)).toMatchObject({ active: false, progress: 1 })
  })
})

describe('audio analysis', () => {
  const rate = 8000

  it('level follows loudness and bands find the frequency', () => {
    // 1 s of silence, then 1 s of a 440 Hz tone.
    const samples = new Float32Array(rate * 2)
    for (let i = rate; i < samples.length; i++) samples[i] = 0.8 * Math.sin((2 * Math.PI * 440 * i) / rate)
    const data = h.analyze(samples, rate, 10, 20, 16)
    expect(data.level[2]).toBe(0)
    expect(data.level[15]).toBeCloseTo(1, 1)
    const bars = h.bands(data, 15, 16)
    const peak = bars.indexOf(Math.max(...bars))
    // 440 Hz sits in the lower-middle of a 30 Hz–4 kHz log scale.
    expect(peak).toBeGreaterThan(4)
    expect(peak).toBeLessThan(12)
    expect(h.bands(data, 2, 8).every((v) => v === 0)).toBe(true)
  })

  it('mixes on the piece timeline with start, offset, loop and level', () => {
    const ramp = Float32Array.from({ length: 4 }, (_, i) => i + 1) // 1 2 3 4
    const out = h.mix([{ data: ramp, start: 1 / rate, offset: 2 / rate, loop: true, gain: 0.5 }], rate, 8 / rate)
    expect(Array.from(out)).toEqual([0, 1.5, 2, 0.5, 1, 1.5, 2, 0.5])
    expect(h.gain({ gain: -20 })).toBeCloseTo(0.1)
    expect(h.gain({ volume: 0.3 })).toBe(0.3)
  })
})
