import { describe, expect, it } from 'vitest'
import { motionTrackVolume } from './motion-audio-range'

const db = (x: number) => Math.pow(10, x / 20)

describe('motionTrackVolume', () => {
  it('is full level for a bare track', () => {
    expect(motionTrackVolume({ start: 0 }, 20, 5)).toBe(1)
  })
  it('follows the volume curve in a straight line and pins the extremes', () => {
    const track = { start: 0, automation: [{ at: 13.5, db: 0 }, { at: 18, db: -60 }] }
    expect(motionTrackVolume(track, 20, 10)).toBe(1)
    expect(motionTrackVolume(track, 20, 15.75)).toBeCloseTo(db(-30), 6)
    expect(motionTrackVolume(track, 20, 19)).toBeCloseTo(db(-60), 6)
  })
  it('applies gain and the in/out ramps relative to the track', () => {
    const track = { start: 2, gainDb: -6, fadeIn: 2, fadeOut: 2 }
    expect(motionTrackVolume(track, 12, 3)).toBeCloseTo(db(-6) * 0.5, 6)
    expect(motionTrackVolume(track, 12, 11)).toBeCloseTo(db(-6) * 0.5, 6)
    expect(motionTrackVolume(track, null, 11)).toBeCloseTo(db(-6), 6)
  })
  it('never exceeds what an audio element accepts', () => {
    expect(motionTrackVolume({ start: 0, gainDb: 12 }, 10, 1)).toBe(1)
  })
})
