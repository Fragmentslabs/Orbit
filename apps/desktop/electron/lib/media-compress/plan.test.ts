import { describe, expect, it } from 'vitest'
import type { MediaProbe } from '../video/ffmpeg'
import {
  audioBitrateForTarget,
  buildPlan,
  defaultContainer,
  nextVideoBitrate,
  qualityToAudioBitrate,
  qualityToCrf,
  resolveCodecs,
  totalBudgetKbps,
  videoBitrateForTarget,
} from './plan'

/** Minimal probe: what the plan really reads. */
function probe(over: Partial<MediaProbe> = {}): MediaProbe {
  const base: MediaProbe = {
    file: '/tmp/in.mp4',
    durationMs: 60_000,
    sizeBytes: 40_000_000,
    format: 'mov,mp4,m4a,3gp,3g2,mj2',
    video: [{ index: 0, codec: 'h264', width: 1920, height: 1080, fps: 30, rotation: 0, pixFmt: 'yuv420p' }],
    audio: [{ index: 1, codec: 'aac', sampleRate: 48000, channels: 2 }],
    display: { width: 1920, height: 1080 },
  }
  return { ...base, ...over }
}

describe('qualityToCrf', () => {
  it('goes from almost lossless to well compressed', () => {
    expect(qualityToCrf(100, 'h264')).toBe(18)
    expect(qualityToCrf(75, 'h264')).toBe(25)
    expect(qualityToCrf(50, 'h264')).toBe(32)
  })

  it('never leaves the encoder range', () => {
    expect(qualityToCrf(0, 'h264')).toBe(46)
    expect(qualityToCrf(200, 'h264')).toBe(18)
    expect(qualityToCrf(1, 'h264')).toBeLessThanOrEqual(51)
  })

  it('compensates the scale of each codec', () => {
    // For the SAME perceived quality, x265/vp9/av1 accept a higher CRF.
    expect(qualityToCrf(75, 'hevc')).toBe(qualityToCrf(75, 'h264') + 5)
    expect(qualityToCrf(75, 'vp9')).toBe(qualityToCrf(75, 'h264') + 8)
    expect(qualityToCrf(75, 'av1')).toBe(qualityToCrf(75, 'h264') + 10)
    expect(qualityToCrf(1, 'vp9')).toBeLessThanOrEqual(63)
  })
})

describe('qualityToAudioBitrate', () => {
  it('opus delivers the same with fewer bits', () => {
    expect(qualityToAudioBitrate(75, 'aac')).toBe(192)
    expect(qualityToAudioBitrate(75, 'mp3')).toBe(192)
    expect(qualityToAudioBitrate(75, 'opus')).toBe(128)
  })

  it('decreases with quality', () => {
    const values = [100, 80, 60, 40, 20, 5].map((q) => qualityToAudioBitrate(q, 'aac'))
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeLessThanOrEqual(values[i - 1])
  })
})

describe('resolveCodecs', () => {
  it('uses the container default when there is no override', () => {
    expect(resolveCodecs('mp4')).toMatchObject({ kind: 'video', videoCodec: 'h264', audioCodec: 'aac' })
    expect(resolveCodecs('webm')).toMatchObject({ kind: 'video', videoCodec: 'vp9', audioCodec: 'opus' })
    expect(resolveCodecs('m4a')).toMatchObject({ kind: 'audio', videoCodec: null, audioCodec: 'aac' })
  })

  it('accepts the codec valid for the container', () => {
    expect(resolveCodecs('mp4', 'hevc').videoCodec).toBe('hevc')
    expect(resolveCodecs('mkv', 'vp9').videoCodec).toBe('vp9')
  })

  it('refuses an impossible combination saying the right path', () => {
    expect(() => resolveCodecs('mp4', 'vp9')).toThrow(/use webm/)
    expect(() => resolveCodecs('m4a', 'mp3')).toThrow(/use mp3/)
    expect(() => resolveCodecs('webm', 'h264')).toThrow(/webm carries video/)
  })
})

describe('defaultContainer', () => {
  it('keeps the source family when it is already compressed', () => {
    expect(defaultContainer(probe({ video: [], display: undefined, audio: [{ index: 0, codec: 'mp3', sampleRate: 44100, channels: 2 }] }), 'audio')).toBe('mp3')
    expect(defaultContainer(probe({ video: [], display: undefined, audio: [{ index: 0, codec: 'opus', sampleRate: 48000, channels: 2 }] }), 'audio')).toBe('opus')
  })

  it('sends WAV/FLAC to m4a and WebM to WebM', () => {
    expect(defaultContainer(probe({ video: [], display: undefined, audio: [{ index: 0, codec: 'pcm_s16le', sampleRate: 44100, channels: 2 }] }), 'audio')).toBe('m4a')
    expect(defaultContainer(probe({ format: 'matroska,webm' }), 'video')).toBe('webm')
    expect(defaultContainer(probe(), 'video')).toBe('mp4')
  })
})

describe('bit budget', () => {
  it('deducts the container overhead and the audio', () => {
    // 10 MB in 60 s: 1293 kbps in total; minus 128 for audio and 6 of slack.
    expect(videoBitrateForTarget({ maxBytes: 10_000_000, durationMs: 60_000, audioKbps: 128 })).toBe(1159)
  })

  it('does not inflate above the source bitrate', () => {
    expect(videoBitrateForTarget({ maxBytes: 100_000_000, durationMs: 60_000, audioKbps: 128, sourceKbps: 900 })).toBe(900)
  })

  it('respects the workable floor and warns in the plan', () => {
    const plan = buildPlan({ probe: probe(), target: { maxBytes: 200_000 } })
    expect(plan.bitrate).toBe(60)
    expect(plan.notes.join(' ')).toMatch(/tight/)
  })

  it('refuses an unknown duration', () => {
    expect(() => totalBudgetKbps(1_000_000, 0)).toThrow(/duration/)
  })

  it('corrects the bitrate in proportion to the overshoot', () => {
    expect(nextVideoBitrate(1000, 12_000_000, 10_000_000)).toBe(800)
    expect(nextVideoBitrate(80, 4_000_000, 50_000)).toBe(60)
  })

  it('extracts audio within the budget', () => {
    // 5 MB in 5 min: 129 kbps.
    expect(audioBitrateForTarget(5_000_000, 300_000, 'aac')).toBe(127)
    expect(audioBitrateForTarget(20_000, 300_000, 'aac')).toBe(64)
    expect(audioBitrateForTarget(50_000_000, 60_000, 'opus')).toBe(256)
  })
})

describe('buildPlan', () => {
  it('a byte target becomes a bitrate, not CRF', () => {
    const plan = buildPlan({ probe: probe(), target: { maxBytes: 10_000_000 } })
    expect(plan.crf).toBeNull()
    expect(plan.bitrate).toBeGreaterThan(900)
    expect(plan.audioBitrate).toBe(192)
  })

  it('quality becomes CRF and bitrate stays null', () => {
    const plan = buildPlan({ probe: probe(), target: { quality: 60 } })
    expect(plan.crf).toBe(qualityToCrf(60, 'h264'))
    expect(plan.bitrate).toBeNull()
  })

  it('audio does not eat the budget on a tight target', () => {
    const plan = buildPlan({ probe: probe({ durationMs: 30_000 }), target: { maxBytes: 400_000 } })
    // 400 KB in 30 s = 103 kbps in total.
    expect(plan.audioBitrate).toBe(64)
    expect(plan.notes.join(' ')).toMatch(/audio lowered/)
  })

  it('only reduces height and fps, never increases', () => {
    const plan = buildPlan({ probe: probe(), target: { quality: 70, height: 720, fps: 24 } })
    expect(plan.height).toBe(720)
    expect(plan.fps).toBe(24)

    const up = buildPlan({ probe: probe(), target: { quality: 70, height: 2160, fps: 60 } })
    expect(up.height).toBeNull()
    expect(up.fps).toBeNull()
    expect(up.notes.join(' ')).toMatch(/ignored/)
  })

  it('rounds the height to even (x264 requires it)', () => {
    expect(buildPlan({ probe: probe(), target: { quality: 70, height: 721 } }).height).toBe(720)
  })

  it('10 bits on h264 warns and falls back to 8 bits; on hevc it keeps them', () => {
    const tenBit = probe({
      video: [{ index: 0, codec: 'hevc', width: 3840, height: 2160, fps: 30, rotation: 0, pixFmt: 'yuv420p10le' }],
      display: { width: 3840, height: 2160 },
    })
    const h264 = buildPlan({ probe: tenBit, target: { quality: 70 }, container: 'mp4' })
    expect(h264.pixFmt).toBe('yuv420p')
    expect(h264.notes.join(' ')).toMatch(/10-bit|8-bit/)

    const hevc = buildPlan({ probe: tenBit, target: { quality: 70 }, container: 'mp4', codec: 'hevc' })
    expect(hevc.pixFmt).toBe('yuv420p10le')
  })

  it('an audio container on a video extracts the track', () => {
    const plan = buildPlan({ probe: probe(), target: { quality: 80 }, container: 'mp3' })
    expect(plan.kind).toBe('audio')
    expect(plan.audioBitrate).toBe(192)
    expect(plan.notes.join(' ')).toMatch(/audio only/)
  })

  it('with no audio in the source, the plan does not invent a track', () => {
    const plan = buildPlan({ probe: probe({ audio: [] }), target: { quality: 70 } })
    expect(plan.stripAudio).toBe(true)
    expect(plan.audioBitrate).toBe(0)
  })

  it('an explicit stripAudio zeroes the track', () => {
    const plan = buildPlan({ probe: probe(), target: { quality: 70 }, stripAudio: true })
    expect(plan.stripAudio).toBe(true)
    expect(plan.audioBitrate).toBe(0)
  })

  it('refuses a video with no video stream and audio with no audio stream', () => {
    expect(() => buildPlan({ probe: probe({ video: [], display: undefined }), target: { quality: 70 }, container: 'mp4' })).toThrow(
      /no video stream/,
    )
    expect(() => buildPlan({ probe: probe({ audio: [] }), target: { quality: 70 }, container: 'mp3' })).toThrow(
      /no audio stream/,
    )
  })

  it('the requested preset reaches the plan', () => {
    expect(buildPlan({ probe: probe(), target: { quality: 70 }, preset: 'fast' }).preset).toBe('fast')
    expect(buildPlan({ probe: probe(), target: { quality: 70 } }).preset).toBe('balanced')
  })
})
