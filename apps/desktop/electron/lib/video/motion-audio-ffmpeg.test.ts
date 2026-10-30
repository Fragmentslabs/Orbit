import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * The MUX of the piece's audio with the real ffmpeg. The video comes out of the same
 * rawvideo path as the render (raw frames on stdin) and the sound comes in on a final pass —
 * only here there is no window capture, so one can check end to end
 * what the arguments alone do not prove:
 *
 *   1. the length is the COMPOSITION's, not the audio's;
 *   2. shorter audio does NOT shorten the video (that is what `-shortest` would do, and it is the
 *      reflex this test exists to hold back);
 *   3. the codec follows the container (aac in mp4, Opus in webm — aac in webm is
 *      refused by the muxer).
 *
 * Without ffmpeg on the machine, the suite skips (like render.test.ts and motion's ffmpeg).
 */

const desktop = path.resolve(__dirname, '../../..')
const bundled = path.join(desktop, 'resources', 'ffmpeg', `${process.platform}-${process.arch}`)
const hasFfmpeg = fs.existsSync(path.join(bundled, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))
const work = path.join(os.tmpdir(), `orbit-motion-audio-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => work, getAppPath: () => desktop, isPackaged: false },
  protocol: {},
  BrowserWindow: class {},
}))

const { runFfmpeg, runFfprobe } = await import('./ffmpeg')
const { motionAudioFfmpegArgs, motionAudioMixFfmpegArgs, motionFfmpegArgs } = await import('./motion-render-args')
const { motionVideoAudioTracks } = await import('./motion-video-audio')

const W = 64
const H = 64
const FPS = 5
/** This test's piece: 4 frames at 5 fps = 0.8s. */
const FRAMES = 4
const PIECE = FRAMES / FPS

/** An opaque frame, as the path without alpha (black-background window) delivers. */
function opaqueFrame(r: number, g: number, b: number): Buffer {
  const frame = Buffer.alloc(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    frame[i * 4] = b
    frame[i * 4 + 1] = g
    frame[i * 4 + 2] = r
    frame[i * 4 + 3] = 255
  }
  return frame
}

/** The stdin of one track: the same bytes, frame after frame. */
function frames(frame: Buffer, count: number): Readable {
  return Readable.from([Buffer.concat(Array.from({ length: count }, () => frame))])
}

/** The arguments of ONE track, as the render builds them (one track = the whole video). */
function bandArgs(format: Parameters<typeof motionFfmpegArgs>[0]['format'], output: string): string[] {
  return motionFfmpegArgs({ width: W, height: H, captureWidth: W, captureHeight: H, fps: FPS, format, output })
}

/**
 * A 440 Hz tone in mono PCM16, built here and handed raw to the stdin of
 * ffmpeg: real audio without depending on lavfi (the build the app ships with
 * is not required to bring the synthesis filters).
 */
async function tone(file: string, seconds: number): Promise<void> {
  const samples = Math.round(44100 * seconds)
  const pcm = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    pcm.writeInt16LE(Math.round(Math.sin((i / 44100) * 2 * Math.PI * 440) * 8000), i * 2)
  }
  await runFfmpeg(['-v', 'error', '-f', 's16le', '-ar', '44100', '-ac', '1', '-i', 'pipe:0', file], {
    stdin: Readable.from([pcm]),
  })
}

async function frameCount(file: string): Promise<number> {
  const { stdout } = await runFfprobe([
    '-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file,
  ])
  return Number(stdout.toString().trim())
}

async function duration(file: string): Promise<number> {
  const { stdout } = await runFfprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
  return Number(stdout.toString().trim())
}

async function audioCodec(file: string): Promise<string> {
  const { stdout } = await runFfprobe([
    '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file,
  ])
  return stdout.toString().trim()
}

/**
 * Audio peak in a stretch, from 0 to 1, measured on the decoded PCM. It is what proves
 * that the track is at the declared INSTANT — that the file has sound, ffprobe already says.
 */
async function peak(file: string, from: number, to: number): Promise<number> {
  const raw = `${file}.${from}-${to}.raw`
  await runFfmpeg(['-v', 'error', '-i', file, '-f', 's16le', '-ac', '1', '-ar', '8000', raw])
  const pcm = await fsp.readFile(raw)
  let max = 0
  for (let i = Math.floor(from * 8000); i < Math.min(Math.ceil(to * 8000), pcm.length / 2); i++) {
    max = Math.max(max, Math.abs(pcm.readInt16LE(i * 2)) / 32768)
  }
  return max
}

/** Builds the piece's silent video (one track, like the sequential path). */
async function muteVideo(file: string, format: Parameters<typeof bandArgs>[0]): Promise<void> {
  await runFfmpeg(bandArgs(format, file), { stdin: frames(opaqueFrame(0, 200, 90), FRAMES) })
}

describe.skipIf(!hasFfmpeg)('composition audio (real ffmpeg)', () => {
  beforeAll(async () => {
    await fsp.mkdir(work, { recursive: true })
  })

  afterAll(async () => {
    await fsp.rm(work, { recursive: true, force: true })
  })

  it('longer audio is cut at the end of the piece, with no re-encode and no dropped frame', async () => {
    const video = path.join(work, 'mute-long.mp4')
    await muteVideo(video, 'mp4')
    const audio = path.join(work, 'tone-2s.wav')
    await tone(audio, 2)
    const out = path.join(work, 'with-long-audio.mp4')

    await runFfmpeg(motionAudioFfmpegArgs({ video, audio, output: out, duration: PIECE, format: 'mp4' }))

    expect(await audioCodec(out)).toBe('aac')
    // `-t` cuts the sound, not the picture: frame by frame the whole piece remains.
    expect(await frameCount(out)).toBe(FRAMES)
    expect(await duration(out)).toBeCloseTo(PIECE, 1)
  })

  it('shorter audio leaves the tail silent, without shortening the video', async () => {
    const video = path.join(work, 'mute-short.mp4')
    await muteVideo(video, 'mp4')
    const audio = path.join(work, 'tone-short.wav')
    await tone(audio, 0.15)
    const out = path.join(work, 'with-short-audio.mp4')

    await runFfmpeg(motionAudioFfmpegArgs({ video, audio, output: out, duration: PIECE, format: 'mp4' }))

    expect(await audioCodec(out)).toBe('aac')
    // This is WHERE `-shortest` would break: with it the video would come out with 1 frame.
    expect(await frameCount(out)).toBe(FRAMES)
    expect(await duration(out)).toBeCloseTo(PIECE, 1)
  })

  it('webm takes Opus: the container does not accept aac', async () => {
    const video = path.join(work, 'mute.webm')
    await muteVideo(video, 'webm')
    const audio = path.join(work, 'tone-webm.wav')
    await tone(audio, 1)
    const out = path.join(work, 'with-audio.webm')

    await runFfmpeg(motionAudioFfmpegArgs({ video, audio, output: out, duration: PIECE, format: 'webm' }))

    expect(await audioCodec(out)).toBe('opus')
    expect(await frameCount(out)).toBe(FRAMES)
  })

  it('the track enters at the declared INSTANT: before start is silence', async () => {
    const video = path.join(work, 'mix-late.mp4')
    await muteVideo(video, 'mp4')
    const audio = path.join(work, 'late.wav')
    await tone(audio, 0.3)
    const out = path.join(work, 'with-late.mp4')

    await runFfmpeg(
      motionAudioMixFfmpegArgs({
        video,
        output: out,
        duration: PIECE,
        format: 'mp4',
        events: [{ file: audio, start: 0.4, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false }],
      }),
    )

    // `adelay` must have pushed the sound for real: nothing before 0.4s, sound
    // after. That is what the arguments alone do not prove — only ffmpeg.
    expect(await peak(out, 0, 0.3)).toBeLessThan(0.001)
    expect(await peak(out, 0.45, 0.68)).toBeGreaterThan(0.01)
    expect(await duration(out)).toBeCloseTo(PIECE, 1)
  })

  it('bed with duck + narration + effect: the graph runs and the length is the piece one', async () => {
    const video = path.join(work, 'mix-bed.mp4')
    await muteVideo(video, 'mp4')
    const voice = path.join(work, 'voice.wav')
    const bed = path.join(work, 'bed.wav')
    const hit = path.join(work, 'hit.wav')
    await tone(voice, PIECE)
    await tone(bed, 2)
    await tone(hit, 0.2)
    const out = path.join(work, 'with-bed.mp4')

    await runFfmpeg(
      motionAudioMixFfmpegArgs({
        video,
        output: out,
        duration: PIECE,
        format: 'mp4',
        events: [
          { file: voice, start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false },
          { file: bed, start: 0, gainDb: -18, fadeIn: 0.2, fadeOut: 0.3, duck: true },
          { file: hit, start: 0.5, gainDb: -6, fadeIn: 0, fadeOut: 0, duck: false },
        ],
      }),
    )

    // `sidechaincompress` with this graph's labels is the most fragile piece:
    // if it did not run, an error would come out here and not a file.
    expect(await audioCodec(out)).toBe('aac')
    expect(await frameCount(out)).toBe(FRAMES)
    // The bed is 2s long in a 0.8s piece: `-t` cuts it, and nothing stretches the file.
    expect(await duration(out)).toBeCloseTo(PIECE, 1)
    expect(await duration(out)).toBeLessThan(PIECE + 0.2)
  })

  // The treatment is a hand-written ffmpeg filter: running it is the only proof that the graph is
  // valid (option name, expression quotes, labels) AND that it does what it says.
  describe('tratamento', () => {
    const plainEvent = { start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, duck: false }
    const noFx = { eq: [], automation: [] }

    it('high-pass, eq, compressor and volume curve: the graph runs and the curve RAISES the level', async () => {
      const video = path.join(work, 'fx-video.mp4')
      await muteVideo(video, 'mp4')
      const voice = path.join(work, 'fx-voice.wav')
      await tone(voice, PIECE)
      const out = path.join(work, 'fx.mp4')

      await runFfmpeg(
        motionAudioMixFfmpegArgs({
          video,
          output: out,
          duration: PIECE,
          format: 'mp4',
          events: [
            {
              ...plainEvent,
              file: voice,
              fx: {
                ...noFx,
                highpass: 80,
                eq: [{ freq: 440, gain: 3, q: 1 }],
                compress: { threshold: -24, ratio: 3, attack: 5, release: 100, makeup: 0 },
                // Starts 30 dB down and reaches 0 dB at the end of the piece.
                automation: [
                  { at: 0, db: -30 },
                  { at: PIECE, db: 0 },
                ],
              },
            },
          ],
        }),
      )

      expect(await audioCodec(out)).toBe('aac')
      expect(await frameCount(out)).toBe(FRAMES)
      // The curve is by PIECE TIME: the start comes out much lower than the end.
      expect(await peak(out, 0.05, 0.2)).toBeLessThan(await peak(out, 0.6, 0.78))
    })

    it('the curve also applies to a track that enters late (t is the piece one, after the delay)', async () => {
      const video = path.join(work, 'fx-late-video.mp4')
      await muteVideo(video, 'mp4')
      const hit = path.join(work, 'fx-late.wav')
      await tone(hit, 0.4)
      const out = path.join(work, 'fx-late.mp4')

      await runFfmpeg(
        motionAudioMixFfmpegArgs({
          video,
          output: out,
          duration: PIECE,
          format: 'mp4',
          // Enters at 0.4s; the curve says "muted until 0.5s". If t were the track's
          // (and not the piece's), the 0.4–0.5 stretch would still be muted for another 0.5s.
          events: [
            {
              ...plainEvent,
              start: 0.4,
              file: hit,
              fx: {
                ...noFx,
                automation: [
                  { at: 0.5, db: -60 },
                  { at: 0.52, db: 0 },
                ],
              },
            },
          ],
        }),
      )

      expect(await peak(out, 0.41, 0.49)).toBeLessThan(0.001)
      expect(await peak(out, 0.6, 0.78)).toBeGreaterThan(0.01)
    })

    it('the true-peak ceiling holds the sound, and the delivery volume runs in the same graph', async () => {
      const video = path.join(work, 'master-video.mp4')
      await muteVideo(video, 'mp4')
      const loud = path.join(work, 'master-loud.wav')
      await tone(loud, PIECE)
      const raw = path.join(work, 'master-raw.mp4')
      const limited = path.join(work, 'master-limited.mp4')
      const normalized = path.join(work, 'master-normalized.mp4')
      const base = { video, duration: PIECE, format: 'mp4' as const }
      // +12 dB over an already strong tone: goes past 1.0 with no ceiling.
      const events = [{ ...plainEvent, file: loud, gainDb: 12 }]

      await runFfmpeg(motionAudioMixFfmpegArgs({ ...base, output: raw, events }))
      await runFfmpeg(motionAudioMixFfmpegArgs({ ...base, output: limited, events, master: { limit: -6 } }))
      await runFfmpeg(motionAudioMixFfmpegArgs({ ...base, output: normalized, events, master: { loudness: -16, limit: -1 } }))

      const ceiling = Math.pow(10, -6 / 20)
      expect(await peak(limited, 0.1, 0.7)).toBeLessThanOrEqual(ceiling + 0.03)
      expect(await peak(limited, 0.1, 0.7)).toBeLessThan(await peak(raw, 0.1, 0.7))
      // loudnorm returns 192 kHz; without the aresample the aac would come out at an absurd rate.
      const { stdout } = await runFfprobe(['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate', '-of', 'csv=p=0', normalized])
      expect(Number(stdout.toString().trim())).toBe(48000)
      expect(await frameCount(normalized)).toBe(FRAMES)
    })

    it('initial cut: the sound starts at the requested FILE point, at the piece instant', async () => {
      const video = path.join(work, 'offset-video.mp4')
      await muteVideo(video, 'mp4')
      // 0.3s of silence and then 0.5s of tone: cutting at 0.3 leaves only the tone.
      const src = path.join(work, 'offset-src.wav')
      const rate = 44100
      const pcm = Buffer.alloc(Math.round(rate * 0.8) * 2)
      for (let i = Math.round(rate * 0.3); i < rate * 0.8; i++) {
        pcm.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 8000), i * 2)
      }
      await runFfmpeg(['-v', 'error', '-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', 'pipe:0', src], {
        stdin: Readable.from([pcm]),
      })
      const out = path.join(work, 'offset.mp4')

      await runFfmpeg(
        motionAudioMixFfmpegArgs({
          video,
          output: out,
          duration: PIECE,
          format: 'mp4',
          events: [{ ...plainEvent, file: src, start: 0.2, offset: 0.3 }],
        }),
      )
      // Before the start: silence. Right after it there is already tone (the silence at the beginning of the
      // file was cut) — without the cut, the tone would only arrive at 0.5s. This is the
      // measurement that caught mp4/aac eating the delay's silence.
      expect(await peak(out, 0, 0.18)).toBeLessThan(0.001)
      expect(await peak(out, 0.25, 0.4)).toBeGreaterThan(0.01)
    })

    it('loop: a short file covers the whole piece', async () => {
      const video = path.join(work, 'loop-video.mp4')
      await muteVideo(video, 'mp4')
      const short = path.join(work, 'loop-short.wav')
      await tone(short, 0.2)
      const out = path.join(work, 'loop.mp4')

      await runFfmpeg(
        motionAudioMixFfmpegArgs({
          video,
          output: out,
          duration: PIECE,
          format: 'mp4',
          events: [{ ...plainEvent, file: short, loop: true }],
        }),
      )
      expect(await peak(out, 0.6, 0.78)).toBeGreaterThan(0.01)
      expect(await duration(out)).toBeCloseTo(PIECE, 1)
    })

    it('the sound of a <video> only enters when the file HAS an audio stream (real ffprobe)', async () => {
      const silent = path.join(work, 'clip-silent.mp4')
      await muteVideo(silent, 'mp4')
      const voice = path.join(work, 'clip-voice.wav')
      await tone(voice, PIECE)
      const talking = path.join(work, 'clip-talking.mp4')
      await runFfmpeg(motionAudioFfmpegArgs({ video: silent, audio: voice, output: talking, duration: PIECE, format: 'mp4' }))

      const fact = (file: string) => ({
        src: `orbit-motion://mv_x/${path.basename(file)}`,
        muted: false,
        loop: false,
        gain: 0,
        start: 0,
        in: 0,
      })
      // Without passing a prober: it is the app's ffprobe that answers.
      const tracks = await motionVideoAudioTracks(work, [fact(silent), fact(talking)])
      expect(tracks.map((t) => t.name)).toEqual(['clip-talking.mp4 (video)'])
    })

    it('the custom duck runs with the graph labels', async () => {
      const video = path.join(work, 'duck-video.mp4')
      await muteVideo(video, 'mp4')
      const voice = path.join(work, 'duck-voice.wav')
      const bed = path.join(work, 'duck-bed.wav')
      await tone(voice, 0.3)
      await tone(bed, PIECE)
      const out = path.join(work, 'duck.mp4')

      await runFfmpeg(
        motionAudioMixFfmpegArgs({
          video,
          output: out,
          duration: PIECE,
          format: 'mp4',
          events: [
            { ...plainEvent, file: voice },
            { ...plainEvent, file: bed, duck: true, duckSettings: { threshold: 0.01, ratio: 8, attack: 10, release: 100 } },
          ],
        }),
      )
      expect(await frameCount(out)).toBe(FRAMES)
    })
  })
})
