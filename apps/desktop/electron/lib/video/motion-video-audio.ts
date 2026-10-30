import path from 'node:path'
import type { MotionAudioTrack } from './motion-audio'
import { NO_FX } from './motion-audio-fx'

/**
 * The SOUND of a composition's `<video>`s.
 *
 * The runtime mutes every video on the page (the render window has no sound and the
 * seek positions the file frame by frame), so the sound the author expects to
 * hear — the speech of a testimony, the ambience of a b-roll — was lost along
 * the way. Here it comes back through the door that already exists: it becomes a TRACK of the
 * audio plan, exactly like one declared in `audio.json`. The render mixes it, the
 * tab plays it on its own line, and the lint checks it — no parallel path.
 *
 * What decides whether a video sounds: the file having an audio track, and the author not
 * having muted it (`muted` attribute, or `data-audio="false"`). The time comes from the
 * same attributes the runtime uses to position the picture (`data-start`,
 * `data-in`, `data-end`, `loop`), so sound and picture cannot disagree.
 */

/** The snapshot of a `<video>` that the runtime publishes (see `videoFacts`). */
export interface MotionVideoFact {
  src: string
  muted: boolean
  loop: boolean
  /** dB. */
  gain: number
  start: number
  in: number
  end?: number
}

/**
 * Path of the file inside the folder from the `src` the runtime read: the scheme
 * URL (`orbit-motion://<id>/clip.mp4`) or a relative path. Outside the
 * folder, or a URL from elsewhere, it is `null` — the scheme serves nothing from there and the
 * lint already warns about the file.
 */
export function videoFileIn(folder: string, src: string): string | null {
  let rel: string
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(src)) {
    let url: URL
    try {
      url = new URL(src)
    } catch {
      return null
    }
    if (url.protocol !== 'orbit-motion:') return null
    rel = url.pathname
  } else {
    rel = src.split(/[?#]/)[0]
  }
  try {
    rel = decodeURIComponent(rel)
  } catch {
    return null
  }
  rel = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!rel) return null
  const root = path.resolve(folder)
  const file = path.resolve(root, rel)
  const inside = path.relative(root, file)
  return inside.startsWith('..') || path.isAbsolute(inside) ? null : file
}

/** Does the file have an audio track? Injectable: the default asks ffprobe. */
export type HasAudio = (file: string) => Promise<boolean>

async function probeHasAudio(file: string): Promise<boolean> {
  // Late import: the app's ffmpeg pulls in Electron, and this module needs to be
  // testable without it.
  const { probeMedia } = await import('./ffmpeg')
  return (await probeMedia(file)).audio.length > 0
}

/**
 * The audio tracks of the page's videos. A muted video, outside the folder, with no audio
 * track or unreadable generates nothing — and never takes down the caller. The same file
 * with the same trim, used by two elements, sounds only once.
 */
export async function motionVideoAudioTracks(
  folder: string,
  facts: MotionVideoFact[] | undefined,
  hasAudio: HasAudio = probeHasAudio,
): Promise<MotionAudioTrack[]> {
  const root = path.resolve(folder)
  const seen = new Set<string>()
  const tracks: MotionAudioTrack[] = []
  for (const fact of facts ?? []) {
    if (fact.muted) continue
    const file = videoFileIn(root, fact.src)
    if (!file) continue
    const key = [file, fact.start, fact.in, fact.end, fact.loop].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    if (!(await hasAudio(file).catch(() => false))) continue
    const end = typeof fact.end === 'number' && fact.end > fact.start ? fact.end : undefined
    tracks.push({
      file,
      name: `${path.basename(file)} (video)`,
      path: path
        .relative(root, file)
        .split(path.sep)
        .map((segment) => encodeURIComponent(segment))
        .join('/'),
      start: Math.max(0, fact.start),
      ...(end !== undefined ? { end } : {}),
      gainDb: Number.isFinite(fact.gain) ? fact.gain : 0,
      fadeIn: 0,
      fadeOut: 0,
      duck: false,
      fx: { ...NO_FX, eq: [], automation: [] },
      ...(fact.in > 0 ? { offset: fact.in } : {}),
      ...(fact.loop ? { loop: true } : {}),
    })
  }
  return tracks
}
