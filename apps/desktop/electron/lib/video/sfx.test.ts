import { describe, expect, it } from 'vitest'
import { describeSfx, peakTimeSec, rmsDb, SFX_KINDS, SFX_RATE, synthesizeSfx, type SfxKind } from './sfx'

/** Zero crossings per second inside [from, to) seconds: a cheap pitch / brightness meter. */
function zcr(samples: Float32Array, from: number, to: number): number {
  const a = Math.floor(from * SFX_RATE)
  const b = Math.min(samples.length, Math.floor(to * SFX_RATE))
  let crossings = 0
  for (let i = a + 1; i < b; i++) if (samples[i - 1] < 0 !== samples[i] < 0) crossings++
  return crossings / Math.max(1e-9, (b - a) / SFX_RATE)
}

describe('synthesizeSfx', () => {
  it.each(SFX_KINDS)('%s: right length, finite, audible, peak where asked, no click at the end', (kind: SfxKind) => {
    const r = synthesizeSfx({ kind })
    expect(Math.abs(r.samples.length / SFX_RATE - r.params.duration)).toBeLessThan(0.001)
    let peak = 0
    for (const v of r.samples) {
      expect(Number.isFinite(v)).toBe(true)
      peak = Math.max(peak, Math.abs(v))
    }
    expect(20 * Math.log10(peak)).toBeCloseTo(-3, 1)
    expect(Math.abs(r.samples[r.samples.length - 1])).toBeLessThan(0.02)
    expect(Math.abs(r.samples[0])).toBeLessThan(0.02)
    expect(rmsDb(r.samples)).toBeGreaterThan(-45)
  })

  it('is deterministic, and another seed is another take of the noise kinds', () => {
    expect(synthesizeSfx({ kind: 'whoosh' })).toEqual(synthesizeSfx({ kind: 'whoosh' }))
    const a = synthesizeSfx({ kind: 'glitch', seed: 1 }).samples
    const b = synthesizeSfx({ kind: 'glitch', seed: 2 }).samples
    expect(a).not.toEqual(b)
  })

  it('honours peakDb and clamps it, and clamps the duration to the kind range', () => {
    const quiet = synthesizeSfx({ kind: 'pop', peakDb: -12 })
    expect(Math.max(...quiet.samples.map(Math.abs))).toBeCloseTo(Math.pow(10, -12 / 20), 2)
    expect(synthesizeSfx({ kind: 'pop', peakDb: 6 }).params.peakDb).toBe(-0.5)
    expect(synthesizeSfx({ kind: 'pop', duration: 30 }).params.duration).toBe(0.6)
    expect(synthesizeSfx({ kind: 'bell', duration: 0.01 }).params.duration).toBe(0.3)
  })

  it('whoosh direction: "up" gets brighter, "down" gets darker', () => {
    const up = synthesizeSfx({ kind: 'whoosh', duration: 1.2, direction: 'up' }).samples
    const down = synthesizeSfx({ kind: 'whoosh', duration: 1.2, direction: 'down' }).samples
    expect(zcr(up, 0.8, 1.1)).toBeGreaterThan(zcr(up, 0.1, 0.4) * 1.5)
    expect(zcr(down, 0.1, 0.4)).toBeGreaterThan(zcr(down, 0.8, 1.1) * 1.5)
  })

  it('bell rings at the pitch asked (after the bright partials have died)', () => {
    for (const hz of [440, 880]) {
      const r = synthesizeSfx({ kind: 'bell', pitch: hz })
      const measured = zcr(r.samples, 1.0, 1.4) / 2
      expect(Math.abs(measured - hz) / hz).toBeLessThan(0.08)
    }
  })

  it('pop and hit follow the pitch', () => {
    expect(zcr(synthesizeSfx({ kind: 'pop', pitch: 900 }).samples, 0.03, 0.1)).toBeGreaterThan(zcr(synthesizeSfx({ kind: 'pop', pitch: 300 }).samples, 0.03, 0.1) * 1.5)
    expect(zcr(synthesizeSfx({ kind: 'hit', pitch: 140 }).samples, 0.1, 0.4)).toBeGreaterThan(zcr(synthesizeSfx({ kind: 'hit', pitch: 60 }).samples, 0.1, 0.4) * 1.4)
  })

  it('a hit strikes at the start; a riser peaks at the end', () => {
    expect(peakTimeSec(synthesizeSfx({ kind: 'hit' }).samples, SFX_RATE)).toBeLessThan(0.05)
    const riser = synthesizeSfx({ kind: 'riser', duration: 2 })
    expect(peakTimeSec(riser.samples, SFX_RATE)).toBeGreaterThan(1.7)
  })

  it('a riser always rises, whatever direction is passed', () => {
    expect(synthesizeSfx({ kind: 'riser', direction: 'down' }).params.direction).toBe('up')
  })

  it('refuses an unknown kind with the list', () => {
    expect(() => synthesizeSfx({ kind: 'laser' as SfxKind })).toThrow(/unknown kind "laser".*whoosh/)
  })
})

describe('describeSfx', () => {
  it('says what was made, the ref, and how to put it in the mix', () => {
    const r = synthesizeSfx({ kind: 'whoosh', duration: 0.8 })
    const text = describeSfx(r, { ref: 'aud_abc.wav' })
    expect(text).toContain('whoosh generated: 0.80 s')
    expect(text).toContain('aud_abc.wav')
    expect(text).toMatch(/start the track [\d.]+ s BEFORE/)
    expect(text).toContain('"gain": -10')
    expect(text).toContain('seed 1')
  })

  it('does not tell a bell to start early', () => {
    const text = describeSfx(synthesizeSfx({ kind: 'bell' }), { ref: 'aud_x.wav' })
    expect(text).not.toContain('BEFORE')
  })
})
