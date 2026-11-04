import { describe, expect, it } from 'vitest'
import { analyzeBeats, describeBeats, framesPerBeat } from './beat-detect'

const RATE = 22050

/** Deterministic noise in [-1, 1]. */
function noise(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return (s / 0xffffffff) * 2 - 1
  }
}

/** A click track: a short decaying noise burst on every beat, plus a faint hiss. `swing` shifts every other beat. */
function clicks(bpm: number, seconds: number, opts: { swing?: number; kick?: boolean; firstBeat?: number } = {}): { pcm: Float32Array; times: number[] } {
  const pcm = new Float32Array(Math.round(seconds * RATE))
  const rnd = noise(7)
  for (let i = 0; i < pcm.length; i++) pcm[i] = rnd() * 0.01
  const period = 60 / bpm
  const times: number[] = []
  for (let n = 0, t = opts.firstBeat ?? 0.3; t < seconds - 0.2; n++, t = (opts.firstBeat ?? 0.3) + n * period) {
    const at = t + (n % 2 ? (opts.swing ?? 0) * period : 0)
    times.push(at)
    const start = Math.round(at * RATE)
    const len = Math.round(0.06 * RATE)
    for (let i = 0; i < len && start + i < pcm.length; i++) {
      const env = Math.exp(-i / (0.012 * RATE))
      const body = opts.kick ? Math.sin((2 * Math.PI * 60 * i) / RATE) : rnd()
      pcm[start + i] += 0.8 * env * body
    }
  }
  return { pcm, times }
}

describe('analyzeBeats', () => {
  it.each([90, 120, 128, 150])('finds %i bpm from a click track', (bpm) => {
    const { pcm } = clicks(bpm, 20)
    const out = analyzeBeats(pcm, RATE)
    expect(Math.abs(out.bpm - bpm)).toBeLessThan(1.5)
    expect(out.confidence).toBeGreaterThan(0.25)
  })

  it('places the beats on the real attacks', () => {
    const { pcm, times } = clicks(120, 20)
    const out = analyzeBeats(pcm, RATE)
    // Every real beat has a detected one within 40 ms (a frame is ~12 ms).
    const missed = times.filter((t) => !out.beats.some((b) => Math.abs(b - t) < 0.04))
    expect(missed.length).toBeLessThanOrEqual(1)
  })

  it('is deterministic', () => {
    const { pcm } = clicks(110, 15)
    expect(analyzeBeats(pcm, RATE)).toEqual(analyzeBeats(pcm, RATE))
  })

  it('keeps the grid through a late first beat', () => {
    const { pcm } = clicks(100, 20, { firstBeat: 1.7 })
    const out = analyzeBeats(pcm, RATE)
    expect(Math.abs(out.bpm - 100)).toBeLessThan(1.5)
    expect(out.beats[0]).toBeGreaterThan(1)
  })

  it('reports double / half time among the alternatives', () => {
    const { pcm } = clicks(80, 20)
    const out = analyzeBeats(pcm, RATE)
    const all = [out.bpm, ...out.alternatives.map((a) => a.bpm)]
    expect(all.some((b) => Math.abs(b - 160) < 3 || Math.abs(b - 80) < 2)).toBe(true)
  })

  it('refuses silence and too-short audio with a reason', () => {
    const silence = analyzeBeats(new Float32Array(RATE * 10), RATE)
    expect(silence.bpm).toBe(0)
    expect(silence.reason).toMatch(/no rhythmic/)
    const short = analyzeBeats(new Float32Array(RATE * 2), RATE)
    expect(short.bpm).toBe(0)
    expect(short.reason).toMatch(/too short/)
  })
})

describe('framesPerBeat / describeBeats', () => {
  it('is fps × 60 / bpm', () => {
    expect(framesPerBeat(120, 30)).toBe(15)
    expect(framesPerBeat(128, 30)).toBe(14.06)
    expect(framesPerBeat(0, 30)).toBe(0)
  })

  it('writes the numbers the agent needs and flags a low confidence', () => {
    const text = describeBeats(
      { bpm: 128, confidence: 0.1, alternatives: [{ bpm: 64, score: 0.8 }], beats: [0.3, 0.77, 1.24], durationSec: 20 },
      { fps: 30, label: 'song.mp3' },
    )
    expect(text).toContain('128 bpm')
    expect(text).toContain('framesPerBeat = 14.06')
    expect(text).toContain('LOW')
    expect(text).toContain('0.30 0.77 1.24')
  })

  it('says why when there is no tempo', () => {
    expect(describeBeats({ bpm: 0, confidence: 0, alternatives: [], beats: [], durationSec: 2, reason: 'audio too short' }, { fps: 30, label: 'x' })).toBe('x: audio too short')
  })
})
