import { describe, expect, it, vi } from 'vitest'

import { audioPlanUrl, parseAudioPlan, trackPosition, trackVolume, type AudioTrack } from './motion-audio'

vi.mock('expo-audio', () => ({ createAudioPlayer: vi.fn(), setAudioModeAsync: vi.fn() }))

const track = (over: Partial<AudioTrack> = {}): AudioTrack => ({
  name: 't',
  url: 'http://h/a.mp3',
  start: 0,
  end: null,
  offset: 0,
  gainDb: 0,
  fadeIn: 0,
  fadeOut: 0,
  loop: false,
  ...over,
})

describe('audio plan', () => {
  it('appends the reserved file to the piece URL', () => {
    expect(audioPlanUrl('http://h/api/file/motion/mv_1/tok/')).toBe('http://h/api/file/motion/mv_1/tok/__orbit-audio.json')
  })

  it('turns paths into URLs under the piece and drops malformed entries', () => {
    const out = parseAudioPlan(
      { tracks: [{ name: 'voz', path: 'audio/voz.mp3', start: 2, end: null, offset: 1, gainDb: -6 }, { name: 'x' }, null] },
      'http://h/p',
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ url: 'http://h/p/audio/voz.mp3', start: 2, end: null, offset: 1, gainDb: -6 })
  })

  it('tolerates a non-plan body', () => {
    expect(parseAudioPlan(null, 'http://h/p')).toEqual([])
    expect(parseAudioPlan({ tracks: 3 }, 'http://h/p')).toEqual([])
  })
})

describe('trackPosition', () => {
  it('is silent before the start and after the end', () => {
    expect(trackPosition(track({ start: 2 }), 1)).toBeNull()
    expect(trackPosition(track({ start: 2, end: 5 }), 5)).toBeNull()
  })
  it('maps the piece time to the file time, with offset', () => {
    expect(trackPosition(track({ start: 2, offset: 10 }), 3.5)).toBeCloseTo(11.5)
  })
  it('ends with the file', () => {
    expect(trackPosition(track(), 9, 8)).toBeNull()
  })
  it('wraps a looped track around the file', () => {
    expect(trackPosition(track({ loop: true }), 9, 4)).toBeCloseTo(1)
  })
})

describe('trackVolume', () => {
  it('converts dB and clips boosts to unity', () => {
    expect(trackVolume(track({ gainDb: -6 }), 1, null)).toBeCloseTo(0.501, 2)
    expect(trackVolume(track({ gainDb: 6 }), 1, null)).toBe(1)
  })
  it('ramps in and out', () => {
    const t = track({ start: 1, end: 5, fadeIn: 2, fadeOut: 2 })
    expect(trackVolume(t, 2, null)).toBeCloseTo(0.5)
    expect(trackVolume(t, 4, null)).toBeCloseTo(0.5)
    expect(trackVolume(t, 3, null)).toBe(1)
  })
})
