import { describe, expect, it } from 'vitest'
import { MOTION_RUNTIME } from './motion-runtime'
import { MOTION_TIMING_SCRIPT } from './motion-timing'

const { videoTime, gifFrame, gifDelay } = new Function(
  `${MOTION_TIMING_SCRIPT}; return { videoTime: orbitVideoTime, gifFrame: orbitGifFrame, gifDelay: orbitGifDelay }`,
)() as {
  videoTime(t: number, m: Record<string, unknown>): number
  gifFrame(t: number, durations: number[], loop: boolean): number
  gifDelay(seconds: unknown): number
}

describe('orbitVideoTime', () => {
  it('with no attributes it is the previous one: the file plays from instant 0', () => {
    expect(videoTime(0, {})).toBe(0)
    expect(videoTime(2.5, {})).toBe(2.5)
    // With a duration: clamps at the end (a little before, so the frame exists)…
    expect(videoTime(9, { duration: 4 })).toBeCloseTo(3.999)
    // …or wraps around.
    expect(videoTime(9, { duration: 4, loop: true })).toBe(1)
  })

  it('data-start: frozen on the first frame until the time, then it moves', () => {
    expect(videoTime(1, { start: 3 })).toBe(0)
    expect(videoTime(3, { start: 3 })).toBe(0)
    expect(videoTime(4.5, { start: 3 })).toBe(1.5)
  })

  it('data-in trims the beginning of the file', () => {
    expect(videoTime(0, { in: 10 })).toBe(10)
    expect(videoTime(2, { start: 1, in: 10 })).toBe(11)
  })

  it('data-end holds the last frame', () => {
    expect(videoTime(9, { start: 2, in: 5, end: 6 })).toBe(9)
    expect(videoTime(5, { start: 2, in: 5, end: 6 })).toBe(8)
    // end before start makes no sense and is ignored.
    expect(videoTime(5, { start: 4, end: 2 })).toBe(1)
  })

  it('the loop respects the initial cut, adding before wrapping around', () => {
    expect(videoTime(3, { in: 2, duration: 4, loop: true })).toBe(1)
  })
})

describe('orbitGifFrame', () => {
  const frames = [0.1, 0.2, 0.1] // 0.4 s in total

  it('walks the frames by the time of each one', () => {
    expect([0, 0.05, 0.1, 0.29, 0.31, 0.39].map((t) => gifFrame(t, frames, true))).toEqual([0, 0, 1, 1, 2, 2])
  })

  it('repeats by default and holds the last frame when it does not', () => {
    expect(gifFrame(0.45, frames, true)).toBe(0)
    expect(gifFrame(0.95, frames, true)).toBe(1)
    expect(gifFrame(5, frames, false)).toBe(2)
  })

  it('before starting it is the first frame; with no frames, zero', () => {
    expect(gifFrame(-1, frames, true)).toBe(0)
    expect(gifFrame(3, [], true)).toBe(0)
    expect(gifFrame(3, [0, 0], true)).toBe(0)
  })

  it('is pure: the same time always gives the same frame, in any order', () => {
    const ts = [0.35, 0.05, 0.25, 0.05, 0.35]
    expect(ts.map((t) => gifFrame(t, frames, true))).toEqual([2, 0, 1, 0, 2])
  })
})

describe('orbitGifDelay', () => {
  it('a small or absent delay becomes 100 ms, as in browsers', () => {
    expect(gifDelay(0)).toBe(0.1)
    expect(gifDelay(0.01)).toBe(0.1)
    expect(gifDelay(undefined)).toBe(0.1)
    expect(gifDelay(0.04)).toBe(0.04)
  })
})

describe('no runtime', () => {
  it('the script is embedded', () => {
    expect(MOTION_RUNTIME).toContain('function orbitVideoTime')
    expect(MOTION_RUNTIME).toContain('function orbitGifFrame')
  })
})
