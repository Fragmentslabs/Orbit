import { randomBytes } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { MediaEntry, MediaSource } from '@shared/media'
import { listMedia, saveVideoMedia } from '../media'
import type { MediaProbe } from './ffmpeg'
import { probeVideoAttachment, videoPosterPng } from './attachment-note'
import { registerVideo } from './store'

/**
 * Puts a video in the media GALLERY: the attachment the user sent and the video the
 * agent produced in chat mode. It is what makes them show up in the Media tab, in the
 * type filter, and be deletable from there — freeing the file.
 *
 * Only what the app KEEPS enters here. A video rendered in a project's folder
 * (code mode) is the project's file, not the app's: the gallery does not list it, because
 * deleting an item from there would erase a user's file.
 */

/** Id of the item in the gallery: the attachment's (`vdo_…`) or a new one, for a produced video. */
function newVideoId(file: string): string {
  const ext = path.extname(file).toLowerCase().replace(/^\./, '') || 'mp4'
  return `vdo_${Date.now().toString(36)}${randomBytes(4).toString('hex')}.${ext}`
}

export interface GalleryVideo {
  entry: MediaEntry
  /** The cover in PNG (for whoever needs it again, like the bubble chip). */
  poster?: Buffer
  probe: MediaProbe | null
}

export async function addVideoToGallery(input: {
  file: string
  /** Keeps the id when the file is ALREADY a kept attachment (`vdo_…`). */
  id?: string
  name?: string
  sessionId?: string
  messageId?: string
  source: MediaSource
  probe?: MediaProbe | null
}): Promise<GalleryVideo> {
  const probe = input.probe === undefined ? await probeVideoAttachment(input.file) : input.probe
  const poster = probe ? await videoPosterPng(input.file, probe.durationMs) : undefined
  // The same file (a render redone over the previous one) is the SAME item: the
  // gallery does not gain a new card at every run.
  const id = input.id ?? (await listMedia({ kind: 'video' })).find((e) => e.path === input.file)?.id ?? newVideoId(input.file)
  const { url } = await registerVideo(input.file, input.sessionId)
  const size = (await fsp.stat(input.file)).size
  const first = probe?.video[0]
  const entry = await saveVideoMedia(poster ?? null, {
    id,
    file: input.file,
    size,
    name: input.name ?? path.basename(input.file),
    sessionId: input.sessionId,
    messageId: input.messageId,
    source: input.source,
    width: probe?.display?.width ?? first?.width,
    height: probe?.display?.height ?? first?.height,
    durationMs: probe?.durationMs,
    videoUrl: url,
  })
  return { entry, poster, probe }
}
