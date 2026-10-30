import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { motionVideoAudioTracks, videoFileIn, type MotionVideoFact } from './motion-video-audio'

// path.resolve, and not join: the module resolves the folder before composing the
// path, and on Windows that puts the drive in front (\tmp -> C:\tmp).
const folder = path.resolve('/tmp', 'piece')
const fact = (over: Partial<MotionVideoFact> = {}): MotionVideoFact => ({
  src: 'orbit-motion://mv_abc/clip.mp4',
  muted: false,
  loop: false,
  gain: 0,
  start: 0,
  in: 0,
  ...over,
})
const yes = async () => true

describe('videoFileIn', () => {
  it('reads the scheme URL and the relative path, decoding', () => {
    expect(videoFileIn(folder, 'orbit-motion://mv_abc/clip.mp4')).toBe(path.join(folder, 'clip.mp4'))
    expect(videoFileIn(folder, 'orbit-motion://mv_abc/sub%20dir/a%20b.mp4?r=3')).toBe(path.join(folder, 'sub dir', 'a b.mp4'))
    expect(videoFileIn(folder, 'media/clip.mp4#t=2')).toBe(path.join(folder, 'media', 'clip.mp4'))
  })

  it('refuses what is outside the folder or not from the scheme', () => {
    expect(videoFileIn(folder, '../outro/clip.mp4')).toBeNull()
    // The URL parser already collapses the `..`: what is left falls INSIDE the folder, never outside.
    expect(videoFileIn(folder, 'orbit-motion://mv_abc/../../etc/passwd')).toBe(path.join(folder, 'etc', 'passwd'))
    expect(videoFileIn(folder, 'https://cdn.example.com/clip.mp4')).toBeNull()
    expect(videoFileIn(folder, '')).toBeNull()
    expect(videoFileIn(folder, '%E0%A4%A')).toBeNull()
  })
})

describe('motionVideoAudioTracks', () => {
  it('a video with sound becomes a track of the plan, at its own time', async () => {
    const [track] = await motionVideoAudioTracks(folder, [fact({ start: 2, in: 5, end: 9, gain: -6 })], yes)
    expect(track).toMatchObject({
      file: path.join(folder, 'clip.mp4'),
      name: 'clip.mp4 (video)',
      path: 'clip.mp4',
      start: 2,
      end: 9,
      offset: 5,
      gainDb: -6,
      duck: false,
    })
    expect(track.fx).toEqual({ eq: [], automation: [] })
    expect(track).not.toHaveProperty('loop')
  })

  it('the default brings no trim at all — it is the whole track from zero', async () => {
    const [track] = await motionVideoAudioTracks(folder, [fact()], yes)
    expect(track).toMatchObject({ start: 0 })
    expect(track).not.toHaveProperty('end')
    expect(track).not.toHaveProperty('offset')
  })

  it('a muted video makes no sound: muted attribute or data-audio="false"', async () => {
    expect(await motionVideoAudioTracks(folder, [fact({ muted: true })], yes)).toEqual([])
  })

  it('with no audio stream in the file, or a failing ffprobe, it generates nothing and breaks nothing', async () => {
    expect(await motionVideoAudioTracks(folder, [fact()], async () => false)).toEqual([])
    expect(
      await motionVideoAudioTracks(folder, [fact()], async () => {
        throw new Error('ffprobe')
      }),
    ).toEqual([])
  })

  it('outside the folder or from another place stays out', async () => {
    const facts = [fact({ src: '../x.mp4' }), fact({ src: 'https://a/b.mp4' })]
    expect(await motionVideoAudioTracks(folder, facts, yes)).toEqual([])
  })

  it('the same file with the same trim sounds once; different trims each sound', async () => {
    const tracks = await motionVideoAudioTracks(folder, [fact(), fact(), fact({ start: 4 })], yes)
    expect(tracks.map((t) => t.start)).toEqual([0, 4])
  })

  it('loop is passed through and end before start is ignored', async () => {
    const [looped] = await motionVideoAudioTracks(folder, [fact({ loop: true })], yes)
    expect(looped.loop).toBe(true)
    const [bad] = await motionVideoAudioTracks(folder, [fact({ start: 5, end: 2 })], yes)
    expect(bad).not.toHaveProperty('end')
  })

  it('with no snapshot at all there is no track', async () => {
    expect(await motionVideoAudioTracks(folder, undefined, yes)).toEqual([])
  })
})
