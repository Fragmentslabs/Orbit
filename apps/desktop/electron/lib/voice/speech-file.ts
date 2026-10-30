/**
 * Reading aloud ON DEMAND, delivered as a FILE — the companion app's path.
 *
 * The desktop speaks in streaming (`voice:tts:chunk` + `ChunkPlayer` in the renderer):
 * raw PCM16 scheduled in an AudioContext. The phone has no AudioContext nor a
 * cheap way to play live PCM, so the speech travels another way:
 * the text goes in `POST /api/voice/speak`, the desktop synthesises, writes a WAV and
 * returns the signed URL of the `audio` scope — the SAME route the phone's
 * player already uses for the agent's audios (with Range, so seeking a
 * position works).
 *
 * The WAV lives in the audio folder, but does NOT enter the media index on purpose:
 * listening to the same answer ten times would fill the gallery with ten identical entries.
 * Since `resolveAudioFile` validates only the SHAPE of the id (the file existing is enough), an
 * id outside the index is servable all the same.
 *
 * CACHE: the id is the hash of (text, voice, language, speed), so listening again
 * to the same answer synthesises nothing — the second tap is instant. The
 * manifest next to the cache stores the duration (avoids reopening the WAV) and serves as
 * the list for pruning: without it, every answer heard would leave a file
 * forever.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { audioDir, audioFilePath } from '../audio-store'
import { synthesizeToWav } from './index'

/** Changes when the recorded audio changes format — it invalidates the whole cache. */
const CACHE_VERSION = 'v1'

/** How many speech WAVs are kept; above that the oldest leaves. */
export const MAX_SPEECH_CACHE_FILES = 200

const MANIFEST = 'speech-cache.json'

export interface SpokenFile {
  /** Id in the audio pool (`aud_….wav`) — serves the WAV through the `audio` scope. */
  id: string
  /** Audio duration, in milliseconds. */
  durationMs: number
  /** It was already synthesised: the answer came from the cache. */
  cached: boolean
}

export interface SpeakFileOptions {
  voice?: string
  /** Language (`pt`, `en`, …) or `auto`; absent = the one from the preferences. */
  lang?: string
  speed?: number
}

/** What the manifest stores per file — and it is what is left to prune. */
type Manifest = Record<string, { durationMs: number; usedAt: number }>

function manifestPath(): string {
  return path.join(audioDir(), MANIFEST)
}

async function readManifest(): Promise<Manifest> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(manifestPath(), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Manifest
  } catch {
    // No manifest (first time, corrupted file): the cache starts over. The worst
    // case is synthesising again — never serving a file that does not exist.
    return {}
  }
}

async function writeManifest(manifest: Manifest): Promise<void> {
  await fs.mkdir(audioDir(), { recursive: true })
  const target = manifestPath()
  // Temporary + rename: a concurrent read sees the whole old manifest,
  // never a half-written JSON.
  const tmp = `${target}.${process.pid}.part`
  await fs.writeFile(tmp, JSON.stringify(manifest))
  await fs.rename(tmp, target)
}

/**
 * Id of the cache WAV: `aud_<24 hex>.wav` — the same shape `SAFE_AUDIO_ID`
 * requires (it is what makes the file servable), with no timestamp, because here the
 * content IS the key.
 */
export function speechCacheId(text: string, opts: SpeakFileOptions = {}): string {
  const hash = createHash('sha256')
    .update(
      [CACHE_VERSION, opts.voice ?? '', opts.lang ?? '', String(opts.speed ?? ''), text].join('\u0000'),
    )
    .digest('hex')
    .slice(0, 24)
  return `aud_${hash}.wav`
}

/**
 * Synthesises (or reuses) the speech WAV. Returns the id and the duration; the
 * caller builds the signed URL, which depends on the request host.
 */
export async function speakToFile(text: string, opts: SpeakFileOptions = {}): Promise<SpokenFile> {
  const target = String(text ?? '').trim()
  if (!target) throw new Error('nothing to speak: the text is empty')

  const id = speechCacheId(target, opts)
  const manifest = await readManifest()
  const stored = manifest[id]
  if (stored) {
    try {
      await fs.access(audioFilePath(id))
      manifest[id] = { durationMs: stored.durationMs, usedAt: Date.now() }
      await writeManifest(manifest)
      return { id, durationMs: stored.durationMs, cached: true }
    } catch {
      // The manifest swore it existed and it does not (folder cleaned from outside):
      // synthesise again, as if it had never been there.
      delete manifest[id]
    }
  }

  const { wav, durationMs } = await synthesizeToWav(target, opts)
  await fs.mkdir(audioDir(), { recursive: true })
  const file = audioFilePath(id)
  const tmp = `${file}.${process.pid}.part`
  await fs.writeFile(tmp, wav)
  // Rename is atomic: two "listen" requests on the same text do not make the player open a
  // half-written WAV.
  await fs.rename(tmp, file)

  manifest[id] = { durationMs, usedAt: Date.now() }
  await prune(manifest)
  return { id, durationMs, cached: false }
}

/** Writes the manifest and, if the ceiling was exceeded, deletes the oldest WAVs. */
async function prune(manifest: Manifest): Promise<void> {
  const ids = Object.keys(manifest)
  if (ids.length > MAX_SPEECH_CACHE_FILES) {
    ids.sort((a, b) => manifest[a].usedAt - manifest[b].usedAt)
    for (const id of ids.slice(0, ids.length - MAX_SPEECH_CACHE_FILES)) {
      delete manifest[id]
      await fs.rm(audioFilePath(id), { force: true }).catch(() => {
        // It was no longer there — the manifest was what was out of date.
      })
    }
  }
  await writeManifest(manifest)
}
