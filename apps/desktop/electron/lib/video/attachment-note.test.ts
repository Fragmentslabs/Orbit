import { describe, expect, it } from 'vitest'
import type { MediaProbe } from './ffmpeg'
import { describeVideoFacts, imageRefLine, videoAttachmentNote } from './attachment-note'

const probe = (over: Partial<MediaProbe> = {}): MediaProbe => ({
  file: '/x/a.mp4',
  durationMs: 754_300,
  sizeBytes: 382_000_000,
  format: 'mov,mp4',
  video: [{ index: 0, codec: 'h264', width: 3840, height: 2160, fps: 29.97, rotation: 0, pixFmt: 'yuv420p' }],
  audio: [{ index: 1, codec: 'aac', sampleRate: 48000, channels: 2 }],
  display: { width: 3840, height: 2160 },
  ...over,
})

describe('describeVideoFacts', () => {
  it('one line: duration, resolution, fps, audio and size', () => {
    expect(describeVideoFacts(probe())).toBe('754.3 s, 3840x2160 @ 29.97 fps, audio 2ch, 382.0 MB')
  })

  it('no audio is said outright; with no probing, that it could not be read', () => {
    expect(describeVideoFacts(probe({ audio: [] }))).toContain('NO audio')
    expect(describeVideoFacts(null)).toMatch(/Could not read/)
  })

  it('uses the DISPLAYED resolution (rotation applied), not the stream one', () => {
    const rotated = probe({
      video: [{ index: 0, codec: 'h264', width: 1920, height: 1080, fps: 30, rotation: 90, pixFmt: 'yuv420p' }],
      display: { width: 1080, height: 1920 },
    })
    expect(describeVideoFacts(rotated)).toContain('1080x1920')
  })
})

describe('videoAttachmentNote', () => {
  const note = videoAttachmentNote({ filename: 'Aula.mp4', id: 'vdo_ab12.mp4', file: '/app/video-attachments/vdo_ab12.mp4', probe: probe() })

  it('is short and carries no content: reference, file and one line of facts', () => {
    expect(note.split('\n')).toHaveLength(4)
    expect(note.length).toBeLessThan(900)
    expect(note).toContain('[Video attached: Aula.mp4 — ref vdo_ab12.mp4]')
    expect(note).toContain('754.3 s, 3840x2160')
  })

  it('says it was NOT watched nor transcribed and when to read each thing', () => {
    expect(note).toContain('NOT watched and NOT transcribed')
    expect(note).toContain('transcribe for what is SAID')
    expect(note).toContain('video_timeline')
    expect(note).toContain('motion_asset')
    expect(note).toContain('only if the request is about using this video')
  })

  it('a video with no audio does not offer to transcribe', () => {
    const silent = videoAttachmentNote({ filename: 'a.mp4', id: 'vdo_x.mp4', file: '/f', probe: probe({ audio: [] }) })
    expect(silent).not.toContain('transcribe for what is SAID')
  })

  it('one problem replaces the rest: no usable reference', () => {
    const refused = videoAttachmentNote({ filename: 'a.mp4', id: 'unavailable', file: '', probe: null, problem: 'The file is not a readable video.' })
    expect(refused).toBe('[Video attached: a.mp4 — ref unavailable]\n(The file is not a readable video.)')
  })
})

describe('imageRefLine', () => {
  it('gives the reference of the stored image; the GIF is described as animated', () => {
    expect(imageRefLine('orbit-media://img_ab12.png', 'foto.png', 'image/png')).toBe(
      '[Image file: foto.png — ref img_ab12.png] (to place it in a motion piece call motion_asset, or in a design canvas design_asset, with this ref; otherwise ignore this line.)',
    )
    expect(imageRefLine('orbit-media://img_cd34.gif', 'dança.gif', 'image/gif')).toContain('GIF (animated)')
    expect(imageRefLine('orbit-media://img_cd34.gif', 'sem-mime.gif', '')).toContain('GIF (animated)')
  })

  it('with no stored image there is no line at all', () => {
    expect(imageRefLine(undefined, 'a.png', 'image/png')).toBe('')
  })
})
