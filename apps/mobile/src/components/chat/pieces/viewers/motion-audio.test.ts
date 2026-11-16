import { describe, expect, it, vi } from 'vitest'

import { audioPlanUrl, automationGain, duckGain, parseAudioPlan, trackPosition, trackVolume, tracksFromVideoFacts, type AudioTrack } from './motion-audio'

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
  duck: false,
  duckSettings: null,
  automation: [],
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

describe('automation (the author volume curve)', () => {
  const pts = [{ at: 1, db: 0 }, { at: 3, db: -20 }]
  it('holds outside the points and interpolates in dB between them', () => {
    expect(automationGain(pts, 0)).toBe(1)
    expect(automationGain(pts, 2)).toBeCloseTo(Math.pow(10, -10 / 20))
    expect(automationGain(pts, 9)).toBeCloseTo(0.1)
    expect(automationGain([], 2)).toBe(1)
  })
  it('applies to the track volume', () => {
    expect(trackVolume(track({ automation: pts }), 3, null)).toBeCloseTo(0.1)
  })
})

describe('duck', () => {
  const fronts: [number, number][] = [[2, 4]]
  const settings = { attack: 100, release: 400, ratio: 10 }
  it('goes down after the front starts and back up over the release', () => {
    expect(duckGain(settings, fronts, 1)).toBe(1)
    expect(duckGain(settings, fronts, 3)).toBeCloseTo(0.2)
    expect(duckGain(settings, fronts, 2.05)).toBeGreaterThan(0.2)
    expect(duckGain(settings, fronts, 4.2)).toBeCloseTo(0.6)
    expect(duckGain(settings, fronts, 5)).toBe(1)
  })
  it('only ducks tracks that ask for it', () => {
    const bed = track({ duck: true, duckSettings: settings })
    expect(trackVolume(bed, 3, null, fronts)).toBeCloseTo(0.2)
    expect(trackVolume(track(), 3, null, fronts)).toBe(1)
  })
  it('reads duck and automation from the plan', () => {
    const [t] = parseAudioPlan({ tracks: [{ path: 'a.mp3', duck: true, duckSettings: { attack: 5, release: 100, ratio: 4 }, automation: [{ at: 2, db: -3 }, { at: 1, db: 0 }, { at: 'x' }] }] }, 'http://h/p')
    expect(t.duck).toBe(true)
    expect(t.duckSettings).toEqual({ attack: 5, release: 100, ratio: 4 })
    expect(t.automation).toEqual([{ at: 1, db: 0 }, { at: 2, db: -3 }])
  })
})

describe('video sound inside the page', () => {
  it('turns unmuted absolute videos into tracks with their trim', () => {
    const out = tracksFromVideoFacts([
      { src: 'http://h/p/clip.mp4', muted: false, start: 2, in: 5, end: 8, loop: true, gain: -3 },
      { src: 'http://h/p/clip.mp4', muted: false, start: 2, in: 5, end: 8, loop: true, gain: -3 },
      { src: 'http://h/p/mute.mp4', muted: true },
      { src: 'clip.mp4' },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ url: 'http://h/p/clip.mp4', start: 2, offset: 5, end: 8, loop: true, gainDb: -3 })
  })
  it('tolerates garbage', () => {
    expect(tracksFromVideoFacts(undefined)).toEqual([])
  })
})
