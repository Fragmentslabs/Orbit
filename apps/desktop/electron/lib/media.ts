import { app, BrowserWindow, net, protocol, session } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { StorageKeys, type ChatMessage } from '@shared/chat'
import { FRAGMENT_SCHEME } from '@shared/fragments'
import {
  ARTIFACT_SCHEME,
  MEDIA_SCHEME,
  mediaKind,
  type MediaCredit,
  type MediaEntry,
  type MediaFilter,
  type MediaKind,
  type MediaSource,
  type MediaUsage,
  SAFE_VIDEO_MEDIA_ID,
  type DocumentFormat, AUDIO_SCHEME, VIDEO_SCHEME, MOTION_SCHEME, DESIGN_SCHEME, SLIDES_SCHEME, FONT_SCHEME } from '@shared/media'
import { listKeys, readJson } from './storage'
import { buildDocx } from './docx-package'
import mammoth from 'mammoth'
import { rasterizePdf } from './pdf-raster'
import { normalizeStyle, parseMarkdown, renderHtml, renderThumbHtml, type DocumentStyle } from './document-render'
import { renderDiagrams } from './mermaid-render'
import { withAssetLock, writeFileAtomic } from './asset-lock'
import { fontFacesForFamily, handleFontRequest } from './fonts/store'
import { journalMediaIndex, journalPath, mediaJournalActive } from './session/media-journal'
import { tNow } from './i18n'
import { existsSync } from 'node:fs'
import { fetchRemoteAsset, fetchRemoteText, isRemoteAsset } from './peers/remote-assets'

export type { MediaEntry, MediaFilter, MediaSource, MediaUsage }

/**
 * Registry of the assets the agent produces.
 *
 * Images (show_image tool, screenshots, browser scripts) are PNGs/JPGs/
 * WebPs in orbit-data/media, served by the orbit-media:// protocol.
 * Artifacts (create_artifact tool) are HTML pages in orbit-data/artifacts,
 * served by the orbit-artifact:// protocol. In both cases the messages
 * persist only the URL, never the content.
 *
 * The INDEX is a single one (media/index.json) and the file is never duplicated: the
 * record is a pointer — absolute `path` + `kind` — and that is what makes the
 * gallery, the disk usage and "open in chat" work for the two types without
 * two implementations. That is why every read/delete resolves through the
 * ENTRY's `path`, never by rebuilding `mediaDir() + id`.
 *
 * The directory remains the source of truth for the images: if the index
 * disappears or gets corrupted, `backfillMedia` rebuilds it from the disk.
 */

const SCHEME = MEDIA_SCHEME
/**
 * The `svg` comes along with the rasters because it is delivered as an IMAGE: served
 * with `image/svg+xml` and drawn in `<img>`, where embedded script does not run.
 * It just cannot be treated like the others when copying to the clipboard —
 * nativeImage does not read SVG, and there it goes rasterized.
 */
const SAFE_ID = /^[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp|gif|svg)$/
/**
 * Files served by orbit-artifact://: the artifact page (.html), the
 * captured thumbnail (.png) and, for documents, the source (.md) and the
 * renderings (.pdf/.docx).
 */
const SAFE_ARTIFACT_ID = /^[a-zA-Z0-9_-]+\.(html|png|md|pdf|docx)$/
const INDEX_FILE = 'index.json'

/**
 * Directory of a file served by the scheme, decided by the id PREFIX
 * (`art_` / `doc_`) — the ids are generated here, so the prefix is reliable and
 * avoids having to query the index on every protocol request.
 */
function assetFileDir(id: string): string {
  return id.startsWith('doc_') ? documentsDir() : artifactsDir()
}

export interface SaveMediaMeta {
  source: MediaSource
  sessionId?: string
  messageId?: string
  taskId?: string
  name?: string
  /** Id of the source image, when this one was born from an edit of another. */
  parentId?: string
  /** Author and license, when the image came from a web search. */
  credit?: MediaCredit
}

function mediaDir(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'media')
}

/** Artifacts live outside media/ so they do not collide with the backfill, which scans
 *  the images directory and would register any new file as an image. */
function artifactsDir(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'artifacts')
}

/** Documents: .md source, .html preview, .pdf/.docx renderings and the
 *  .png thumbnail, all with the same base id. */
function documentsDir(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'documents')
}

function indexFile(): string {
  return path.join(mediaDir(), INDEX_FILE)
}

/**
 * Index write mutex: every mutation enters a serial queue. Without it,
 * two simultaneous captures (batch + show_image) would read the same version of
 * index.json and one would overwrite the other.
 */
let indexQueue: Promise<unknown> = Promise.resolve()

function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = indexQueue.then(fn, fn)
  indexQueue = next.catch(() => {})
  return next
}

async function readIndex(): Promise<MediaEntry[]> {
  try {
    const raw = await fsp.readFile(indexFile(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((e): e is MediaEntry => !!e && typeof (e as MediaEntry).id === 'string')
  } catch {
    // Missing or corrupted: the disk is the source of truth
    return []
  }
}

async function writeIndex(entries: MediaEntry[]): Promise<void> {
  // Inside an agent turn, every entry created, changed or removed
  // keeps the previous state in the journal — it is what lets the message revert
  // undo what it put into (or removed from) the gallery. Always under the withIndexLock
  // of the caller, so the index read here is the one from immediately before.
  if (mediaJournalActive()) await journalMediaIndex(await readIndex(), entries)
  await fsp.mkdir(mediaDir(), { recursive: true })
  const tmp = `${indexFile()}.${Date.now()}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(entries, null, 2), 'utf8')
  await fsp.rename(tmp, indexFile())
}

/** Image dimensions — silent failure (the record counts even without them). */
async function dimensions(buffer: Buffer): Promise<{ width?: number; height?: number }> {
  try {
    const meta = await sharp(buffer).metadata()
    return { width: meta.width, height: meta.height }
  } catch {
    return {}
  }
}

/**
 * Saves the buffer and returns the orbit-media:// URL to use in the ImagePart.
 * `meta` records the origin in the index — without it the image enters as 'chat'
 * (compatibility with old callers).
 */
export async function saveMedia(buffer: Buffer, ext: string, meta?: SaveMediaMeta): Promise<string> {
  const id = `img_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.${ext}`
  if (!SAFE_ID.test(id)) throw new Error(`invalid image extension: ${ext}`)
  await fsp.mkdir(mediaDir(), { recursive: true })
  const file = path.join(mediaDir(), id)
  await fsp.writeFile(file, buffer)

  const size = buffer.length
  const { width, height } = await dimensions(buffer)
  const entry: MediaEntry = {
    id,
    path: file,
    size,
    createdAt: Date.now(),
    source: meta?.source ?? 'chat',
    kind: 'image',
    sessionId: meta?.sessionId,
    messageId: meta?.messageId,
    taskId: meta?.taskId,
    name: meta?.name,
    parentId: meta?.parentId,
    ...(meta?.credit ? { credit: meta.credit } : {}),
    width,
    height,
  }
  await withIndexLock(async () => {
    const entries = await readIndex()
    entries.push(entry)
    await writeIndex(entries)
  })
  notifyMediaChanged()
  return `${SCHEME}://${id}`
}

/**
 * Warns the windows that the collection changed.
 *
 * The gallery read the index only when opening: with the panel open, an image generated
 * in the middle of the conversation did not appear, and a deleted one stayed there —
 * you had to close and open to see the truth. It is emitted from here for the same
 * reason as artifact:updated: going through broadcast.ts would create the cycle
 * media → broadcast → companion-server → companion-http → media.
 */
function notifyMediaChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('media:changed')
  }
}

/** Ids of the audio files (see audio-store.ts): tiny, `aud_` prefix. */
export const SAFE_AUDIO_ID = /^aud_[a-z0-9]+\.(wav|mp3|m4a|aac|ogg|oga|opus|webm|flac)$/

/** Id of an audio file from the orbit-audio:// URL or from the raw id. */
export function audioMediaId(url: string): string | null {
  const id = url.trim().replace(`${AUDIO_SCHEME}://`, '').replace(/\/+$/, '')
  return SAFE_AUDIO_ID.test(id) ? id : null
}

/**
 * Registers an audio file already written to disk in the collection (attachment or
 * generated). The file lives in the audio folder, not in media/ — the backfill there
 * would register everything as an image —, and the record points to it through `path`.
 */
export async function registerAudioMedia(entry: {
  id: string
  path: string
  size: number
  source: MediaSource
  sessionId?: string
  messageId?: string
  name?: string
}): Promise<void> {
  if (!SAFE_AUDIO_ID.test(entry.id)) throw new Error(`invalid audio id: ${entry.id}`)
  await withIndexLock(async () => {
    const entries = await readIndex()
    entries.push({ ...entry, createdAt: Date.now(), kind: 'audio' })
    await writeIndex(entries)
  })
  notifyMediaChanged()
}

/** What a video needs to enter the gallery. */
export interface SaveVideoMeta {
  /** File id (`vdo_….mp4`) — the same as the reference the agent receives. */
  id: string
  /** Video file, in the app. */
  file: string
  size: number
  name?: string
  sessionId?: string
  messageId?: string
  source: MediaSource
  width?: number
  height?: number
  durationMs?: number
  /** Player URL (orbit-video://) that the gallery viewer plays. */
  videoUrl?: string
}

/**
 * Registers a video in the gallery. Like audio, the file lives outside media/ (the
 * backfill there would register it as an image) and the record points to it through
 * `path`; the COVER is a frame, written in the artifacts folder like that of a motion
 * piece. Registering the same id again updates the item.
 */
export async function saveVideoMedia(poster: Buffer | null, meta: SaveVideoMeta): Promise<MediaEntry> {
  if (!SAFE_VIDEO_MEDIA_ID.test(meta.id)) throw new Error(`invalid video id: ${meta.id}`)
  let thumb: string | undefined
  if (poster) {
    thumb = `vdp_${meta.id.replace(/^vdo_/, '').replace(/\.[a-z0-9]+$/, '')}.png`
    await fsp.mkdir(artifactsDir(), { recursive: true })
    await fsp.writeFile(path.join(artifactsDir(), thumb), poster)
  }
  const entry = await withIndexLock(async () => {
    const entries = await readIndex()
    const existing = entries.find((e) => e.id === meta.id)
    const next: MediaEntry = {
      ...existing,
      id: meta.id,
      path: meta.file,
      size: meta.size,
      createdAt: existing?.createdAt ?? Date.now(),
      source: meta.source,
      kind: 'video',
      name: meta.name ?? existing?.name,
      sessionId: meta.sessionId ?? existing?.sessionId,
      messageId: meta.messageId ?? existing?.messageId,
      width: meta.width ?? existing?.width,
      height: meta.height ?? existing?.height,
      durationMs: meta.durationMs ?? existing?.durationMs,
      videoUrl: meta.videoUrl ?? existing?.videoUrl,
      thumb: thumb ?? existing?.thumb,
    }
    if (existing) entries[entries.indexOf(existing)] = next
    else entries.push(next)
    await writeIndex(entries)
    return next
  })
  notifyMediaChanged()
  return entry
}

/** Extracts the id from an orbit-media:// URL (or returns the entry if it is already an id). */
export function mediaIdFromUrl(url: string): string | null {
  const id = url.startsWith(`${SCHEME}://`) ? url.slice(`${SCHEME}://`.length).replace(/\/+$/, '') : url
  return SAFE_ID.test(id) ? id : null
}

/**
 * Links assets (image, artifact or document) to an ADDITIONAL session —
 * today, only the fork: `forkSession` clones the messages with the SAME
 * documentId/artifactId/mediaUrl (nothing is duplicated), so without this the card
 * stays visible in the fork conversation but disappears from the gallery's
 * "In this chat" filter, because the record's `sessionId` is fixed to the original session.
 *
 * Invalid ids are ignored silently — the caller passes everything it found
 * in the cloned parts, and not every part becomes a recognizable media id.
 */
export async function linkMediaSessions(ids: string[], sessionId: string): Promise<void> {
  if (ids.length === 0) return
  const wanted = new Set(ids)
  await withIndexLock(async () => {
    const entries = await readIndex()
    let changed = false
    for (const entry of entries) {
      if (!wanted.has(entry.id)) continue
      if (entry.sessionId === sessionId) continue
      if (entry.linkedSessionIds?.includes(sessionId)) continue
      entry.linkedSessionIds = [...(entry.linkedSessionIds ?? []), sessionId]
      changed = true
    }
    if (changed) await writeIndex(entries)
  })
  notifyMediaChanged()
}

/**
 * Links an image already saved to the message where it appeared. show_image does not
 * know the message id (the tool runs in the middle of the turn) — the chat-engine
 * completes the record when it materializes the ImagePart.
 */
export async function attachMediaMessage(url: string, messageId: string, sessionId?: string): Promise<void> {
  const id = mediaIdFromUrl(url) ?? audioMediaId(url)
  if (!id) return
  await withIndexLock(async () => {
    const entries = await readIndex()
    const entry = entries.find((e) => e.id === id)
    if (!entry) return
    entry.messageId = messageId
    if (sessionId) entry.sessionId = sessionId
    await writeIndex(entries)
  })
}

function matches(entry: MediaEntry, filter: MediaFilter): boolean {
  if (filter.source) {
    const sources = Array.isArray(filter.source) ? filter.source : [filter.source]
    if (!sources.includes(entry.source)) return false
  }
  if (filter.kind) {
    const kinds = Array.isArray(filter.kind) ? filter.kind : [filter.kind]
    if (!kinds.includes(mediaKind(entry))) return false
  }
  // Source session OR a linked session (fork) — see linkMediaSessions.
  if (
    filter.sessionId &&
    entry.sessionId !== filter.sessionId &&
    !entry.linkedSessionIds?.includes(filter.sessionId)
  ) {
    return false
  }
  // Project scope: it is what makes the agent find again, in code mode,
  // what it produced before in the SAME repository — in any session.
  if (filter.directory && entry.directory !== filter.directory) return false
  if (filter.folderId && entry.folderId !== filter.folderId) return false
  if (filter.since != null && entry.createdAt < filter.since) return false
  if (filter.query) {
    const needle = filter.query.toLowerCase()
    const haystack = `${entry.name ?? ''} ${entry.taskId ?? ''} ${entry.id}`.toLowerCase()
    if (!haystack.includes(needle)) return false
  }
  return true
}

/** Lists the registry (most recent first), optionally filtered. */
export async function listMedia(filter?: MediaFilter): Promise<MediaEntry[]> {
  const entries = await readIndex()
  const filtered = filter ? entries.filter((e) => matches(e, filter)) : entries
  return filtered.sort((a, b) => b.createdAt - a.createdAt)
}

/** Updates fields of a collection item (the scope of a material, for example). */
export async function updateMediaEntry(id: string, patch: Partial<MediaEntry>): Promise<MediaEntry | null> {
  const updated = await withIndexLock(async () => {
    const entries = await readIndex()
    const at = entries.findIndex((e) => e.id === id)
    if (at < 0) return null
    // Keys with `undefined` DELETE the field (that is how the folder scope is removed).
    const next = { ...entries[at], ...patch } as MediaEntry
    for (const key of Object.keys(patch) as Array<keyof MediaEntry>) {
      if (patch[key] === undefined) delete next[key]
    }
    entries[at] = next
    await writeIndex(entries)
    return next
  })
  if (updated) notifyMediaChanged()
  return updated
}

export async function getMediaEntry(id: string): Promise<MediaEntry | null> {
  const entries = await readIndex()
  return entries.find((e) => e.id === id) ?? null
}

/**
 * Removes file + record. Returns false when the id is invalid.
 *
 * The path comes from the ENTRY (images and artifacts live in different folders);
 * `mediaDir() + id` only enters as a fallback for orphan records — media on
 * disk that the index lost. For an artifact, the thumbnail goes along.
 */
export async function deleteMedia(id: string): Promise<boolean> {
  const isImage = SAFE_ID.test(id)
  if (!isImage && !SAFE_ARTIFACT_ID.test(id) && !SAFE_AUDIO_ID.test(id) && !SAFE_VIDEO_MEDIA_ID.test(id)) return false

  const entry = await getMediaEntry(id)
  const file = entry?.path ?? (isImage ? path.join(mediaDir(), id) : null)
  if (!file) return false
  // Whoever keeps MORE than the record's file (the folder of a motion piece, the
  // video index) cleans the rest BEFORE the record disappears: if cleaning fails,
  // the item stays in the gallery and the person can try again, instead of leaving
  // occupied space that nothing points to anymore.
  const hook = entry ? deleteHooks.get(mediaKind(entry)) : undefined
  if (entry) await journalEntryFiles(entry)
  if (entry && hook) await hook(entry)
  await fsp.rm(file, { force: true })
  for (const thumb of [entry?.thumb, entry?.thumbDark]) {
    if (thumb && SAFE_ARTIFACT_ID.test(thumb)) {
      await fsp.rm(path.join(assetFileDir(thumb), thumb), { force: true })
    }
  }

  await withIndexLock(async () => {
    const entries = await readIndex()
    const next = entries.filter((e) => e.id !== id)
    if (next.length !== entries.length) await writeIndex(next)
  })
  notifyMediaChanged()
  return true
}

/**
 * The files that a gallery entry OWNS: the record's, the covers and, for a
 * document, each rendering with the same base id (.md, .html, .pdf, .docx).
 * It is the unit of the revert: what enters the journal before being rewritten, and what
 * leaves the disk when the entry created in the turn is undone.
 */
export async function entryOwnedFiles(entry: MediaEntry): Promise<string[]> {
  const files = new Set<string>()
  if (entry.path) files.add(path.resolve(entry.path))
  for (const thumb of [entry.thumb, entry.thumbDark]) {
    if (thumb && SAFE_ARTIFACT_ID.test(thumb)) files.add(path.join(assetFileDir(thumb), thumb))
  }
  if (mediaKind(entry) === 'document') {
    const base = documentBase(entry.id)
    const names = await fsp.readdir(documentsDir()).catch(() => [] as string[])
    for (const name of names) {
      if (name.startsWith(`${base}.`)) files.add(path.join(documentsDir(), name))
    }
  }
  return [...files]
}

/** Before rewriting or deleting the files of an entry (in the agent turn). */
async function journalEntryFiles(entry: MediaEntry): Promise<void> {
  if (!mediaJournalActive()) return
  // The `owner` links each file to the entry: in the revert, what decides whether it can
  // come back is the comparison of the ENTRY (revision/state), not the loose hash of the
  // file — the cover may be regenerated in the background without being an edit.
  for (const file of await entryOwnedFiles(entry)) await journalPath(file, undefined, entry.id)
}

/**
 * Puts gallery entries back in the state saved by the journal — one by
 * one, under the index lock, without touching the ones that are not in the list (another chat
 * may have written its own in the middle). `before: null` removes the entry. The
 * FILES belong to the caller (the journal restores them before); here it is only the index and the
 * notice to the windows, including the artifact/document cards already on screen.
 */
export async function restoreMediaEntries(
  records: Array<{ id: string; before: MediaEntry | null }>,
  /** Revalidates each entry INSIDE the index lock, right before swapping:
   *  whoever decided it was safe read the index before, and another conversation may have
   *  written in the middle. The refused entry stays as it is. */
  stillSafe?: (id: string, current: MediaEntry | null) => boolean,
): Promise<Set<string>> {
  const skipped = new Set<string>()
  if (records.length === 0) return skipped
  const wanted = new Map(records.map((r) => [r.id, r.before]))
  await withIndexLock(async () => {
    const entries = await readIndex()
    if (stillSafe) {
      const byId = new Map(entries.map((e) => [e.id, e]))
      for (const id of [...wanted.keys()]) {
        if (!stillSafe(id, byId.get(id) ?? null)) {
          wanted.delete(id)
          skipped.add(id)
        }
      }
    }
    const next: MediaEntry[] = []
    for (const entry of entries) {
      if (!wanted.has(entry.id)) {
        next.push(entry)
        continue
      }
      const before = wanted.get(entry.id)
      if (before) next.push(before)
      wanted.delete(entry.id)
    }
    // What is no longer in the index and existed before goes back to the end of it.
    for (const before of wanted.values()) if (before) next.push(before)
    await writeIndex(next)
  })
  notifyMediaChanged()
  for (const { id, before } of records) {
    if (!before || skipped.has(id)) continue
    const kind = mediaKind(before)
    if (kind !== 'artifact' && kind !== 'document') continue
    const artifactId = kind === 'document' ? `${documentBase(before.id)}.html` : before.id
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('artifact:updated', { artifactId, revision: before.revision ?? 1 })
    }
  }
  return skipped
}

/**
 * Deletion hooks per TYPE. Some assets have more to delete than the record's
 * file: the motion piece is a whole folder, the video is in the player's
 * index. Whoever knows how to do that (and imports media.ts) registers here, instead of
 * media.ts importing all of them and closing a cycle.
 */
const deleteHooks = new Map<MediaKind, (entry: MediaEntry) => Promise<void>>()

export function setMediaDeleteHook(kind: MediaKind, hook: (entry: MediaEntry) => Promise<void>): void {
  deleteHooks.set(kind, hook)
}

/** Removes several assets at once (batch selection in the gallery). */
export async function deleteManyMedia(ids: string[]): Promise<number> {
  let removed = 0
  for (const id of ids) {
    if (await deleteMedia(id)) removed += 1
  }
  return removed
}

/**
 * Quick cleanup: deletes the images generated by scripts/batches (source
 * 'script'/'batch') that were NOT shown in any message — the intermediate
 * material of the automations, which tends to dominate the disk.
 */
export async function cleanupScriptMedia(): Promise<number> {
  const entries = await readIndex()
  const disposable = entries.filter(
    (e) => (e.source === 'script' || e.source === 'batch') && !e.messageId,
  )
  return deleteManyMedia(disposable.map((e) => e.id))
}

/**
 * Disk usage of the assets (real files, not the index): images in media/ and
 * artifacts in artifacts/.
 *
 * `count` counts ASSETS — the artifact thumbnails add bytes but do not
 * count as items, otherwise each artifact would show up twice in the number that the
 * user reads in the gallery.
 */
export async function mediaDiskUsage(): Promise<MediaUsage> {
  let count = 0
  let bytes = 0

  async function scan(dir: string, valid: RegExp, countable: (name: string) => boolean) {
    try {
      for (const name of await fsp.readdir(dir)) {
        if (!valid.test(name)) continue
        try {
          const stat = await fsp.stat(path.join(dir, name))
          if (countable(name)) count += 1
          bytes += stat.size
        } catch {
          // file removed in the middle of the scan
        }
      }
    } catch {
      // folder does not exist yet
    }
  }

  await scan(mediaDir(), SAFE_ID, () => true)
  await scan(artifactsDir(), SAFE_ARTIFACT_ID, (name) => name.endsWith('.html'))
  // Videos and audio live in their own folders (outside what the scan above covers) and
  // are, by far, what takes the most disk: they count through the record, which points to the
  // file. Without this, "deleting frees space" would not show up in the number.
  for (const entry of await readIndex()) {
    const kind = mediaKind(entry)
    if (kind !== 'video' && kind !== 'audio') continue
    try {
      bytes += (await fsp.stat(entry.path)).size
      count += 1
    } catch {
      // file already removed: the orphan record does not count
    }
  }
  return { count, bytes }
}

/**
 * Index of the images present on disk but absent from the registry (media
 * from before the registry, or saved while the index was corrupted). It scans
 * the session messages to find out which chat/message each file
 * came from; what does not show up in any message enters as an orphan 'chat'.
 *
 * It runs once, on the first opening of the gallery — cheap and idempotent.
 */
export async function backfillMedia(): Promise<number> {
  return withIndexLock(async () => {
    const entries = await readIndex()
    const known = new Set(entries.map((e) => e.id))

    let files: string[] = []
    try {
      files = (await fsp.readdir(mediaDir())).filter((name) => SAFE_ID.test(name) && !known.has(name))
    } catch {
      return 0
    }
    if (files.length === 0) return 0

    // image id → { sessionId, messageId } from the persisted ImageParts
    const origins = new Map<string, { sessionId: string; messageId: string }>()
    for (const key of await listKeys(StorageKeys.sessionPrefix)) {
      const sessionId = key.slice(StorageKeys.sessionPrefix.length)
      const messages = await readJson<ChatMessage[]>(StorageKeys.messages(sessionId))
      if (!messages) continue
      for (const message of messages) {
        for (const part of message.parts) {
          if (part.type !== 'image') continue
          const id = mediaIdFromUrl(part.src)
          if (id) origins.set(id, { sessionId, messageId: message.id })
        }
      }
    }

    for (const id of files) {
      const file = path.join(mediaDir(), id)
      let size = 0
      let createdAt = Date.now()
      try {
        const stat = await fsp.stat(file)
        size = stat.size
        createdAt = stat.mtimeMs
      } catch {
        continue
      }
      const origin = origins.get(id)
      let dims: { width?: number; height?: number } = {}
      try {
        dims = await dimensions(await fsp.readFile(file))
      } catch {
        // unreadable file — registers it without dimensions
      }
      entries.push({
        id,
        path: file,
        size,
        createdAt,
        source: 'chat',
        sessionId: origin?.sessionId,
        messageId: origin?.messageId,
        ...dims,
      })
    }
    await writeIndex(entries)
    return files.length
  })
}

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
}

/** Reads a persisted media file — used by the companion HTTP server
 *  (which has no access to Electron's orbit-media:// protocol). It validates the id
 *  with SAFE_ID (no path traversal). */
export async function readMedia(
  id: string,
): Promise<{ buffer: Buffer; contentType: string; ext: string } | null> {
  if (!SAFE_ID.test(id)) return null
  try {
    const buffer = await fsp.readFile(path.join(mediaDir(), id))
    // The extension comes from the ID, which is the source of truth: we choose it when
    // writing. Deducing it from the content type depends on a map that someone
    // has to remember to extend on every new format — and that is how the SVG
    // ended up saved with the wrong extension.
    const ext = id.split('.').pop() ?? ''
    return { buffer, contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream', ext }
  } catch {
    return null
  }
}

/** Registers the protocol (call after app.whenReady). */
export function registerMediaProtocol(): void {
  protocol.handle(SCHEME, (request) => {
    // request.url = orbit-media://img_x.png (the host carries the id on non-standard schemes)
    const id = request.url.slice(`${SCHEME}://`.length).replace(/\/+$/, '')
    if (!SAFE_ID.test(id)) return new Response('not found', { status: 404 })
    const file = path.join(mediaDir(), id)
    // Not on this disk and seen in a paired desktop's chat: it comes from there.
    if (isRemoteAsset(id) && !existsSync(file)) {
      return fetchRemoteAsset('media', id, '', request).then((res) => res ?? new Response('not found', { status: 404 }))
    }
    return net.fetch(pathToFileURL(file).toString())
  })
}

// ─── HTML artifacts ──────────────────────────────────────────────────────────

/**
 * Renderable page produced by the agent (create_artifact): dashboard,
 * prototype, diagram, report. Same mechanics as the images — file on
 * disk, record in the index, URL in the message — with two differences:
 *
 * 1. Its own scheme. `orbit-media://` is not privileged, and HTML without an origin
 *    runs no script and loads no module. `orbit-artifact://` is registered as
 *    standard+secure (see registerSchemePrivileges, which HAS to run
 *    before the app is ready).
 * 2. Thumbnail. The gallery is a grid of <img>; the artifact gets a PNG
 *    captured in a hidden window to fit that grid.
 *
 * The content is written by the model, which may have read the web in the same turn:
 * whoever renders it treats it as untrusted (sandboxed iframe without
 * allow-same-origin, isolated partition).
 */

/** Maximum height captured in the thumbnail — long pages become a useless strip. */
const THUMB_VIEWPORT = { width: 1024, height: 768 }
const THUMB_WIDTH = 640
const THUMB_LOAD_TIMEOUT_MS = 8_000

export interface SaveArtifactMeta {
  title: string
  sessionId?: string
  messageId?: string
}

export interface ArtifactRef {
  /** File name: art_xxx.html — also the record id in the gallery */
  id: string
  url: string
  title: string
  thumb?: string
  revision: number
}

/**
 * Privileges of the artifact scheme. It HAS to be called at the top of main,
 * before `app.whenReady()` — after that Chromium has already fixed the scheme
 * table and the call has no effect (the page would load as an opaque origin,
 * without script).
 *
 * ATTENTION: Chromium keeps only the LAST call — registering a second
 * list makes the first one stop counting. EVERY privileged scheme of the app goes
 * in THIS list, never in a separate call.
 */
export function registerSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ARTIFACT_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        // Without CORS the artifact cannot even fetch data from a public API
        // that the model itself put in the script.
        corsEnabled: true,
        stream: true,
      },
    },
    // Conversation audio (see audio-store.ts). Chromium accepts ONE registration
    // call, before the app is ready — that is why the scheme lives here.
    // `stream` is what lets the <audio> play and seek.
    {
      scheme: AUDIO_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
    // Videos rendered by the agent (see video/store.ts) — same reason:
    // without `stream` the <video> neither plays nor seeks.
    {
      scheme: VIDEO_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
    // Motion compositions (see video/motion-store.ts). Same flags as the
    // artifact, and for one more reason: the preview runs in an opaque-origin
    // iframe, where the gsap module and the fonts only load with CORS.
    {
      scheme: MOTION_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
    // Design canvas (see design/design-store.ts): same flags as motion,
    // without `stream` — the artboard is static HTML, with no media track.
    {
      scheme: DESIGN_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
    // Slide decks (see slides/slides-store.ts): the stage is served from the
    // registered folder, with the navigation runtime injected into the <head>. The flags are those
    // of design — no `stream`, because a slide has no media track.
    {
      scheme: SLIDES_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
    // Fragments (see fragments/fragment-protocol.ts): the page's own files, served
    // to an opaque-origin iframe — module scripts and fetch of its own files need CORS.
    {
      scheme: FRAGMENT_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
    // Orbit's font library (see fonts/store.ts): a scheme of its own because
    // the artboard, the motion composition and the app window declare the SAME
    // @font-face, each one in a different origin.
    {
      scheme: FONT_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        // A font is a CORS-mandatory resource: without this the artboard (opaque origin)
        // and the app window would download the file and discard it.
        corsEnabled: true,
      },
    },
  ])
}

const ARTIFACT_CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  png: 'image/png',
  md: 'text/plain; charset=utf-8',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

/**
 * Scrollbar in the Orbit look, injected into the served HTML.
 *
 * The artifact runs in an opaque-origin iframe (see artifact-part.tsx), so
 * it does NOT load the app's stylesheet: the ::-webkit-scrollbar / scrollbar-color from
 * src/index.css does not reach there and the page shows Chromium's native scrollbar,
 * thick and out of place with the rest of the interface. Since this handler serves it, the
 * style travels with the document — and it counts for a fragment AND for a complete
 * document, which is exactly where the `ensureDocument` wrapper
 * (lib/tools/artifact.ts) gives up, because it already recognizes a whole HTML.
 *
 * They are the same two declarations from index.css: the ::-webkit-scrollbar
 * rules apply where `scrollbar-color` does not exist, and where it does, it wins — as in
 * the app. The color comes resolved in a local variable because the document does not have
 * Orbit's tokens.
 */
/**
 * Orbit's design system tokens, for the artifact to use by default.
 *
 * The iframe has an opaque origin and does not inherit the app stylesheet, so the variables
 * (the same as in src/index.css, light and dark) travel in the HTML. Everything goes inside
 * `@layer`: a declaration in a layer LOSES to any declaration without a layer,
 * so if the artifact defines its own `--background`, `body { ... }` or its
 * own font — because the user asked for another look —, theirs wins and ours
 * only fills in what was left blank.
 *
 * The theme follows the same path as the scrollbar: `prefers-color-scheme` until
 * the parent says otherwise (`orbit-dark` / `orbit-light` on the root).
 */
const ORBIT_LIGHT_TOKENS = `--background: oklch(1 0 0); --foreground: oklch(0.141 0.005 285.823);
  --card: oklch(1 0 0); --card-foreground: oklch(0.141 0.005 285.823);
  --popover: oklch(1 0 0); --popover-foreground: oklch(0.141 0.005 285.823);
  --primary: oklch(0.852 0.199 91.936); --primary-foreground: oklch(0.421 0.095 57.708);
  --secondary: oklch(0.967 0.001 286.375); --secondary-foreground: oklch(0.21 0.006 285.885);
  --muted: oklch(0.967 0.001 286.375); --muted-foreground: oklch(0.552 0.016 285.938);
  --accent: oklch(0.967 0.001 286.375); --accent-foreground: oklch(0.21 0.006 285.885);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.92 0.004 286.32); --input: oklch(0.92 0.004 286.32); --ring: oklch(0.705 0.015 286.067);
  --chart-1: oklch(0.837 0.128 66.29); --chart-2: oklch(0.705 0.213 47.604); --chart-3: oklch(0.646 0.222 41.116);
  --chart-4: oklch(0.553 0.195 38.402); --chart-5: oklch(0.47 0.157 37.304);
  color-scheme: light;`
const ORBIT_DARK_TOKENS = `--background: oklch(0.141 0.005 285.823); --foreground: oklch(0.985 0 0);
  --card: oklch(0.21 0.006 285.885); --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.21 0.006 285.885); --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.795 0.184 86.047); --primary-foreground: oklch(0.421 0.095 57.708);
  --secondary: oklch(0.274 0.006 286.033); --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.274 0.006 286.033); --muted-foreground: oklch(0.705 0.015 286.067);
  --accent: oklch(0.274 0.006 286.033); --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --border: oklch(1 0 0 / 10%); --input: oklch(1 0 0 / 15%); --ring: oklch(0.552 0.016 285.938);
  --chart-1: oklch(0.837 0.128 66.29); --chart-2: oklch(0.705 0.213 47.604); --chart-3: oklch(0.646 0.222 41.116);
  --chart-4: oklch(0.553 0.195 38.402); --chart-5: oklch(0.47 0.157 37.304);
  color-scheme: dark;`
const ARTIFACT_TOKENS_CSS = `@layer orbit-tokens {
  :root { ${ORBIT_LIGHT_TOKENS} --radius: 0.875rem;
    --font-sans: 'Geist Variable', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; }
  @media (prefers-color-scheme: dark) { :root:not(.orbit-light) { ${ORBIT_DARK_TOKENS} } }
  :root.orbit-dark { ${ORBIT_DARK_TOKENS} }
  :root.orbit-light { ${ORBIT_LIGHT_TOKENS} }
  body { background: var(--background); color: var(--foreground); font-family: var(--font-sans); }
}`

const ARTIFACT_CHROME_MARK = '<!-- orbit-artifact-chrome -->'
const ARTIFACT_CHROME = `${ARTIFACT_CHROME_MARK}
<style>
  ${ARTIFACT_TOKENS_CSS}
  :root { --orbit-scroll-thumb: oklch(0.92 0.004 286.32); --orbit-scroll-track: oklch(1 0 0); }
  @media (prefers-color-scheme: dark) { :root { --orbit-scroll-thumb: oklch(1 0 0 / 10%); --orbit-scroll-track: oklch(0.21 0.006 285.885); } }
  :root.orbit-dark { --orbit-scroll-thumb: oklch(1 0 0 / 10%); --orbit-scroll-track: oklch(0.21 0.006 285.885); }
  :root.orbit-light { --orbit-scroll-thumb: oklch(0.92 0.004 286.32); --orbit-scroll-track: oklch(1 0 0); }
  *::-webkit-scrollbar, html::-webkit-scrollbar, :root::-webkit-scrollbar { width: 6px; height: 6px; }
  *::-webkit-scrollbar-button, html::-webkit-scrollbar-button { display: none; }
  *::-webkit-scrollbar-track, html::-webkit-scrollbar-track { background: transparent; }
  *::-webkit-scrollbar-thumb, html::-webkit-scrollbar-thumb { background: var(--orbit-scroll-thumb); border-radius: 9999px; min-height: 20px; }
  *::-webkit-scrollbar-corner, html::-webkit-scrollbar-corner { background: transparent; }
  * { scrollbar-width: thin; scrollbar-color: var(--orbit-scroll-thumb) transparent; }
  /* Root bar: the transparent track let the white background of the iframe show through
     (the white band in the dark theme). Here it takes the app card color. */
  html { scrollbar-width: thin; scrollbar-color: var(--orbit-scroll-thumb) var(--orbit-scroll-track); }
</style>
<script>
  // The Orbit theme (light/dark/system) comes from the parent; without that the artifact
  // would follow only the operating system and clash with the chat bar.
  window.addEventListener('message', function (e) {
    var d = e.data
    if (!d || d.type !== 'orbit:theme') return
    document.documentElement.classList.toggle('orbit-dark', d.theme === 'dark')
    document.documentElement.classList.toggle('orbit-light', d.theme !== 'dark')
  })
</script>`

/**
 * Injects the scrollbar a single time, right before the body closing tag (the
 * marker avoids duplicating it in case the artifact already brings the block).
 */
export function injectArtifactChrome(html: string): string {
  if (html.includes(ARTIFACT_CHROME_MARK)) return html
  const closes = [...html.matchAll(/<\/body\s*>/gi)]
  const at = closes.length > 0 ? closes[closes.length - 1].index : undefined
  if (at === undefined) return html + ARTIFACT_CHROME
  return html.slice(0, at) + ARTIFACT_CHROME + html.slice(at)
}

const ARTIFACT_TOKENS_MARK = '<!-- orbit-tokens -->'

/**
 * The token layer alone, for the page that is NOT going into the desktop iframe — the
 * phone's WebView.
 *
 * The artifact is written counting on the `--background`, `--foreground`, `--card` and
 * the rest that the iframe receives from outside. An undefined variable invalidates the
 * whole declaration: the page stayed with a transparent background and inherited black
 * text, which over the dark app in the WebView is a completely black screen.
 *
 * It goes inside the `head`, before the artifact's own styles. Everything is inside
 * `@layer orbit-tokens`, and a layered declaration loses to an unlayered one — the page
 * that defines its own palette keeps winning, as on the desktop.
 */
function injectArtifactTokens(html: string): string {
  if (html.includes(ARTIFACT_TOKENS_MARK)) return html
  const block = `${ARTIFACT_TOKENS_MARK}\n<style>\n${ARTIFACT_TOKENS_CSS}\n</style>\n`
  const at = [...html.matchAll(/<\/head\s*>/gi)][0]?.index
  return at === undefined ? block + html : html.slice(0, at) + block + html.slice(at)
}

async function handleArtifactRequest(request: Request): Promise<Response> {
  // Standard scheme: the URL has host + path (orbit-artifact://art_x.html/?rev=2),
  // unlike orbit-media://, where the whole id falls on the host and there is no query.
  const parsed = new URL(request.url)
  const id = decodeURIComponent(parsed.host || parsed.pathname.replace(/^\/+/, '')).replace(/\/+$/, '')
  if (!SAFE_ARTIFACT_ID.test(id)) return new Response('not found', { status: 404 })
  try {
    const buffer = await fsp.readFile(path.join(assetFileDir(id), id))
    const ext = id.split('.').pop() ?? ''
    // HTML goes out with the app scrollbar injected (see ARTIFACT_CHROME).
    // The annotation is BodyInit (and not the union) so the Uint8Array keeps the generic
    // that the constructor infers — declaring `string | Uint8Array` would widen it to
    // Uint8Array<ArrayBufferLike>, which the DOM lib does not accept in Response.
    const body: BodyInit =
      ext === 'html' ? injectArtifactChrome(buffer.toString('utf8')) : new Uint8Array(buffer)
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': ARTIFACT_CONTENT_TYPES[ext] ?? 'application/octet-stream',
        // The file is rewritten in place by update_artifact: caching here
        // would serve the old revision.
        'Cache-Control': 'no-store',
      },
    })
  } catch {
    // An artifact of a paired desktop's chat: the page from there, the chrome from here.
    if (isRemoteAsset(id)) {
      if (id.endsWith('.html')) {
        const remote = await fetchRemoteText('artifact', id, '')
        if (remote && remote.status === 200) {
          return new Response(injectArtifactChrome(remote.text), {
            status: 200,
            headers: { 'Content-Type': ARTIFACT_CONTENT_TYPES.html ?? 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
          })
        }
      } else {
        const res = await fetchRemoteAsset('artifact', id, '', request)
        if (res) return res
      }
    }
    return new Response('not found', { status: 404 })
  }
}

/** Registers the artifacts protocol (call after app.whenReady). */
export function registerArtifactProtocol(): void {
  protocol.handle(ARTIFACT_SCHEME, handleArtifactRequest)
}

/**
 * Bytes of an artifact/document file — the page (.html), the thumbnail
 * (.png), the source (.md) or a rendering (.pdf/.docx).
 *
 * It serves the companion HTTP server (the phone has no
 * orbit-artifact:// protocol). The scrollbar that handleArtifactRequest injects exists
 * to match the iframe frame on the desktop and in the phone's WebView it would only get
 * in the way — but the theme tokens go WITH the page: they are not decoration, they are
 * the palette the artifact was written against (see injectArtifactTokens).
 */
export async function readArtifactAsset(
  id: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  if (!SAFE_ARTIFACT_ID.test(id)) return null
  try {
    const buffer = await fsp.readFile(path.join(assetFileDir(id), id))
    const ext = id.split('.').pop() ?? ''
    return {
      buffer:
        ext === 'html'
          ? Buffer.from(injectArtifactTokens(buffer.toString('utf8')), 'utf8')
          : buffer,
      contentType: ARTIFACT_CONTENT_TYPES[ext] ?? 'application/octet-stream',
    }
  } catch {
    return null
  }
}

/** Extracts the id from an orbit-artifact:// URL (or returns the entry if it is already an id). */
export function artifactIdFromUrl(url: string): string | null {
  let id = url
  if (url.startsWith(`${ARTIFACT_SCHEME}://`)) {
    id = url.slice(`${ARTIFACT_SCHEME}://`.length)
  }
  id = id.replace(/\/+$/, '')
  return SAFE_ARTIFACT_ID.test(id) ? id : null
}

/**
 * Id served by the capture window itself when the HTML comes in memory —
 * it avoids writing a file to disk just to be able to photograph it.
 *
 * No extra dot in the name: SAFE_ARTIFACT_ID accepts only one, the extension's.
 */
const INLINE_THUMB_ID = 'inline_thumb.html'

/**
 * The fonts scheme counts only in the default session. Every window that loads our
 * HTML in its own partition - thumbnail, PDF - needs the handler too,
 * otherwise the font installed in Orbit does not load and the render falls back
 * silently, which is exactly what the installation existed to avoid.
 */
function serveFontsOn(partition: string): void {
  session.fromPartition(partition).protocol.handle(FONT_SCHEME, handleFontRequest)
}

/**
 * Hidden and isolated window to photograph a page.
 *
 * `inlineHtml` is served by the protocol inside this capture's partition, which
 * is ephemeral and exclusive — the artifact is the model's content and does not share
 * cookies/storage with the agent's browser or with the app. Without the
 * "persist:" prefix none of it touches the disk.
 */
function openCaptureWindow(inlineHtml: string | null): BrowserWindow {
  const partition = `artifact-thumb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  serveFontsOn(partition)
  // The protocol HAS to be registered in this session too: protocol.handle
  // counts only for the default session, and without this the loadURL hangs
  // forever (it neither loads nor rejects).
  session.fromPartition(partition).protocol.handle(ARTIFACT_SCHEME, (request) => {
    if (inlineHtml !== null && request.url.includes(INLINE_THUMB_ID)) {
      return new Response(inlineHtml, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    }
    return handleArtifactRequest(request)
  })

  return new BrowserWindow({
      show: false,
      width: THUMB_VIEWPORT.width,
      height: THUMB_VIEWPORT.height,
      useContentSize: true,
      // Without this Chromium does not paint a window that was never shown and capturePage
      // comes back blank (same reason as the script engine).
      paintWhenInitiallyHidden: true,
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
    },
  })
}

/** Loads and gives it a breather so fonts/CDN/script can paint. */
async function loadForCapture(win: BrowserWindow, url: string): Promise<void> {
  // The .catch is mandatory in the race: a rejection of the loadURL after the timeout
  // would be left unhandled and would crash the main process.
  await Promise.race([
    win.loadURL(url).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, THUMB_LOAD_TIMEOUT_MS)),
  ])
  await new Promise((resolve) => setTimeout(resolve, 900))
}

/** Photographs the window and writes the reduced PNG. undefined on any failure. */
async function shot(win: BrowserWindow, thumbId: string): Promise<string | undefined> {
  if (win.isDestroyed()) return undefined
  // Same protection as the panel: with the renderer busy, capturePage may never
  // resolve, and then the whole tool would hang.
  const CAPTURE_TIMED_OUT = Symbol('captureTimedOut')
  const outcome = await Promise.race([
    win.webContents.capturePage(),
    new Promise<typeof CAPTURE_TIMED_OUT>((resolve) =>
      setTimeout(() => resolve(CAPTURE_TIMED_OUT), THUMB_LOAD_TIMEOUT_MS),
    ),
  ])
  if (outcome === CAPTURE_TIMED_OUT) return undefined
  const png = outcome.toPNG()
  if (png.length === 0) return undefined
  const buffer = await sharp(png).resize({ width: THUMB_WIDTH, withoutEnlargement: true }).png().toBuffer()
  // assetFileDir by prefix: the same capture serves artifact and document,
  // which live in different directories.
  await fsp.writeFile(path.join(assetFileDir(thumbId), thumbId), buffer)
  return thumbId
}

/**
 * Captures the thumbnail. Best-effort: any failure returns undefined and the
 * artifact stays without a thumb (the tile falls back to the icon) — the creation never
 * breaks.
 */
async function captureThumbnail(artifactId: string): Promise<string | undefined> {
  let win: BrowserWindow | null = null
  try {
    win = openCaptureWindow(null)
    await loadForCapture(win, `${ARTIFACT_SCHEME}://${artifactId}`)
    return await shot(win, `${artifactId.replace(/\.html$/, '')}.png`)
  } catch {
    return undefined
  } finally {
    if (win && !win.isDestroyed()) win.destroy()
  }
}

/**
 * Thumbnail of the LIVE document in Markdown: the cover has to look like the screen that
 * the user opens, in Orbit's theme, and not the white A4 sheet — that is the
 * face of the file, and only what was asked for as a file deserves it.
 *
 * Both themes come from the SAME window: loading costs almost a second,
 * photographing again costs almost nothing. Having both versions is what gets the
 * right tile even when the user switches the theme later — capturing only the current
 * one would leave the whole gallery mismatched on the first click of the selector.
 */
async function captureNativeThumbs(
  base: string,
  markdown: string,
  title: string,
): Promise<{ thumb?: string; thumbDark?: string }> {
  let win: BrowserWindow | null = null
  try {
    const blocks = parseMarkdown(markdown)
    win = openCaptureWindow(renderThumbHtml(blocks, title, await renderDiagrams(blocks)))
    await loadForCapture(win, `${ARTIFACT_SCHEME}://${INLINE_THUMB_ID}`)
    const thumb = await shot(win, `${base}.png`)
    if (win.isDestroyed()) return { thumb }
    await win.webContents
      .executeJavaScript("document.documentElement.classList.add('dark')")
      .catch(() => {})
    // One frame for Chromium to repaint with the swapped palette.
    await new Promise((resolve) => setTimeout(resolve, 150))
    return { thumb, thumbDark: await shot(win, `${base}_dark.png`) }
  } catch {
    return {}
  } finally {
    if (win && !win.isDestroyed()) win.destroy()
  }
}

/** What a motion piece needs to enter the gallery (see below). */
export interface SaveMotionMeta {
  /** Id of the composition in the main registry (`orbit-data/motion.json`). */
  motionId: string
  title: string
  /** The piece's working folder — the project it belongs to, for grouping. */
  directory?: string
  sessionId?: string
  messageId?: string
  width?: number
  height?: number
}

/**
 * Registers a motion PIECE in the gallery.
 *
 * A sibling of `saveArtifact`, with a difference that decides the rest: the content is NOT
 * an Orbit file. The composition is a folder of the PROJECT (the HTML entry
 * plus its dependencies) and nothing from it is copied here — the record points
 * to it through `motionId`, and opening means reopening the Motion tab.
 *
 * That is why `path` points to the COVER: deleting the gallery item has to delete
 * OUR copy (the thumbnail), never the file of whoever made the piece. And that is why the
 * id is derived from motionId — registering the same piece again UPDATES the same
 * item, instead of filling the gallery with cards of the same composition.
 */
export async function saveMotionMedia(
  thumb: Buffer | null,
  meta: SaveMotionMeta,
): Promise<MediaEntry> {
  // The id comes from motionId (which is already `mv_<hex>`): stable between runs and with
  // nothing that SAFE_ARTIFACT_ID refuses.
  const id = `mot_${meta.motionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40)}.png`
  await fsp.mkdir(artifactsDir(), { recursive: true })
  const file = path.join(artifactsDir(), id)
  if (thumb) await fsp.writeFile(file, thumb)
  return withIndexLock(async () => {
    const entries = await readIndex()
    const existing = entries.find((e) => mediaKind(e) === 'motion' && e.motionId === meta.motionId)
    const entry: MediaEntry = {
      ...existing,
      id,
      path: file,
      size: thumb ? thumb.length : (existing?.size ?? 0),
      createdAt: existing?.createdAt ?? Date.now(),
      source: 'chat',
      kind: 'motion',
      motionId: meta.motionId,
      name: meta.title,
      thumb: thumb ? id : existing?.thumb,
      sessionId: meta.sessionId ?? existing?.sessionId,
      messageId: meta.messageId ?? existing?.messageId,
      directory: meta.directory ?? existing?.directory,
      width: meta.width ?? existing?.width,
      height: meta.height ?? existing?.height,
    }
    if (existing) entries[entries.indexOf(existing)] = entry
    else entries.push(entry)
    await writeIndex(entries)
    return entry
  })
}

/** What a design canvas needs to enter the gallery — mirrors SaveMotionMeta. */
export interface SaveDesignMeta {
  /** Id of the canvas in the main registry (`orbit-data/design.json`). */
  designId: string
  title: string
  directory?: string
  sessionId?: string
  messageId?: string
  width?: number
  height?: number
}

/**
 * Registers a design CANVAS in the gallery — a sibling of `saveMotionMedia`: the
 * content is not an Orbit file, it is a folder (canvas.json + artboards) in the
 * app storage; the record only keeps the cover (from the first artboard) and the
 * `designId`, and opening means reopening the Design tab.
 */
export async function saveDesignMedia(thumb: Buffer | null, meta: SaveDesignMeta): Promise<MediaEntry> {
  const id = `dsn_${meta.designId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40)}.png`
  await fsp.mkdir(artifactsDir(), { recursive: true })
  const file = path.join(artifactsDir(), id)
  if (thumb) await fsp.writeFile(file, thumb)
  return withIndexLock(async () => {
    const entries = await readIndex()
    const existing = entries.find((e) => mediaKind(e) === 'design' && e.designId === meta.designId)
    const entry: MediaEntry = {
      ...existing,
      id,
      path: file,
      size: thumb ? thumb.length : (existing?.size ?? 0),
      createdAt: existing?.createdAt ?? Date.now(),
      source: 'chat',
      kind: 'design',
      designId: meta.designId,
      name: meta.title,
      thumb: thumb ? id : existing?.thumb,
      sessionId: meta.sessionId ?? existing?.sessionId,
      messageId: meta.messageId ?? existing?.messageId,
      directory: meta.directory ?? existing?.directory,
      width: meta.width ?? existing?.width,
      height: meta.height ?? existing?.height,
    }
    if (existing) entries[entries.indexOf(existing)] = entry
    else entries.push(entry)
    await writeIndex(entries)
    return entry
  })
}

/** What a slide deck needs to enter the gallery — mirrors SaveDesignMeta. */
export interface SaveSlidesMeta {
  /** Id of the deck in the main registry (`orbit-data/slides.json`). */
  slidesId: string
  title: string
  directory?: string
  sessionId?: string
  messageId?: string
  width?: number
  height?: number
}

/**
 * Registers a slide DECK in the gallery — a sibling of `saveDesignMedia`: the content
 * is the deck folder (a single `index.html`), the record keeps the cover (the first
 * slide) and the `slidesId`, and opening means reopening the Slides tab.
 *
 * The cover prefix is `dck_` and not `sld_` on purpose: `sld_` is already the
 * DECK id in the main registry, and two equal names in different spaces become
 * confusion when debugging.
 */
export async function saveSlidesMedia(thumb: Buffer | null, meta: SaveSlidesMeta): Promise<MediaEntry> {
  const id = `dck_${meta.slidesId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40)}.png`
  await fsp.mkdir(artifactsDir(), { recursive: true })
  const file = path.join(artifactsDir(), id)
  if (thumb) await fsp.writeFile(file, thumb)
  return withIndexLock(async () => {
    const entries = await readIndex()
    const existing = entries.find((e) => mediaKind(e) === 'slides' && e.slidesId === meta.slidesId)
    const entry: MediaEntry = {
      ...existing,
      id,
      path: file,
      size: thumb ? thumb.length : (existing?.size ?? 0),
      createdAt: existing?.createdAt ?? Date.now(),
      source: 'chat',
      kind: 'slides',
      slidesId: meta.slidesId,
      name: meta.title,
      thumb: thumb ? id : existing?.thumb,
      sessionId: meta.sessionId ?? existing?.sessionId,
      messageId: meta.messageId ?? existing?.messageId,
      directory: meta.directory ?? existing?.directory,
      width: meta.width ?? existing?.width,
      height: meta.height ?? existing?.height,
    }
    if (existing) entries[entries.indexOf(existing)] = entry
    else entries.push(entry)
    await writeIndex(entries)
    return entry
  })
}

/** Saves the HTML, captures the thumbnail and registers the artifact in the gallery. */
export async function saveArtifact(html: string, meta: SaveArtifactMeta): Promise<ArtifactRef> {
  const id = `art_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.html`
  await fsp.mkdir(artifactsDir(), { recursive: true })
  const file = path.join(artifactsDir(), id)
  await writeFileAtomic(file, html)

  const thumb = await captureThumbnail(id)
  const entry: MediaEntry = {
    id,
    path: file,
    size: Buffer.byteLength(html, 'utf8'),
    createdAt: Date.now(),
    source: 'chat',
    kind: 'artifact',
    sessionId: meta.sessionId,
    messageId: meta.messageId,
    name: meta.title,
    thumb,
    revision: 1,
  }
  await withIndexLock(async () => {
    const entries = await readIndex()
    entries.push(entry)
    await writeIndex(entries)
  })
  return { id, url: `${ARTIFACT_SCHEME}://${id}`, title: meta.title, thumb, revision: 1 }
}

/**
 * Rewrites an existing artifact IN THE SAME file (its URL and its place in the
 * conversation are kept) and recaptures the thumbnail. Returns null when the id does not
 * exist in the index.
 */
export async function updateArtifact(
  id: string,
  html: string,
  title?: string,
): Promise<ArtifactRef | null> {
  return mutateArtifact(id, () => html, title)
}

/**
 * Reads the current HTML, lets the caller transform it and writes — all inside the
 * same lock. It is what sustains EDITING as a queue: two chats on the same artifact
 * are serialized, and whoever arrives later applies over the first one's result;
 * if the text it was going to replace no longer exists, `mutate` throws and nothing is written.
 */
export async function mutateArtifact(
  id: string,
  mutate: (html: string) => string | Promise<string>,
  title?: string,
): Promise<ArtifactRef | null> {
  if (!SAFE_ARTIFACT_ID.test(id) || !id.endsWith('.html')) return null
  return withAssetLock(`artifact:${id}`, async () => {
    const entry = await getMediaEntry(id)
    if (!entry || mediaKind(entry) !== 'artifact') return null
    await journalEntryFiles(entry)

    let current = ''
    try {
      current = await fsp.readFile(entry.path, 'utf8')
    } catch {
      current = ''
    }
    const html = await mutate(current)
    await writeFileAtomic(entry.path, html)
    const thumb = (await captureThumbnail(id)) ?? entry.thumb
    const revision = (entry.revision ?? 1) + 1
    const name = title ?? entry.name ?? id

    await withIndexLock(async () => {
      const entries = await readIndex()
      const current = entries.find((e) => e.id === id)
      if (!current) return
      current.size = Buffer.byteLength(html, 'utf8')
      current.thumb = thumb
      current.revision = revision
      current.name = name
      await writeIndex(entries)
    })

    /**
     * Notifies the windows. There is a single file, but whoever is ALREADY on screen does not
     * find out on their own: the iframe of the old card was built with the
     * previous revision and does not reload by itself. Without this event the user
     * would see the old version right above the new one, in the same conversation.
     *
     * Emitted straight from here (and not by broadcast.ts) to avoid creating the cycle
     * media → broadcast → companion-server → companion-http → media.
     */
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('artifact:updated', { artifactId: id, revision })
    }

    return { id, url: `${ARTIFACT_SCHEME}://${id}`, title: name, thumb, revision }
  })
}

/**
 * Links an artifact to the message where it appeared — same reason as
 * attachMediaMessage: the tool runs in the middle of the turn and does not know the
 * message id, and it is that link that makes the gallery's "open in chat" work.
 */
export async function attachArtifactMessage(
  id: string,
  messageId: string,
  sessionId?: string,
): Promise<void> {
  if (!SAFE_ARTIFACT_ID.test(id)) return
  await withIndexLock(async () => {
    const entries = await readIndex()
    const entry = entries.find((e) => e.id === id)
    if (!entry) return
    entry.messageId = messageId
    if (sessionId) entry.sessionId = sessionId
    await writeIndex(entries)
  })
}

/** Reads the HTML of an artifact — used by the companion (no access to the protocol)
 *  and by the export. */
export async function readArtifact(id: string): Promise<{ html: string; entry: MediaEntry } | null> {
  if (!SAFE_ARTIFACT_ID.test(id)) return null
  const entry = await getMediaEntry(id)
  if (!entry || mediaKind(entry) !== 'artifact') return null
  try {
    return { html: await fsp.readFile(entry.path, 'utf8'), entry }
  } catch {
    return null
  }
}

// ─── Documents (PDF / DOCX) ─────────────────────────────────────────────

/**
 * Document authored by the agent. The SOURCE is Markdown; PDF and DOCX are
 * renderings of it, and the HTML is the preview shown in the conversation.
 *
 * The document is BORN only in Markdown: an empty `formats` is the normal case, not a
 * failure. Rendering on creation cost one Chromium window per document —
 * and most never become a file, because the user reads in the chat and moves on. PDF and
 * DOCX start to be produced on the first request (download, open in the panel) and
 * stay cached in the record. Whoever explicitly asks for a PDF or a .docx
 * still gets the rendering at creation time, through `formats`.
 *
 * The preview is HTML, and not the PDF, because of a hard limitation: Electron does not
 * ship Chrome's PDF viewer — loading a .pdf fails with
 * ERR_FAILED even as a top-level page. Since the PDF is born FROM THIS html (via
 * printToPDF), the preview is faithful to the printed output even without rendering the binary.
 *
 * Keeping the Markdown is what makes "modify" truly possible: editing a
 * PDF or preserving the formatting of an existing .docx is intractable; rewriting
 * the source and rendering again is exact.
 */

export interface SaveDocumentMeta {
  title: string
  style?: DocumentStyle
  sessionId?: string
  messageId?: string
  /** Session working folder — the document's project scope. */
  directory?: string
  /** Sidebar folder (chat mode, without a directory). */
  folderId?: string
}

export interface DocumentRef {
  /** SOURCE id: doc_xxx.md — also the record id in the gallery. */
  id: string
  title: string
  previewUrl: string
  formats: DocumentFormat[]
  thumb?: string
  revision: number
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fsp.access(file)
    return true
  } catch {
    return false
  }
}

/** Base of the id, without extension: doc_xxx */
function documentBase(id: string): string {
  return id.replace(/\.(md|html|pdf|docx|png)$/, '')
}

/**
 * Generates the PDF from the HTML already written, with Chromium — no PDF
 * library enters the project. The window loads through orbit-artifact://, so the
 * print CSS (@page A4) is the same one the preview uses.
 */
async function renderPdf(htmlId: string): Promise<Buffer | null> {
  let win: BrowserWindow | null = null
  try {
    const partition = `document-pdf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    // The same trap as the thumbnail: protocol.handle counts only in the default session,
    // and without registering it here the loadURL never resolves.
    session.fromPartition(partition).protocol.handle(ARTIFACT_SCHEME, handleArtifactRequest)
    serveFontsOn(partition)

    win = new BrowserWindow({
      show: false,
      width: 1024,
      height: 1400,
      paintWhenInitiallyHidden: true,
      webPreferences: { partition, nodeIntegration: false, contextIsolation: true, sandbox: true },
    })
    const target = win
    await Promise.race([
      target.loadURL(`${ARTIFACT_SCHEME}://${htmlId}`).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, THUMB_LOAD_TIMEOUT_MS)),
    ])
    await new Promise((resolve) => setTimeout(resolve, 400))
    if (target.isDestroyed()) return null

    return await target.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      // Zero here on purpose: the margins already come from the document's CSS
      // padding (@page + body), and adding printToPDF's would give a doubled
      // margin — the text would be squeezed into the middle of the sheet.
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    })
  } catch {
    return null
  } finally {
    if (win && !win.isDestroyed()) win.destroy()
  }
}

/**
 * The document's HTML — the preview and the matrix of the PDF — with the Mermaid diagrams
 * already drawn as SVG. The PDF is the print of that file, with no script running,
 * so the diagram has to be ready in it.
 */
async function documentHtml(markdown: string, title: string, style?: DocumentStyle): Promise<string> {
  const blocks = parseMarkdown(markdown)
   // The requested font may be from Orbit's library: then the PDF only knows it if
   // the @font-face comes along in the HTML (the print window is another session).
   // A system font name has no declaration - it returns empty and nothing changes.
  const faces = await fontFacesForFamily(normalizeStyle(style).fontFamily)
  return renderHtml(blocks, title, style, await renderDiagrams(blocks), faces)
}

/**
 * A rendering, from what is already on disk: the PDF is born from the .html
 * (printToPDF), the .docx is born from the Markdown. null when it failed — a format that
 * did not come out cannot be in the record.
 */
async function renderDocumentFormat(
  base: string,
  format: DocumentFormat,
  markdown: string,
  title: string,
  style?: DocumentStyle,
): Promise<Buffer | null> {
  if (format === 'pdf') return renderPdf(`${base}.html`)
  try {
    const blocks = parseMarkdown(markdown)
    return await buildDocx(blocks, title, style, await renderDiagrams(blocks))
  } catch {
    return null
  }
}

/** Writes the source, the preview and the requested renderings. Returns the formats that
 *  were actually generated — a PDF that failed cannot be in the record. */
async function writeDocumentFiles(
  base: string,
  markdown: string,
  html: string,
  formats: DocumentFormat[],
  title: string,
  style?: DocumentStyle,
): Promise<DocumentFormat[]> {
  const dir = documentsDir()
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, `${base}.md`), markdown, 'utf8')
  await fsp.writeFile(path.join(dir, `${base}.html`), html, 'utf8')

  const done: DocumentFormat[] = []
  // Set: `formats` comes from the model and a repeated format would write the file twice
  // and enter the record duplicated.
  for (const format of new Set(formats)) {
    const bytes = await renderDocumentFormat(base, format, markdown, title, style)
    if (!bytes) continue
    await fsp.writeFile(path.join(dir, `${base}.${format}`), bytes)
    done.push(format)
  }
  return done
}

export async function saveDocument(
  markdown: string,
  formats: DocumentFormat[],
  meta: SaveDocumentMeta,
): Promise<DocumentRef> {
  const base = `doc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const html = await documentHtml(markdown, meta.title, meta.style)
  const written = await writeDocumentFiles(base, markdown, html, formats, meta.title, meta.style)
  // The cover follows the document's DESTINATION: what is going to become a file is photographed
  // as a sheet; what stays live in Markdown, as the native screen.
  const { thumb, thumbDark } =
    formats.length > 0
      ? { thumb: await captureThumbnail(`${base}.html`), thumbDark: undefined }
      : await captureNativeThumbs(base, markdown, meta.title)

  const id = `${base}.md`
  const file = path.join(documentsDir(), id)
  const entry: MediaEntry = {
    id,
    path: file,
    size: Buffer.byteLength(markdown, 'utf8'),
    createdAt: Date.now(),
    source: 'chat',
    kind: 'document',
    sessionId: meta.sessionId,
    messageId: meta.messageId,
    directory: meta.directory,
    folderId: meta.folderId,
    name: meta.title,
    formats: written,
    // What was REQUESTED, and not what came out: a PDF that failed does not become a live
    // document by accident — the destination is still the file.
    delivery: formats.length > 0 ? [...new Set(formats)] : undefined,
    style: meta.style as Record<string, unknown> | undefined,
    thumb,
    thumbDark,
    revision: 1,
  }
  await withIndexLock(async () => {
    const entries = await readIndex()
    entries.push(entry)
    await writeIndex(entries)
  })
  return {
    id,
    title: meta.title,
    previewUrl: `${ARTIFACT_SCHEME}://${base}.html`,
    formats: written,
    thumb,
    revision: 1,
  }
}

export type UpdateDocumentResult =
  | { ok: true; ref: DocumentRef }
  | { ok: false; reason: 'notFound' }
  /** The document moved on since the version the agent based itself on. */
  | { ok: false; reason: 'stale'; revision: number }

/**
 * Rewrites an existing document UNDER THE SAME id. "Modify" is rewriting the
 * source and rendering again: editing the binary while preserving formatting is
 * intractable, and the stored source makes the rewrite exact.
 *
 * And rewriting is DESTRUCTIVE: the new text replaces the previous one entirely. Since the
 * user edits the same file in the canvas, a rewrite based on an old read
 * would silently erase what they typed in the meantime. Hence the
 * `baseRevision`: the agent says which version it started from, and this function refuses
 * when the document has already moved on.
 *
 * Without `baseRevision` the write goes through — that is the case of whoever produced the text
 * from scratch and read nothing. The exception is the document with a pending human edit:
 * there, writing blind is exactly the accident to be avoided, so reading
 * becomes mandatory.
 */
export async function updateDocument(
  id: string,
  markdown: string,
  options: {
    title?: string
    formats?: DocumentFormat[]
    style?: DocumentStyle
    baseRevision?: number
  },
): Promise<UpdateDocumentResult> {
  const entry = await getMediaEntry(id)
  if (!entry || mediaKind(entry) !== 'document') return { ok: false, reason: 'notFound' }

  const knownRevision = entry.revision ?? 1
  const stale =
    options.baseRevision !== undefined
      ? options.baseRevision !== knownRevision
      : entry.userEdited === true
  if (stale) return { ok: false, reason: 'stale', revision: knownRevision }
  await journalEntryFiles(entry)

  const base = documentBase(id)
  const title = options.title ?? entry.name ?? 'Documento'
  // Omitting `formats` keeps what the document already has rendered — including
  // nothing. Falling back to ['pdf'] here would make the first edit of a document that
  // was born only in Markdown generate a file nobody asked for.
  const formats = options.formats ?? entry.formats ?? []
  // Omitted style = keeps what the document already had. Without this, touching the
  // text would reset the font and colors chosen before.
  const style = (options.style ?? entry.style) as DocumentStyle | undefined
  const html = await documentHtml(markdown, title, style)
  const written = await writeDocumentFiles(base, markdown, html, formats, title, style)
  const asFile = formats.length > 0
  const captured = asFile
    ? { thumb: await captureThumbnail(`${base}.html`), thumbDark: undefined }
    : await captureNativeThumbs(base, markdown, title)
  const thumb = captured.thumb ?? entry.thumb
  // It became a file: the dark cover stops existing, otherwise the tile would keep
  // showing the native screen of a document that is now a sheet.
  const thumbDark = asFile ? undefined : (captured.thumbDark ?? entry.thumbDark)
  const revision = (entry.revision ?? 1) + 1

  await withIndexLock(async () => {
    const entries = await readIndex()
    const current = entries.find((e) => e.id === id)
    if (!current) return
    current.size = Buffer.byteLength(markdown, 'utf8')
    current.name = title
    current.formats = written
    // Asking for a format now ("send it to me in Word") changes the document's destination;
    // omitting keeps what it already was.
    if (options.formats?.length) current.delivery = [...new Set(options.formats)]
    // The agent wrote knowing the user's version: there is no longer a human
    // edit pending to be seen.
    current.userEdited = false
    current.style = style as Record<string, unknown> | undefined
    current.thumb = thumb
    current.thumbDark = thumbDark
    current.revision = revision
    await writeIndex(entries)
  })

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('artifact:updated', { artifactId: `${base}.html`, revision })
    }
  }

  return {
    ok: true,
    ref: { id, title, previewUrl: `${ARTIFACT_SCHEME}://${base}.html`, formats: written, thumb, revision },
  }
}

/** Source Markdown — it is what the agent re-reads before modifying. */
export async function readDocumentSource(
  id: string,
): Promise<{ markdown: string; entry: MediaEntry } | null> {
  const entry = await getMediaEntry(id)
  if (!entry || mediaKind(entry) !== 'document') return null
  try {
    return { markdown: await fsp.readFile(entry.path, 'utf8'), entry }
  } catch {
    return null
  }
}

/**
 * The USER's edit in the canvas: rewrites the source and the preview, and nothing else.
 *
 * Unlike updateDocument, which is the agent's rewrite, here no file is
 * rendered and no thumbnail is captured: this runs on every pause in
 * typing, and opening a Chromium window on every sentence would make the editor
 * heavy. The renderings on disk are marked as stale — `formats`
 * is zeroed, so the next download redoes the file from the new text in
 * stead of delivering the previous version.
 *
 * The thumbnail ages until the agent's next write. It is the cover of the tile
 * in the gallery: it lags, it does not lie about the content.
 *
 * A derived document does not enter here: its Markdown is a note, and writing over
 * it would erase the note without touching the file the user sees.
 *
 * The `baseRevision` is the same guard as updateDocument, in the opposite direction: the
 * agent also writes in this file, and a write based on the previous text
 * would erase what it just produced. Refusing returns the revision that
 * is on disk, so the canvas can offer the choice instead of deciding on its own.
 */
export type SaveDocumentEditResult =
  | { ok: true; revision: number }
  | { ok: false; reason: 'notFound' }
  | { ok: false; reason: 'stale'; revision: number }

export async function saveDocumentEdit(
  id: string,
  markdown: string,
  baseRevision?: number,
): Promise<SaveDocumentEditResult> {
  const entry = await getMediaEntry(id)
  if (!entry || mediaKind(entry) !== 'document' || entry.derived) {
    return { ok: false, reason: 'notFound' }
  }
  const knownRevision = entry.revision ?? 1
  if (baseRevision !== undefined && baseRevision !== knownRevision) {
    return { ok: false, reason: 'stale', revision: knownRevision }
  }

  const base = documentBase(id)
  const title = entry.name ?? 'Documento'
  const dir = documentsDir()
  await fsp.writeFile(path.join(dir, `${base}.md`), markdown, 'utf8')
  await fsp.writeFile(
    path.join(dir, `${base}.html`),
    await documentHtml(markdown, title, entry.style as DocumentStyle | undefined),
    'utf8',
  )

  const revision = knownRevision + 1
  await withIndexLock(async () => {
    const entries = await readIndex()
    const current = entries.find((e) => e.id === id)
    if (!current) return
    current.size = Buffer.byteLength(markdown, 'utf8')
    current.formats = []
    current.revision = revision
    // From here on the agent cannot rewrite without reading first: what is on
    // disk is the person's work, not the last version it knows.
    current.userEdited = true
    await writeIndex(entries)
  })

  // Same warning as updateDocument: the card in the conversation shows the preview through
  // the .html URL, which does not change when the file is rewritten in place.
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('artifact:updated', { artifactId: `${base}.html`, revision })
    }
  }
  return { ok: true, revision }
}

/** Records the source this document became, so as not to promote it twice. */
export async function setDocumentSourceId(id: string, sourceId: string): Promise<void> {
  await withIndexLock(async () => {
    const entries = await readIndex()
    const current = entries.find((e) => e.id === id)
    if (!current) return
    current.sourceId = sourceId
    await writeIndex(entries)
  })
}

/** What the renderer needs to decide in which tab the document opens. */
export async function documentInfo(
  id: string,
): Promise<Pick<MediaEntry, 'id' | 'name' | 'delivery' | 'derived' | 'formats' | 'revision'> | null> {
  const entry = await getMediaEntry(id)
  if (!entry || mediaKind(entry) !== 'document') return null
  return {
    id: entry.id,
    name: entry.name,
    delivery: entry.delivery,
    derived: entry.derived,
    formats: entry.formats,
    revision: entry.revision,
  }
}

/** Absolute path of a rendering THAT ALREADY EXISTS — it generates nothing. */
export async function documentFilePath(id: string, format: DocumentFormat): Promise<string | null> {
  const entry = await getMediaEntry(id)
  if (!entry || mediaKind(entry) !== 'document') return null
  if (!(entry.formats ?? []).includes(format)) return null
  return path.join(documentsDir(), `${documentBase(id)}.${format}`)
}

/**
 * Path of a rendering, GENERATING IT when it does not exist yet.
 *
 * It is what sustains the document that is born only in Markdown: the PDF and the .docx are
 * produced at the moment someone asks for them — the download button, the
 * panel viewer — and stay written in the record, so the second request
 * is free.
 *
 * It only applies to a document with a Markdown source. The DERIVED ones (the copy of an
 * attached .docx, the result of merging PDFs) have no source: what would be
 * rendered there is the preview, not the document, and the conversion would come out worse than
 * the file already on disk.
 */
export async function ensureDocumentRender(
  id: string,
  format: DocumentFormat,
): Promise<string | null> {
  const entry = await getMediaEntry(id)
  if (!entry || mediaKind(entry) !== 'document') return null

  const base = documentBase(id)
  const file = path.join(documentsDir(), `${base}.${format}`)
  // A derived document has nothing to render: the record's Markdown is a note, and
  // generating a .docx from it would deliver an empty file that looks like a
  // document. What is on disk counts, and only that.
  if (entry.derived) return (entry.formats ?? []).includes(format) ? file : null
  // The record says what was rendered, but the disk is what decides: the file
  // may have been deleted from outside, and then it is worth generating it again instead of returning
  // a path that does not open.
  if ((entry.formats ?? []).includes(format) && (await fileExists(file))) return file

  const markdown = await fsp.readFile(entry.path, 'utf8').catch(() => null)
  if (markdown === null) return null
  const bytes = await renderDocumentFormat(
    base,
    format,
    markdown,
    entry.name ?? 'Documento',
    entry.style as DocumentStyle | undefined,
  )
  if (!bytes) return null
  await fsp.writeFile(file, bytes)

  await withIndexLock(async () => {
    const entries = await readIndex()
    const current = entries.find((e) => e.id === id)
    if (!current || (current.formats ?? []).includes(format)) return
    current.formats = [...(current.formats ?? []), format]
    await writeIndex(entries)
  })
  return file
}

/** Links the document to the message where it appeared (same reason as
 *  attachMediaMessage: the tool runs in the middle of the turn). */
export async function attachDocumentMessage(
  id: string,
  messageId: string,
  sessionId?: string,
): Promise<void> {
  await attachArtifactMessage(id, messageId, sessionId)
}

export type { MediaKind }

/**
 * DERIVED document: an edited copy of a .docx that came from outside.
 *
 * Unlike saveDocument, here there is NO Markdown source — the file is the
 * user's original with the text swapped, and that is exactly what preserves the
 * formatting. That is why the .docx is written as it is and the preview is generated
 * separately (mammoth → HTML), just so the conversation card has something to show.
 *
 * The original is never touched: the copy lives in Orbit's storage and leaves it through the
 * download button.
 */
export async function saveDerivedDocx(
  docx: Buffer,
  meta: SaveDocumentMeta & { sourceName?: string },
): Promise<DocumentRef> {
  const base = `doc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const dir = documentsDir()
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, `${base}.docx`), docx)

  // Preview: mammoth's HTML inside the same document CSS, so the card
  // looks like the ones of the documents Orbit writes.
  let previewHtml: string
  try {
    const { value } = await mammoth.convertToHtml({ buffer: docx })
    previewHtml = renderHtml([], meta.title).replace('</body>', `${value}\n</body>`)
  } catch {
    previewHtml = renderHtml(parseMarkdown(`# ${meta.title}\n\n${tNow('media.previewUnavailable')}`), meta.title)
  }
  await fsp.writeFile(path.join(dir, `${base}.html`), previewHtml, 'utf8')
  const thumb = await captureThumbnail(`${base}.html`)

  const id = `${base}.md` // the record id follows the documents pattern
  await fsp.writeFile(
    path.join(dir, id),
    `<!-- edited copy of ${meta.sourceName ?? 'attached document'}; the real content is in the .docx -->\n`,
    'utf8',
  )
  const entry: MediaEntry = {
    id,
    path: path.join(dir, id),
    size: docx.length,
    createdAt: Date.now(),
    source: 'chat',
    kind: 'document',
    sessionId: meta.sessionId,
    messageId: meta.messageId,
    directory: meta.directory,
    folderId: meta.folderId,
    name: meta.title,
    formats: ['docx'],
    derived: true,
    thumb,
    revision: 1,
  }
  await withIndexLock(async () => {
    const entries = await readIndex()
    entries.push(entry)
    await writeIndex(entries)
  })
  return {
    id,
    title: meta.title,
    previewUrl: `${ARTIFACT_SCHEME}://${base}.html`,
    formats: ['docx'],
    thumb,
    revision: 1,
  }
}

/**
 * DERIVED PDF: result of merging, cropping, rotating, stamping or filling.
 *
 * The preview is made with the RASTERIZED PAGES, not with the binary: Electron
 * does not ship a PDF viewer, so the only way to show a PDF in the
 * conversation is to render it as an image. It is the same rasterization that makes the
 * scanned file legible, reused for display.
 */

/** Pages shown in the preview — enough to recognize the document
 *  without turning the card into a viewer. */
const PREVIEW_PAGE_COUNT = 3

export async function saveDerivedPdf(
  pdf: Buffer,
  meta: SaveDocumentMeta & { sourceName?: string },
): Promise<DocumentRef> {
  const base = `doc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const dir = documentsDir()
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, `${base}.pdf`), pdf)

  // Rasterizes the first pages and builds the preview with them.
  let body = `<p>${tNow('media.previewUnavailable')}</p>`
  try {
    const pages = Array.from({ length: PREVIEW_PAGE_COUNT }, (_, i) => i + 1)
    const rendered = await rasterizePdf(pdf, { pages, scale: 1.2 })
    const imgs: string[] = []
    for (const page of rendered.pages) {
      const name = `${base}-p${page.pageNumber}.png`
      await fsp.writeFile(path.join(dir, name), page.png)
      imgs.push(
        `<img src="${ARTIFACT_SCHEME}://${name}" alt="page ${page.pageNumber}" style="width:100%;display:block;margin:0 0 1.2em;box-shadow:0 0 0 1px #ddd">`,
      )
    }
    const rest =
      rendered.total > rendered.pages.length
        ? `<p style="text-align:center;color:#666">${tNow('media.morePages', { count: rendered.total - rendered.pages.length })}</p>`
        : ''
    body = imgs.join('\n') + rest
  } catch {
    // the preview is a convenience: the file counts even without it
  }
  const html = renderHtml([], meta.title).replace('</body>', `${body}\n</body>`)
  await fsp.writeFile(path.join(dir, `${base}.html`), html, 'utf8')
  const thumb = await captureThumbnail(`${base}.html`)

  const id = `${base}.md`
  await fsp.writeFile(
    path.join(dir, id),
    `<!-- PDF derived from ${meta.sourceName ?? 'attached document'}; the real content is in the .pdf -->\n`,
    'utf8',
  )
  const entry: MediaEntry = {
    id,
    path: path.join(dir, id),
    size: pdf.length,
    createdAt: Date.now(),
    source: 'chat',
    kind: 'document',
    sessionId: meta.sessionId,
    messageId: meta.messageId,
    directory: meta.directory,
    folderId: meta.folderId,
    name: meta.title,
    formats: ['pdf'],
    derived: true,
    thumb,
    revision: 1,
  }
  await withIndexLock(async () => {
    const entries = await readIndex()
    entries.push(entry)
    await writeIndex(entries)
  })
  return { id, title: meta.title, previewUrl: `${ARTIFACT_SCHEME}://${base}.html`, formats: ['pdf'], thumb, revision: 1 }
}
