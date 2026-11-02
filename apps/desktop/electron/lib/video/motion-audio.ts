import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  parseDuck,
  parseMasterFx,
  parseTrackFx,
  type DuckSettings,
  type MasterFx,
  type TrackFx,
} from './motion-audio-fx'
import { isMotionAudioFile } from './motion-render-args'

/**
 * The AUDIO of a motion composition: WHICH files they are, when each one enters and
 * how the preview reaches them.
 *
 * The frame capture does not pick up sound (offscreen window + rawvideo on stdin), so
 * the tracks enter on a final pass of the render (motion.ts), which positions them and
 * mixes them with the filter graph of motion-render-args. So that what the user
 * hears in the tab is what comes out in the file, this module alone chooses the audio: the
 * render, the tracks the tab draws and what the agent reads in motion_preview all come
 * from here.
 *
 * Three doors, in this order:
 *  1. explicit path (the tool sends the file it just generated) — one track,
 *     the whole piece;
 *  2. `audio.json` in the composition's folder — the manifest, with as many tracks as it wants,
 *     each one at its instant (background music, one-off effect, narration);
 *  3. the conventional loose name in the folder (`audio.mp3`, `audio.wav`…) — one track.
 */

/** The folder's manifest: it is what declares the tracks and the instants. */
export const MOTION_AUDIO_MANIFEST = 'audio.json'

export interface MotionAudioTrack {
  /** Absolute path — it is what the render's ffmpeg opens. */
  file: string
  /** Name for the interface: the manifest's label, or the file name. */
  name: string
  /**
   * Path relative to the folder, already escaped (`voz.mp3`, `audio/voz.mp3`): it is what
   * the scheme serves at `orbit-motion://<id>/<path>`. `null` when the file is
   * OUTSIDE the folder — the render muxes it (ffmpeg opens the absolute path), but the
   * scheme serves nothing outside the composition, so the preview does not play it.
   */
  path: string | null
  /** Second of the piece at which the track comes IN. */
  start: number
  /** Second of the piece at which it goes OUT; absent = to the end of the file. */
  end?: number
  /** Level in dB (0 = as it is). */
  gainDb: number
  /** In and out ramps, in seconds. */
  fadeIn: number
  fadeOut: number
  /** Bed that goes down by itself while the other tracks are playing. */
  duck: boolean
  /** How it goes down, when the manifest customized it; absent = the usual numbers. */
  duckSettings?: DuckSettings
  /** Timbre, dynamics and volume-curve treatment (motion-audio-fx.ts). */
  fx: TrackFx
  /** Second OF THE FILE at which the sound starts (the `data-in` of a video). */
  offset?: number
  /** Repeats the file until the track ends (a video with `loop`). */
  loop?: boolean
}

/** What the render mixes: the tracks and the finishing of the whole mix. */
export interface MotionAudioPlan {
  tracks: MotionAudioTrack[]
  master: MasterFx | null
}

/** What the manifest accepts per track: only `file` is required. */
interface ManifestTrack {
  file: string
  name?: string
  start?: number
  end?: number
  /** Second OF THE FILE where the sound begins (play the chorus without its intro). */
  offset?: number
  /** Repeats the file until `end` (or the end of the piece). */
  loop?: boolean
  /** Level in dB. */
  gain?: number
  /** Linear level (1 = as it is, 0.2 = quiet bed) — the alternative to `gain`. */
  volume?: number
  fadeIn?: number
  fadeOut?: number
  /** `true`, or `{ threshold, ratio, attack, release }` to customize. */
  duck?: boolean | Record<string, unknown>
  /** Treatment shortcut (voice, bed, phone) and the motion-audio-fx.ts fields. */
  preset?: string
  highpass?: number
  lowpass?: number
  eq?: unknown
  compress?: unknown
  automation?: unknown
}

/**
 * The tracks of the composition, in the order the manifest declared them (the order does not
 * change the sound, but it changes the list the tab draws).
 *
 * The explicit path wins — and it MUST exist: asking for an audio that is not there is an
 * error, not silence. So is the manifest: a track without `file`, a file that does not exist
 * or broken JSON are an error with the reason. A declared track that vanishes into
 * silence is worse than a render that fails saying what happened.
 */
export async function motionAudioPlan(
  folder: string,
  explicit?: string,
  /** Tracks that do not come from the manifest — the sound of the page's `<video>`s (motion-video-audio.ts). */
  extra: MotionAudioTrack[] = [],
): Promise<MotionAudioPlan> {
  const plan = await declaredAudioPlan(folder, explicit)
  return extra.length ? { ...plan, tracks: [...plan.tracks, ...extra] } : plan
}

async function declaredAudioPlan(folder: string, explicit?: string): Promise<MotionAudioPlan> {
  const root = path.resolve(folder)
  if (explicit) return { tracks: [await one(root, path.resolve(explicit), path.basename(explicit), {}, 'audio')], master: null }
  const declared = await manifest(root)
  if (declared) {
    return {
      tracks: await Promise.all(
        declared.tracks.map((entry, index) =>
          one(
            root,
            path.resolve(root, entry.file),
            entry.name?.trim() || path.basename(entry.file),
            entry,
            `${MOTION_AUDIO_MANIFEST}: track ${index + 1} (${entry.file})`,
          ),
        ),
      ),
      master: declared.master,
    }
  }
  const loose = await conventionalAudio(root)
  return { tracks: loose ? [await one(root, loose, path.basename(loose), {}, 'audio')] : [], master: null }
}

/** Only the tracks — for whoever does not need the finishing (the tab, the report). */
export async function motionAudioTracks(
  folder: string,
  explicit?: string,
  extra: MotionAudioTrack[] = [],
): Promise<MotionAudioTrack[]> {
  return (await motionAudioPlan(folder, explicit, extra)).tracks
}

/** One track: file checked, servable path computed, defaults applied. */
async function one(
  root: string,
  file: string,
  name: string,
  // Without `file`: the path already came resolved from the caller (the manifest only
  // declares the rest).
  spec: Omit<ManifestTrack, 'file'>,
  // Prefix of the treatment's error messages: it says WHICH track of the manifest.
  where: string,
): Promise<MotionAudioTrack> {
  const stat = await fsp.stat(file).catch(() => null)
  if (!stat?.isFile()) throw new Error(`audio file not found: ${file}`)
  const relative = path.relative(root, file)
  const inside = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  const start = seconds(spec.start, 0)
  const duck = parseDuck(spec.duck, where)
  return {
    file,
    name,
    path: inside ? relative.split(path.sep).map((segment) => encodeURIComponent(segment)).join('/') : null,
    start,
    // An end that is not after the start would be a track that never plays: whoever wrote it
    // made a mistake, and the most useful thing is to play the whole file from `start`
    // rather than make the track vanish without saying anything.
    ...(isAfter(spec.end, start) ? { end: spec.end as number } : {}),
    gainDb: gainOf(spec, where),
    fadeIn: Math.max(0, seconds(spec.fadeIn, 0)),
    fadeOut: Math.max(0, seconds(spec.fadeOut, 0)),
    duck: duck.duck,
    ...(duck.settings ? { duckSettings: duck.settings } : {}),
    fx: parseTrackFx(spec as Record<string, unknown>, where),
    ...(seconds(spec.offset, 0) > 0 ? { offset: seconds(spec.offset, 0) } : {}),
    ...(spec.loop === true ? { loop: true } : {}),
  }
}

/**
 * The level in dB, from `gain` (dB) or `volume` (linear). Both at once is a
 * contradiction the author has to resolve — guessing which one they meant is how
 * a bed ended up at full volume under a narration.
 */
function gainOf(spec: Omit<ManifestTrack, 'file'>, where: string): number {
  const hasVolume = typeof spec.volume === 'number' && Number.isFinite(spec.volume)
  if (hasVolume && typeof spec.gain === 'number') throw new Error(`${where}: use "gain" (dB) or "volume" (linear), not both`)
  if (!hasVolume) return number(spec.gain, 0)
  const volume = spec.volume as number
  if (volume < 0) throw new Error(`${where}: "volume" is linear (0 = silent, 1 = as it is) and cannot be negative`)
  // Silence is a level too: -120 dB is below anything audible, and it keeps the math finite.
  return volume === 0 ? -120 : Math.round(20 * Math.log10(volume) * 100) / 100
}

/**
 * The folder's manifest, or null when it does not exist. Accepts `{ "tracks": [...] }` and the
 * loose list; `file` is the only required field, and the rest has a default.
 */
async function manifest(root: string): Promise<{ tracks: ManifestTrack[]; master: MasterFx | null } | null> {
  const raw = await fsp.readFile(path.join(root, MOTION_AUDIO_MANIFEST), 'utf8').catch(() => null)
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`${MOTION_AUDIO_MANIFEST} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { tracks?: unknown } | null)?.tracks
  if (!Array.isArray(list)) {
    throw new Error(`${MOTION_AUDIO_MANIFEST} must be a list of tracks, or an object with a "tracks" list`)
  }
  const tracks = list.map((entry, index) => {
    const track = (entry ?? {}) as Partial<ManifestTrack>
    const file = typeof track.file === 'string' ? track.file.trim() : ''
    if (!file) throw new Error(`${MOTION_AUDIO_MANIFEST}: track ${index + 1} has no "file"`)
    return { ...track, file }
  })
  // The finishing only exists in object form (the loose list has nowhere to put it).
  const master = Array.isArray(parsed) ? null : parseMasterFx((parsed as { master?: unknown } | null)?.master)
  return { tracks, master }
}

/** The folder's `audio.<ext>`, if there is one (stable order when there is more than one). */
async function conventionalAudio(folder: string): Promise<string | null> {
  const entries = await fsp.readdir(folder).catch(() => null)
  const name = entries?.filter((entry) => isMotionAudioFile(entry)).sort()[0]
  return name ? path.join(folder, name) : null
}

function isAfter(value: unknown, start: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > start
}

function seconds(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : fallback
}

function number(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
