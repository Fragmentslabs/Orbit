import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { audioFilePath, audioIdFrom } from './audio-store'
import type { MediaCredit } from '@shared/media'
import { getMediaEntry, mediaIdFromUrl, setMediaDeleteHook } from './media'
import { unregisterVideosFor } from './video/store'

/**
 * Chat ATTACHMENTS that the agent uses as working material: the video the
 * user sent, the photo, the audio, the GIF.
 *
 * The principle is the one audio already followed: the agent receives only a REFERENCE and a few
 * metadata (name, duration, size), never the content. The content enters
 * the context when it decides to read — transcribe, look at an instant, describe —
 * and goes into a piece when it decides to use it (motion_asset). A 30-minute
 * video costs one line in the context, not its transcription.
 *
 * Three families, three prefixes, all generated here (so trustworthy):
 *   - `vdo_…`  attached video (stored in this folder);
 *   - `aud_…`  audio (audio-store.ts);
 *   - `img_…`  image or GIF (media.ts).
 * `resolveAttachmentRef` is the ONLY way back: the reference becomes a file
 * of the app itself, and nothing the agent writes opens an arbitrary path — it is what
 * keeps `motion_asset` and the reading tools tied to the conversation's attachments.
 */

const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi'] as const
const VIDEO_EXT = new RegExp(`\\.(${VIDEO_EXTENSIONS.join('|')})$`, 'i')
export const SAFE_VIDEO_ATTACHMENT = new RegExp(`^vdo_[a-z0-9]+\\.(${VIDEO_EXTENSIONS.join('|')})$`)

/** Above this an attached video is not copied: the agent is warned, not the disk. */
export const MAX_VIDEO_ATTACHMENT_BYTES = 2 * 1024 ** 3

const MIME_EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/x-m4v': 'm4v',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/x-msvideo': 'avi',
}

export function videoAttachmentDir(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'video-attachments')
}

/** Is the attachment a video? By the MIME, or by the extension when the MIME comes empty. */
export function isVideoFile(mime: string, filename = ''): boolean {
  return mime.startsWith('video/') || VIDEO_EXT.test(filename)
}

/** Extension to store a video (`null` = a format we do not store). */
export function videoAttachmentExt(mime: string, filename = ''): string | null {
  const fromMime = MIME_EXT[mime.split(';')[0].trim().toLowerCase()]
  if (fromMime) return fromMime
  const match = VIDEO_EXT.exec(filename)
  return match ? match[1].toLowerCase() : null
}

/**
 * The disk path of an attachment the renderer sent as `file://…` (a video
 * chosen or dragged). The path comes from the renderer, so it only counts if the REAL
 * extension is a video one: the name declared in the attachment cannot serve as an excuse to
 * copy any file. `null` when it is not a usable file://.
 */
export function videoPathFromFileUrl(url: string): string | null {
  if (!url.startsWith('file://')) return null
  let source: string
  try {
    source = fileURLToPath(url)
  } catch {
    return null
  }
  return VIDEO_EXT.test(source) ? source : null
}

export interface SavedVideoAttachment {
  id: string
  file: string
  size: number
}

/**
 * Stores the attached video. The bytes come from the message (pasting from the
 * clipboard) or from a FILE on disk (drag/choose): the second case
 * is a clone copy when the filesystem supports it (APFS, btrfs), which
 * costs zero space and zero memory; without clone, a regular copy. In neither of
 * the two does the video go wholly through the renderer's memory.
 */
export async function saveVideoAttachment(
  source: { bytes: Buffer } | { copyFrom: string },
  ext: string,
  meta: { sessionId?: string; name?: string } = {},
): Promise<SavedVideoAttachment> {
  const id = `vdo_${Date.now().toString(36)}${randomBytes(4).toString('hex')}.${ext.toLowerCase()}`
  if (!SAFE_VIDEO_ATTACHMENT.test(id)) throw new Error(`unsupported video format: ${ext}`)
  await fsp.mkdir(videoAttachmentDir(), { recursive: true })
  const file = path.join(videoAttachmentDir(), id)
  if ('bytes' in source) {
    await fsp.writeFile(file, source.bytes)
  } else {
    const stat = await fsp.stat(source.copyFrom)
    if (!stat.isFile()) throw new Error('the attached path is not a file')
    if (stat.size > MAX_VIDEO_ATTACHMENT_BYTES) {
      throw new Error(`video is ${(stat.size / 1024 ** 3).toFixed(1)} GB, above the ${MAX_VIDEO_ATTACHMENT_BYTES / 1024 ** 3} GB limit for attachments`)
    }
    await fsp.copyFile(source.copyFrom, file, fs.constants.COPYFILE_FICLONE)
  }
  const size = (await fsp.stat(file)).size
  await rememberName(id, meta.name, meta.sessionId)
  return { id, file, size }
}

/**
 * Stores the attached video. The bytes come from the message (pasting from the
 * clipboard) or from a FILE on disk (drag/choose): the second case
 * is a clone copy when the filesystem supports it (APFS, btrfs), which
 * costs zero space and zero memory; without clone, a regular copy. In neither of
 * the two does the video go wholly through the renderer's memory.
 */
// The file's original name is only for the agent and for the error message: the id
// is what rules. It stays in a small index next to the videos.

function indexPath(): string {
  return path.join(videoAttachmentDir(), 'index.json')
}

async function readNames(): Promise<Record<string, { name?: string; sessionId?: string; createdAt: number }>> {
  try {
    return JSON.parse(await fsp.readFile(indexPath(), 'utf8'))
  } catch {
    return {}
  }
}

let writing: Promise<void> = Promise.resolve()
function rememberName(id: string, name: string | undefined, sessionId: string | undefined): Promise<void> {
  writing = writing.then(async () => {
    const names = await readNames()
    names[id] = { name, sessionId, createdAt: Date.now() }
    const tmp = `${indexPath()}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(names))
    await fsp.rename(tmp, indexPath())
  })
  return writing.catch(() => {})
}

/** Removes the video's name from the attachments index (the file leaves through whoever deletes it). */
function forgetName(id: string): Promise<void> {
  writing = writing.then(async () => {
    const names = await readNames()
    if (!(id in names)) return
    delete names[id]
    const tmp = `${indexPath()}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(names))
    await fsp.rename(tmp, indexPath())
  })
  return writing.catch(() => {})
}

// Deleting the video in the gallery deletes the file (deleteMedia) and, here, whatever else
// points to it: the player URL and the name in the attachments index. Without this there would be
// records pointing to a file that no longer exists.
setMediaDeleteHook('video', async (entry) => {
  await unregisterVideosFor(entry.path)
  await forgetName(entry.id)
  // The cached transcription lives next to the file (transcribe): without the
  // video it is good for nothing and would take up space forever.
  await fsp.rm(path.join(path.dirname(entry.path), 'edit', 'transcripts', `${path.basename(entry.path)}.json`), { force: true })
})

// ------------------------------------------------------------ references

export type AttachmentKind = 'video' | 'audio' | 'image'

export interface ResolvedAttachment {
  kind: AttachmentKind
  id: string
  /** App file (absolute). */
  file: string
  /** Name to show and to give the file inside a piece. */
  name: string
  /** Author and license, when the image came from a web search. */
  credit?: MediaCredit
}

/** Does the string look like an attachment reference (and not a project path)? */
export function looksLikeAttachmentRef(ref: string): boolean {
  return /^(?:ref\s+)?(?:orbit-(?:audio|media):\/\/)?(?:vdo|aud|img)_[a-z0-9]/i.test(ref.trim())
}

/**
 * The reference the agent passed → the attachment. It accepts the id, the scheme URL or the
 * path the attachment's note delivers; it refuses everything else (including a path
 * from inside the app that is not an attachment's).
 */
export async function resolveAttachmentRef(raw: string): Promise<ResolvedAttachment | null> {
  const ref = raw.trim().replace(/^ref\s+/i, '')

  const videoId = SAFE_VIDEO_ATTACHMENT.test(ref)
    ? ref
    : path.isAbsolute(ref) && path.dirname(path.resolve(ref)) === videoAttachmentDir() && SAFE_VIDEO_ATTACHMENT.test(path.basename(ref))
      ? path.basename(ref)
      : null
  if (videoId) {
    const file = path.join(videoAttachmentDir(), videoId)
    if (!fs.existsSync(file)) return null
    const names = await readNames()
    return { kind: 'video', id: videoId, file, name: names[videoId]?.name || videoId }
  }

  const audioId = audioIdFrom(ref)
  if (audioId) {
    const file = audioFilePath(audioId)
    if (!fs.existsSync(file)) return null
    return { kind: 'audio', id: audioId, file, name: (await getMediaEntry(audioId))?.name || audioId }
  }

  const imageId = mediaIdFromUrl(ref)
  if (imageId) {
    const entry = await getMediaEntry(imageId)
    if (!entry || !fs.existsSync(entry.path)) return null
    return { kind: 'image', id: imageId, file: entry.path, name: entry.name || imageId, ...(entry.credit ? { credit: entry.credit } : {}) }
  }
  return null
}
