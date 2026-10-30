import { app, protocol } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { AUDIO_SCHEME } from '@shared/media'
import type { MediaSource } from '@shared/media'
import { SAFE_AUDIO_ID, audioMediaId, getMediaEntry, registerAudioMedia } from './media'

export { AUDIO_SCHEME }

/**
 * Conversation audio: the ones attached by the user and the ones the agent generates
 * (audio_generate tool). They enter the chat's media COLLECTION (kind "audio" in
 * the media.ts index — gallery, "In this chat", disk usage, delete), but the
 * file lives in a folder of its own: the index rebuild scans media/ and
 * would register everything there as an image.
 *
 * Served by `orbit-audio://`, a scheme with the `stream` privilege (without it
 * Chromium's <audio> neither plays nor seeks) — registered along with
 * the artifacts', before the app is ready (see registerSchemePrivileges).
 */

const CONTENT_TYPES: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  webm: 'audio/webm',
  flac: 'audio/flac',
}

/** Audio MIME → extension accepted here (the rest falls back to the name's extension). */
const MIME_EXT: Record<string, string> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
}

const AUDIO_EXT = /\.(wav|mp3|m4a|aac|ogg|oga|opus|webm|flac)$/i

/**
 * Audio folder. Exported because on-demand speech (`voice/speech-file`)
 * writes a CACHE WAV there that on purpose does not enter the media index — and
 * `resolveAudioFile` serves any id with a valid format, registered or not.
 */
export function audioDir(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'audio')
}

/** File path of a stored audio — it is what the agent receives through the attachment. */
export function audioFilePath(id: string): string {
  return path.join(audioDir(), id)
}

/** Path of a stored audio, with the id validated (`null` = invalid id).
 *  For whoever serves the file by Range without going through readAudio — the
 *  orbit-audio:// protocol and the companion's HTTP server. */
export function resolveAudioFile(id: string): string | null {
  return SAFE_AUDIO_ID.test(id) ? audioFilePath(id) : null
}

/** Is the attachment an audio? By the MIME, or by the extension when the MIME comes empty. */
export function isAudioFile(mime: string, filename = ''): boolean {
  return mime.startsWith('audio/') || AUDIO_EXT.test(filename)
}

/** Extension to write an audio of the given MIME/name (`null` = a format we do not serve). */
export function audioExt(mime: string, filename = ''): string | null {
  const fromMime = MIME_EXT[mime.split(';')[0].trim().toLowerCase()]
  if (fromMime) return fromMime
  const match = AUDIO_EXT.exec(filename)
  return match ? match[1].toLowerCase() : null
}

/** Writes the audio, registers it in the chat's collection and returns the id and the orbit-audio:// URL. */
export async function saveAudio(
  buffer: Buffer,
  ext: string,
  meta: { sessionId?: string; messageId?: string; name?: string; source: MediaSource },
): Promise<{ id: string; url: string; path: string }> {
  const id = `aud_${Date.now().toString(36)}${randomBytes(4).toString('hex')}.${ext.toLowerCase()}`
  if (!SAFE_AUDIO_ID.test(id)) throw new Error(`unsupported audio format: ${ext}`)
  await fs.mkdir(audioDir(), { recursive: true })
  const file = audioFilePath(id)
  await fs.writeFile(file, buffer)
  await registerAudioMedia({ id, path: file, size: buffer.length, ...meta })
  return { id, url: `${AUDIO_SCHEME}://${id}`, path: file }
}

/**
 * Id of a stored audio from whatever the agent passes: the raw id, the orbit-audio://
 * URL or the file's PATH in the audio folder (what the attachment's note
 * delivers).
 */
export function audioIdFrom(ref: string): string | null {
  const clean = ref.trim().replace(/^ref\s+/i, '')
  const direct = audioMediaId(clean)
  if (direct) return direct
  if (path.isAbsolute(clean) && path.dirname(path.resolve(clean)) === audioDir()) {
    return audioMediaId(path.basename(clean))
  }
  return null
}

/** Bytes and name of a stored audio (`null` if it does not exist). */
export async function readAudio(id: string): Promise<{ buffer: Buffer; name: string } | null> {
  if (!SAFE_AUDIO_ID.test(id)) return null
  try {
    const buffer = await fs.readFile(audioFilePath(id))
    const entry = await getMediaEntry(id)
    return { buffer, name: entry?.name ?? id }
  } catch {
    return null
  }
}

/**
 * Serves orbit-audio://<id> with Range support: <audio> requests chunks to
 * seek a position and to know the duration of formats without a header.
 */
export function registerAudioProtocol(): void {
  protocol.handle(AUDIO_SCHEME, async (request) => {
    const id = audioMediaId(new URL(request.url).host)
    if (!id) return new Response('not found', { status: 404 })
    let buffer: Buffer
    try {
      buffer = await fs.readFile(audioFilePath(id))
    } catch {
      return new Response('not found', { status: 404 })
    }
    const type = CONTENT_TYPES[id.split('.').pop() ?? ''] ?? 'application/octet-stream'
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '')
    if (range) {
      const size = buffer.length
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2] || 0))
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
      if (start >= size || start > end) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
      }
      return new Response(new Uint8Array(buffer.subarray(start, end + 1)), {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
        },
      })
    }
    return new Response(new Uint8Array(buffer), {
      headers: { 'Content-Type': type, 'Content-Length': String(buffer.length), 'Accept-Ranges': 'bytes' },
    })
  })
}
