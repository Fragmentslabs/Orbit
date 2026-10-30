import path from 'node:path'
import { assetUrl, mediaKind, thumbUrl, type MaterialView, type MediaEntry } from '@shared/media'
import { audioExt, isAudioFile, saveAudio } from './audio-store'
import { isVideoFile, saveVideoAttachment, videoAttachmentExt } from './attachment-ref'
import { deleteMedia, getMediaEntry, listMedia, mediaIdFromUrl, saveMedia, updateMediaEntry } from './media'
import { DRAFT_SCOPE, documentFolderId } from './session-documents'
import { t } from './i18n'
import { addVideoToGallery } from './video/video-gallery'

/**
 * MATERIALS of the conversation: photo, GIF, audio and video in the Sources tab.
 *
 * The tab's documents (PDF, spreadsheet…) have an extraction, page and
 * search pipeline — none of that applies to a video. A material is just a FILE that the
 * conversation has at hand and that the agent reaches by REFERENCE (`img_…`, `aud_…`,
 * `vdo_…`), when it decides to use it. That is why it reuses what already exists: the
 * media item of the gallery, with a scope — the conversation (`sessionId`) or the
 * sidebar folder (`sharedFolderId`) — instead of a second storage.
 *
 * Three consequences desired from this choice:
 *  - the file is ONE: deleting it in the gallery takes it out of the tab, and deleting it in the tab takes
 *    it out of the gallery, freeing the space in both;
 *  - the reference never changes when moving the material between the conversation and the folder
 *    (documents swap `doc1` for `src1`, and need a trace for that);
 *  - what the user attached in a MESSAGE also shows up here, in "this
 *    conversation", since it is the same item.
 */

const MATERIAL_KINDS = new Set(['image', 'audio', 'video'])

/** Ceiling for a photo/audio that arrives as bytes; the video from a file comes by path. */
const MAX_IMAGE_BYTES = 40 * 1024 * 1024
const MAX_AUDIO_BYTES = 100 * 1024 * 1024
/** The largest video still accepted AS BYTES (pasted, with no file on disk). */
const MAX_PASTED_VIDEO_BYTES = 150 * 1024 * 1024

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i
const IMAGE_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export type MaterialKind = 'image' | 'audio' | 'video'

/** What kind of material a file is, or null when it is not one the tab keeps. */
export function materialKindOf(mime: string, filename: string): MaterialKind | null {
  if (isVideoFile(mime, filename)) return 'video'
  if (isAudioFile(mime, filename)) return 'audio'
  if (IMAGE_MIME_EXT[mime.toLowerCase()] || IMAGE_EXT.test(filename)) return 'image'
  return null
}

function imageExtOf(mime: string, filename: string): string {
  const fromMime = IMAGE_MIME_EXT[mime.toLowerCase()]
  if (fromMime) return fromMime
  const match = IMAGE_EXT.exec(filename)
  const ext = match ? match[1].toLowerCase() : 'png'
  return ext === 'jpeg' ? 'jpg' : ext
}

/** A media item → what the tab shows. */
export function toMaterialView(entry: MediaEntry): MaterialView {
  const kind = mediaKind(entry) as MaterialKind
  return {
    id: entry.id,
    kind,
    name: entry.name || entry.id,
    sizeBytes: entry.size,
    createdAt: entry.createdAt,
    durationMs: entry.durationMs,
    width: entry.width,
    height: entry.height,
    thumbUrl: kind === 'audio' ? null : thumbUrl(entry),
    playUrl: kind === 'audio' || kind === 'image' || kind === 'video' ? assetUrl(entry) : null,
    shared: Boolean(entry.sharedFolderId),
    animated: kind === 'image' && /\.gif$/i.test(entry.id),
  }
}

/** Is the material from this conversation (not shared with the folder)? */
function isOwn(entry: MediaEntry, scope: string): boolean {
  if (entry.sharedFolderId) return false
  return entry.sessionId === scope || (entry.linkedSessionIds ?? []).includes(scope)
}

/**
 * The materials the conversation reaches, separated like the documents: the folder's
 * (shared) and its own. Only what the USER brought in enters (`source: 'user'`) —
 * an image the agent generated is output, and stays in the gallery.
 */
export async function listSessionMaterials(
  scope: string,
): Promise<{ shared: MaterialView[]; own: MaterialView[]; bytes: number }> {
  const folderId = await documentFolderId(scope)
  const entries = (await listMedia({ source: 'user' })).filter((e) => MATERIAL_KINDS.has(mediaKind(e)))
  const shared = folderId ? entries.filter((e) => e.sharedFolderId === folderId) : []
  const own = entries.filter((e) => isOwn(e, scope))
  const byAge = (a: MediaEntry, b: MediaEntry) => a.createdAt - b.createdAt
  return {
    shared: shared.sort(byAge).map(toMaterialView),
    own: own.sort(byAge).map(toMaterialView),
    bytes: [...shared, ...own].reduce((sum, e) => sum + e.size, 0),
  }
}

export interface MaterialInput {
  filename: string
  mime?: string
  /** Bytes in base64 (photo, audio, pasted video). */
  data?: string
  /** Path of the file on disk (video chosen or dragged): copied in the main. */
  path?: string
}

export type AddMaterialResult = { ok: true; material: MaterialView } | { ok: false; error: string }

/**
 * Brings a file into the tab. `shared` only counts when the conversation is in a folder;
 * without a folder, there is no larger scope and the material stays in the conversation.
 */
export async function addSessionMaterial(scope: string, input: MaterialInput, shared: boolean): Promise<AddMaterialResult> {
  const mime = input.mime ?? ''
  const kind = materialKindOf(mime, input.filename)
  if (!kind) return { ok: false, error: await t('sources.error.unsupportedKind', { filename: input.filename }) }

  try {
    const bytes = input.data !== undefined ? Buffer.from(input.data, 'base64') : null
    let id: string

    if (kind === 'video') {
      const ext = videoAttachmentExt(mime, input.filename)
      if (!ext) return { ok: false, error: `${input.filename}: unsupported video format` }
      let saved
      if (input.path) {
        // The path comes from the renderer: it only counts for a real video file.
        if (videoAttachmentExt('', path.extname(input.path)) === null) return { ok: false, error: `${input.filename}: the path is not a video file` }
        saved = await saveVideoAttachment({ copyFrom: input.path }, ext, { sessionId: scope, name: input.filename })
      } else if (bytes) {
        if (bytes.length > MAX_PASTED_VIDEO_BYTES) return { ok: false, error: `${input.filename}: too large to attach without a file on disk` }
        saved = await saveVideoAttachment({ bytes }, ext, { sessionId: scope, name: input.filename })
      } else {
        return { ok: false, error: `${input.filename}: no content` }
      }
      const gallery = await addVideoToGallery({ file: saved.file, id: saved.id, name: input.filename, sessionId: scope, source: 'user' })
      if (!gallery.probe || gallery.probe.video.length === 0) {
        await deleteMedia(saved.id)
        return { ok: false, error: `${input.filename}: not a readable video` }
      }
      id = saved.id
    } else if (kind === 'audio') {
      const ext = audioExt(mime, input.filename)
      if (!ext || !bytes) return { ok: false, error: `${input.filename}: unsupported audio format` }
      if (bytes.length > MAX_AUDIO_BYTES) return { ok: false, error: `${input.filename}: too large` }
      id = (await saveAudio(bytes, ext, { sessionId: scope, name: input.filename, source: 'user' })).id
    } else {
      if (!bytes) return { ok: false, error: `${input.filename}: no content` }
      if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, error: `${input.filename}: too large` }
      const url = await saveMedia(bytes, imageExtOf(mime, input.filename), { source: 'user', sessionId: scope, name: input.filename })
      id = mediaIdFromUrl(url) ?? ''
    }

    const folderId = shared ? await documentFolderId(scope) : null
    const entry = folderId ? await updateMediaEntry(id, { sharedFolderId: folderId }) : await getMediaEntry(id)
    if (!entry) return { ok: false, error: `${input.filename}: could not be registered` }
    return { ok: true, material: toMaterialView(entry) }
  } catch (err) {
    return { ok: false, error: `${input.filename}: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/**
 * Moves a material between the conversation and the folder. The reference does NOT change — it is the same
 * file, only the scope swaps — so nothing already said in the conversation stops
 * pointing to it.
 */
export async function setMaterialShared(
  scope: string,
  id: string,
  shared: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const entry = await getMediaEntry(id)
  if (!entry || !MATERIAL_KINDS.has(mediaKind(entry))) return { ok: false, error: `Material not found: ${id}` }
  const folderId = await documentFolderId(scope)
  const reachable = isOwn(entry, scope) || (folderId !== null && entry.sharedFolderId === folderId)
  if (!reachable) return { ok: false, error: `Material not found: ${id}` }
  if (shared) {
    if (!folderId) return { ok: false, error: await t('sources.error.noFolder') }
    await updateMediaEntry(id, { sharedFolderId: folderId })
  } else {
    // Back to THIS conversation: it is the one that asked, and the material does not stay orphaned.
    await updateMediaEntry(id, { sharedFolderId: undefined, sessionId: scope })
  }
  return { ok: true }
}

/** The new chat got a session: what was brought into the draft now belongs to it. */
export async function adoptDraftMaterials(sessionId: string): Promise<number> {
  if (sessionId === DRAFT_SCOPE) return 0
  const draft = (await listMedia({ sessionId: DRAFT_SCOPE })).filter((e) => MATERIAL_KINDS.has(mediaKind(e)))
  for (const entry of draft) await updateMediaEntry(entry.id, { sessionId })
  return draft.length
}

/** One line per material for the agent: reference, type, name and what matters about it. */
export function describeMaterialsForAgent(list: { shared: MaterialView[]; own: MaterialView[] }): string {
  const line = (m: MaterialView, scope: string) => {
    const facts: string[] = []
    if (m.kind === 'video' && m.durationMs) facts.push(`${(m.durationMs / 1000).toFixed(1)} s`)
    if (m.width && m.height) facts.push(`${m.width}x${m.height}`)
    if (m.animated) facts.push('animated GIF')
    facts.push(`${(m.sizeBytes / 1e6).toFixed(1)} MB`)
    return `${m.id}: ${m.kind} "${m.name}" (${facts.join(', ')}, ${scope})`
  }
  return [
    ...list.shared.map((m) => line(m, 'folder material, shared with the other chats of the folder')),
    ...list.own.map((m) => line(m, 'attached in this conversation')),
  ].join('\n')
}
