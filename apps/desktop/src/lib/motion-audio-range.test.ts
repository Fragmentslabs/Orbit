import { describe, expect, it } from "vitest"
import {
  MOTION_AUDIO_MAX_NUDGE,
  MOTION_AUDIO_NUDGE_S,
  MOTION_AUDIO_SETTLE_S,
  motionAudioRate,
  motionTrackEnd,
  motionTrackIsLive,
} from "./motion-audio-range"

/** A narration of the presentation piece: 4.319 s of speech starting at 18.37 s. */
const narration = { start: 18.37, end: null }

describe("motionTrackEnd", () => {
  it("the declared `end` rules, even with the file measured", () => {
    expect(motionTrackEnd({ start: 2, end: 4.5 }, 9)).toBe(4.5)
  })

  it("without `end`, the real file length closes the window", () => {
    expect(motionTrackEnd(narration, 4.319)).toBeCloseTo(22.689, 3)
  })

  it("without `end` or measurement there is no window — the caller decides", () => {
    expect(motionTrackEnd(narration, null)).toBeNull()
    expect(motionTrackEnd(narration, undefined)).toBeNull()
    expect(motionTrackEnd(narration, 0)).toBeNull()
    expect(motionTrackEnd(narration, Number.NaN)).toBeNull()
    expect(motionTrackEnd(narration, Number.POSITIVE_INFINITY)).toBeNull()
    expect(motionTrackEnd(narration, -3)).toBeNull()
  })
})

describe("motionTrackIsLive", () => {
  it("lights up from the start to the real end of the file", () => {
    expect(motionTrackIsLive(narration, 4.319, 18)).toBe(false)
    expect(motionTrackIsLive(narration, 4.319, 18.37)).toBe(true)
    expect(motionTrackIsLive(narration, 4.319, 20)).toBe(true)
    expect(motionTrackIsLive(narration, 4.319, 22.7)).toBe(false)
  })

  it("does not stay lit until the end of the piece just because the manifest went quiet", () => {
    // The defect this fixes: the track being drawn and driven as if it
    // played from 18.37 s to the piece's 38 s.
    expect(motionTrackIsLive(narration, 4.319, 30)).toBe(false)
    // Without a measurement (the metadata has not arrived yet) the old guess applies.
    expect(motionTrackIsLive(narration, null, 30)).toBe(true)
    expect(motionTrackIsLive(narration, Number.NaN, 30)).toBe(true)
  })

  it("with `end` declared, the window is the manifest's, not the file's", () => {
    const bed = { start: 0, end: 12 }
    expect(motionTrackIsLive(bed, 300, 11.9)).toBe(true)
    expect(motionTrackIsLive(bed, 300, 12)).toBe(false)
  })

  it("starts exactly at the start", () => {
    expect(motionTrackIsLive({ start: 5, end: null }, 2, 4.999)).toBe(false)
    expect(motionTrackIsLive({ start: 5, end: null }, 2, 5)).toBe(true)
  })
})

describe("re-syncs from the audio by the rhythm", () => {
  it("already in place, it plays at the natural rhythm", () => {
    expect(motionAudioRate(0, false)).toBe(1)
    // Within the slack there is no resampling at all.
    expect(motionAudioRate(0.05, false)).toBe(1)
    expect(motionAudioRate(-0.05, false)).toBe(1)
  })

  it("the slack is larger than the loop's own step", () => {
    // `at` moves frame by frame (1/30 s ≈ 33 ms), so the measured drift saws
    // ±33 ms even with the sound in the right place. A slack smaller than that would fall
    // inside the saw: the pace would blink on every frame, and restarting the resample on
    // every blink is the click that was heard.
    const step = 1 / 30
    expect(MOTION_AUDIO_NUDGE_S).toBeGreaterThan(step)
    expect(MOTION_AUDIO_SETTLE_S).toBeGreaterThan(step)
  })

  it("adiantado desacelera, atrasado acelera", () => {
    expect(motionAudioRate(0.2, false)).toBeLessThan(1)
    expect(motionAudioRate(-0.2, false)).toBeGreaterThan(1)
  })

  it("hysteresis: it leaves through a lower threshold than it entered", () => {
    // 0.1 s falls between the two thresholds: whoever is already correcting keeps going...
    expect(motionAudioRate(0.1, true)).toBeLessThan(1)
    // ...and whoever is stopped does not start over so little.
    expect(motionAudioRate(0.1, false)).toBe(1)
    // Close enough, it stops both ways.
    expect(motionAudioRate(0.02, true)).toBe(1)
  })

  it("never goes past the cap — the correction must be inaudible", () => {
    for (const drift of [0.2, 0.5, 3, 60, -0.2, -0.5, -3, -60]) {
      for (const engaged of [true, false]) {
        expect(Math.abs(motionAudioRate(drift, engaged) - 1)).toBeLessThanOrEqual(MOTION_AUDIO_MAX_NUDGE + 1e-9)
      }
    }
  })

  it("a meaningless drift does not touch the rhythm", () => {
    expect(motionAudioRate(Number.NaN, false)).toBe(1)
    expect(motionAudioRate(Number.POSITIVE_INFINITY, false)).toBe(1)
  })
})
