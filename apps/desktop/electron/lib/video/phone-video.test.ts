import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/x' } }))

import { cacheName, needsPhoneTranscode, transcodeArgs } from './phone-video'

const probe = (format: string, video: string[], audio: string[] = ['aac']) => ({
  format,
  video: video.map((codec, index) => ({ index, codec, width: 1, height: 1, fps: 30, rotation: 0 })),
  audio: audio.map((codec, index) => ({ index, codec, sampleRate: 48000, channels: 2 })),
})

describe('needsPhoneTranscode', () => {
  it('leaves H.264/AAC in mp4 alone', () => {
    expect(needsPhoneTranscode(probe('mov,mp4,m4a,3gp,3g2,mj2', ['h264']))).toBe(false)
    expect(needsPhoneTranscode(probe('mov,mp4,m4a,3gp,3g2,mj2', ['hevc'], []))).toBe(false)
  })
  it('converts AV1 and VP9, even inside an mp4', () => {
    expect(needsPhoneTranscode(probe('mov,mp4,m4a,3gp,3g2,mj2', ['av1']))).toBe(true)
    expect(needsPhoneTranscode(probe('matroska,webm', ['vp9'], ['opus']))).toBe(true)
  })
  it('converts H.264 that sits in a container AVPlayer does not open', () => {
    expect(needsPhoneTranscode(probe('matroska,webm', ['h264']))).toBe(true)
  })
  it('converts an mp4 whose audio is opus', () => {
    expect(needsPhoneTranscode(probe('mov,mp4,m4a,3gp,3g2,mj2', ['h264'], ['opus']))).toBe(true)
  })
  it('does not touch a file with no video', () => {
    expect(needsPhoneTranscode(probe('mp3', []))).toBe(false)
  })
})

describe('transcode helpers', () => {
  it('builds an H.264/AAC faststart command with even dimensions', () => {
    const args = transcodeArgs('/in.webm', '/out.mp4').join(' ')
    expect(args).toContain('-c:v libx264')
    expect(args).toContain('-pix_fmt yuv420p')
    expect(args).toContain('-c:a aac')
    expect(args).toContain('+faststart')
    expect(args).toContain('trunc(iw/2)*2')
  })
  it('keys the cache by path, size and mtime', () => {
    expect(cacheName('/a.mp4', 1, 1)).toBe(cacheName('/a.mp4', 1, 1))
    expect(cacheName('/a.mp4', 1, 1)).not.toBe(cacheName('/a.mp4', 2, 1))
    expect(cacheName('/a.mp4', 1, 1)).toMatch(/^[0-9a-f]{24}\.mp4$/)
  })
})
