import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'

import { probeMedia, resolveFfmpeg, runFfmpeg, type MediaProbe } from './ffmpeg'

/**
 * Videos for the phone.
 *
 * AVPlayer (iOS) plays H.264/HEVC in mp4/mov. Downloads from yt-dlp are often AV1 or VP9 (in
 * mp4/webm/mkv), which iOS cannot decode (AV1 only on the newest chips, never in the
 * simulator). The desktop keeps the original and, lazily, makes an H.264 copy that is cached;
 * the phone gets the copy only when the source is not playable as it is.
 *
 * The phone asks `…/__orbit-video.json` first: it starts the job (once) and answers with the
 * state; only when it is `ready` the player loads the video URL, which then serves the copy.
 */

export const VIDEO_STATE_FILE = '__orbit-video.json'

export type PhoneVideoState =
  | { state: 'ready' }
  | { state: 'preparing'; progress: number }
  | { state: 'failed'; message: string }

const PLAYABLE_VIDEO_CODECS = new Set(['h264', 'hevc', 'mpeg4', 'mjpeg'])
const PLAYABLE_AUDIO_CODECS = new Set(['aac', 'mp3', 'alac', 'ac3', 'eac3', 'pcm_s16le', 'pcm_s16be', 'pcm_s24le'])
const PLAYABLE_CONTAINERS = /\b(mp4|mov|m4a)\b/

/**
 * Whether iOS plays the file as it is (pure). A file with no video stream (audio only) is left alone;
 * an unknown audio codec (opus, vorbis) is enough to need the copy because the container then
 * is not an Apple one anyway.
 */
export function needsPhoneTranscode(probe: Pick<MediaProbe, 'format' | 'video' | 'audio'>): boolean {
  if (probe.video.length === 0) return false
  const first = probe.video[0]
  if (!PLAYABLE_VIDEO_CODECS.has(first.codec.toLowerCase())) return true
  if (!PLAYABLE_CONTAINERS.test(probe.format)) return true
  if (probe.audio.some((a) => !PLAYABLE_AUDIO_CODECS.has(a.codec.toLowerCase()))) return true
  return false
}

/** ffmpeg arguments of the copy: H.264 yuv420p + AAC, with the index up front so it streams. */
export function transcodeArgs(input: string, output: string): string[] {
  return [
    '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart',
    output,
  ]
}

function cacheDir(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'phone-video')
}

/** Cache key: the source's path, size and mtime, so an edited file gets a new copy. */
export function cacheName(file: string, size: number, mtimeMs: number): string {
  return `${crypto.createHash('sha1').update(`${file}\0${size}\0${Math.round(mtimeMs)}`).digest('hex').slice(0, 24)}.mp4`
}

interface Job {
  state: PhoneVideoState
  output: string
  /** `true` when the source plays as it is: no job, no copy. */
  passthrough: boolean
}

const jobs = new Map<string, Job>()

async function exists(file: string): Promise<boolean> {
  return fsp.stat(file).then((s) => s.isFile() && s.size > 0, () => false)
}

/**
 * State of the video for the phone, starting the transcode if it is needed and not yet running.
 * `source` is the file that is registered; the result `file` is what has to be served.
 */
export async function phoneVideo(source: string): Promise<{ state: PhoneVideoState; file: string }> {
  const stat = await fsp.stat(source)
  const key = `${source}\0${stat.size}\0${Math.round(stat.mtimeMs)}`
  const known = jobs.get(key)
  if (known) return { state: known.state, file: known.passthrough ? source : known.output }

  // Without ffmpeg there is nothing to probe or convert: the file goes as it is.
  if (!resolveFfmpeg()) return { state: { state: 'ready' }, file: source }

  let probe: MediaProbe
  try {
    probe = await probeMedia(source)
  } catch {
    // A file ffprobe cannot read: leave it to the player, which will say so.
    return { state: { state: 'ready' }, file: source }
  }
  if (!needsPhoneTranscode(probe)) {
    jobs.set(key, { state: { state: 'ready' }, output: source, passthrough: true })
    return { state: { state: 'ready' }, file: source }
  }

  const output = path.join(cacheDir(), cacheName(source, stat.size, stat.mtimeMs))
  if (await exists(output)) {
    const job: Job = { state: { state: 'ready' }, output, passthrough: false }
    jobs.set(key, job)
    return { state: job.state, file: output }
  }

  const job: Job = { state: { state: 'preparing', progress: 0 }, output, passthrough: false }
  jobs.set(key, job)
  void (async () => {
    const partial = `${output}.part.mp4`
    try {
      await fsp.mkdir(cacheDir(), { recursive: true })
      await runFfmpeg(transcodeArgs(source, partial), {
        durationMs: probe.durationMs,
        onProgress: (fraction) => {
          job.state = { state: 'preparing', progress: Math.round(fraction * 100) / 100 }
        },
      })
      await fsp.rename(partial, output)
      job.state = { state: 'ready' }
    } catch (error) {
      await fsp.rm(partial, { force: true }).catch(() => {})
      job.state = { state: 'failed', message: error instanceof Error ? error.message.split('\n')[0] : String(error) }
      // A failure is tried again on the next ask (it may have been a full disk, a killed process).
      setTimeout(() => jobs.delete(key), 30_000).unref?.()
    }
  })()
  return { state: job.state, file: output }
}

/** The file to serve to the phone, or `null` when the copy is not ready yet. */
export async function phoneVideoFile(source: string): Promise<string | null> {
  const { state, file } = await phoneVideo(source).catch(() => ({ state: { state: 'ready' } as PhoneVideoState, file: source }))
  return state.state === 'ready' ? file : null
}
