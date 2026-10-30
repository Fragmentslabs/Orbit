import fsp from 'node:fs/promises'
import path from 'node:path'
import { mediaKind, type MediaEntry } from '@shared/media'
import type { SessionMediaRevert } from '@shared/chat'
import { withAssetLock } from '../asset-lock'
import { entryOwnedFiles, getMediaEntry, listMedia, restoreMediaEntries } from '../media'
import { panelPiecesRemoved } from '../panel-browser'
import { refreshDesignCover } from '../design/design-gallery'
import { registerDesign, rewatchDesign, unregisterDesign } from '../design/design-store'
import { registerSlidesCover } from '../slides/slides-gallery'
import { registerSlides, rewatchSlides, unregisterSlides } from '../slides/slides-store'
import { registerMotionCover } from '../video/motion-gallery'
import { registerMotion, rewatchMotion, unregisterMotion } from '../video/motion-store'
import { restoreVideoRegistration, unregisterVideosFor } from '../video/store'
import {
  REDO_DIR,
  captureJournal,
  deleteMediaJournals,
  deleteRedoJournal,
  finalizeJournal,
  hashPath,
  mergeJournals,
  readMediaJournal,
  readRedoJournal,
  restorePaths,
  samePathState,
  sessionJournalDir,
  type LoadedJournal,
  type PathState,
  type PieceKind,
  type PieceRef,
  type RestoreRecord,
} from './media-journal'

/**
 * Applies the media journal (media-journal.ts) on the revert and the unrevert of the
 * message. It holds in BOTH modes: the pieces and the gallery live in the app
 * storage, not in the working folder — the snapshot of code mode does not reach them.
 *
 * Revert: joins the journals of the discarded turns and, for EACH path/entry,
 * compares the current state with the FINAL state the turn left. It only undoes
 * what is still as the turn left it; what changed afterwards (another conversation,
 * an edit in the panel, a file touched from outside) stays intact and is reported as
 * a conflict. It stores the current state as the redo (with the post-revert state) and
 * reconciles whatever points at the paths (piece registry, watcher, cover,
 * video player, tabs).
 *
 * Unrevert: applies the redo with the SAME rule — if something changed between the revert and
 * the unrevert, that item is preserved and becomes a conflict.
 */

const PIECE_KINDS: PieceKind[] = ['motion', 'design', 'slides']

type Status = 'safe' | 'conflict' | 'already'

interface Partition {
  safe: RestoreRecord[]
  conflicts: RestoreRecord[]
  already: RestoreRecord[]
  statusById: Map<string, Status>
  conflictLabels: string[]
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function pieceKey(piece: PieceRef): string {
  return `${piece.kind}:${piece.id}`
}

function labelOfEntry(entry: MediaEntry | null, fallback: string): string {
  return entry?.name?.trim() || fallback
}

function labelOfRecord(record: RestoreRecord): string {
  if (record.type === 'media') return labelOfEntry(record.after ?? record.before, record.id)
  if (record.piece) return path.basename(record.piece.folder)
  return record.path
}

/** Id of the piece in a gallery entry (cover), or null in an ordinary asset. */
function entryPieceId(entry: MediaEntry | null | undefined): string | null {
  if (!entry) return null
  return entry.motionId ?? entry.designId ?? entry.slidesId ?? null
}

/**
 * A gallery entry is the COVER of a piece whose folder is a separate
 * record. If the folder was preserved (an edit by hand after the turn), the cover
 * cannot vanish either — otherwise the piece sits on disk with no tile in the gallery.
 */
function propagatePieceConflicts(part: Partition): void {
  const conflictedPieces = new Set<string>()
  for (const record of part.conflicts) {
    if (record.type === 'path' && record.piece) conflictedPieces.add(record.piece.id)
  }
  if (conflictedPieces.size === 0) return
  const kept: RestoreRecord[] = []
  for (const record of part.safe) {
    if (record.type === 'media') {
      const pieceId = entryPieceId(record.after ?? record.before)
      if (pieceId && conflictedPieces.has(pieceId)) {
        part.conflicts.push(record)
        const label = labelOfEntry(record.after ?? record.before, record.id)
        if (!part.conflictLabels.includes(label)) part.conflictLabels.push(label)
        continue
      }
    }
    kept.push(record)
  }
  part.safe = kept
}

/**
 * Fields that say what an asset IS. Cover (`thumb`/`thumbDark`), `url`,
 * `messageId` and `linkedSessionIds` stay out: they are cosmetic/bookkeeping and
 * change in the background (the cover of the piece is redone after the turn) — comparing
 * by them would turn every revert of a piece into a false conflict.
 */
function stableFields(entry: MediaEntry): Array<keyof MediaEntry> {
  const kind = mediaKind(entry)
  if (kind === 'artifact') return ['kind', 'path', 'name', 'revision']
  if (kind === 'document') {
    return ['kind', 'path', 'name', 'revision', 'userEdited', 'formats', 'delivery', 'style', 'derived']
  }
  if (kind === 'motion' || kind === 'design' || kind === 'slides') {
    return ['kind', 'path', 'name', 'motionId', 'designId', 'slidesId']
  }
  if (kind === 'video') {
    return ['kind', 'path', 'name', 'size', 'videoUrl', 'durationMs', 'parentId']
  }
  return ['kind', 'path', 'name', 'size', 'parentId', 'source', 'createdAt']
}

/** Same identity and same content state — not the same object. */
function sameAssetState(a: MediaEntry | null, b: MediaEntry | null): boolean {
  if (!a || !b) return a === b
  if (a.id !== b.id) return false
  const fields = new Set<keyof MediaEntry>([...stableFields(a), ...stableFields(b)])
  for (const field of fields) {
    if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) return false
  }
  return true
}

async function currentEntry(id: string): Promise<MediaEntry | null> {
  return getMediaEntry(id)
}

/**
 * Decides, record by record, what can be undone.
 *
 * Gallery entry: `after` is what the turn wrote; if the current one matches, it is
 * safe; if it matches `before`, it is already undone; otherwise it is a conflict.
 * File: the same, with a hash. A file that belongs to an entry (artifact,
 * document) is NOT judged on its own — the entry decides; the cover may be
 * regenerated in the background without that being an edit.
 */
async function partition(records: RestoreRecord[]): Promise<Partition> {
  const statusById = new Map<string, Status>()
  const safe: RestoreRecord[] = []
  const conflicts: RestoreRecord[] = []
  const already: RestoreRecord[] = []
  const labels = new Set<string>()

  const mediaRecords = records.filter(
    (r): r is Extract<RestoreRecord, { type: 'media' }> => r.type === 'media',
  )
  const mediaById = new Map(mediaRecords.map((r) => [r.id, r]))
  /**
   * The MAIN file of each entry (the HTML of the artifact, the .md of the
   * document). The revision alone is not enough: after a revert the revision
   * goes back, and a later external write may reuse the same number with another
   * content. The hash of the file is the proof the revision does not give.
   */
  const primaryPath = new Map<string, Extract<RestoreRecord, { type: 'path' }>>()
  for (const record of records) {
    if (record.type !== 'path' || !record.owner) continue
    const media = mediaById.get(record.owner)
    if (!media) continue
    const ownerPath = media.after?.path ?? media.before?.path
    if (!ownerPath) continue
    if (path.resolve(record.path) !== path.resolve(ownerPath)) continue
    primaryPath.set(record.owner, record)
  }

  for (const record of mediaRecords) {
    const current = await currentEntry(record.id)
    const file = primaryPath.get(record.id)
    const fileState = file ? await hashPath(file.path) : null
    const fileMatches = (state: PathState | undefined): boolean => {
      if (!file) return true
      // Without a final state of the file (old journal/crash), there is no way to prove it.
      if (!state) return false
      return samePathState(fileState!, state)
    }
    const beforeFileState: PathState | undefined = file
      ? file.backupFile
        ? await hashPath(file.backupFile)
        : { exists: false, hash: null }
      : undefined

    let status: Status
    if (record.after === undefined) {
      // Old/crashed journal: without a final state there is no way to prove that the
      // turn still owns the current state.
      status = 'conflict'
    } else if (
      sameAssetState(current, record.after) &&
      fileMatches(file?.after)
    ) {
      status = 'safe'
    } else if (
      sameAssetState(current, record.before) &&
      fileMatches(beforeFileState)
    ) {
      status = 'already'
    } else {
      status = 'conflict'
    }
    statusById.set(record.id, status)
    if (status === 'safe') safe.push(record)
    else if (status === 'already') already.push(record)
    else {
      conflicts.push(record)
      labels.add(labelOfEntry(record.after ?? record.before, record.id))
    }
  }

  for (const record of records) {
    if (record.type !== 'path') continue
    // File of a known entry: the entry decides.
    if (record.owner && statusById.has(record.owner)) {
      const ownerStatus = statusById.get(record.owner)!
      if (ownerStatus === 'safe') safe.push(record)
      else if (ownerStatus === 'already') already.push(record)
      else conflicts.push(record)
      continue
    }
    if (record.after === undefined) {
      conflicts.push(record)
      labels.add(labelOfRecord(record))
      continue
    }
    const current = await hashPath(record.path)
    if (samePathState(current, record.after)) {
      safe.push(record)
      continue
    }
    const before: PathState = record.backupFile
      ? await hashPath(record.backupFile)
      : { exists: false, hash: null }
    if (samePathState(current, before)) {
      already.push(record)
      continue
    }
    conflicts.push(record)
    labels.add(labelOfRecord(record))
  }

  return { safe, conflicts, already, statusById, conflictLabels: [...labels] }
}

async function inGallery(kind: PieceKind, id: string): Promise<boolean> {
  const items = await listMedia({ kind }).catch(() => [] as MediaEntry[])
  return items.some(
    (item) => (kind === 'motion' ? item.motionId : kind === 'design' ? item.designId : item.slidesId) === id,
  )
}

/**
 * After the folder comes back (or vanishes): the piece that exists goes back to the registry with
 * the watcher reconnected and the cover redone; the one that no longer exists leaves the registry and
 * has its tabs closed.
 */
async function reconcilePieces(pieces: PieceRef[]): Promise<void> {
  const removed: Record<PieceKind, string[]> = { motion: [], design: [], slides: [] }
  for (const piece of pieces) {
    const exists = (await fsp.stat(piece.folder).catch(() => null))?.isDirectory() ?? false
    try {
      if (!exists) {
        if (piece.kind === 'motion') await unregisterMotion(piece.id)
        else if (piece.kind === 'design') await unregisterDesign(piece.id)
        else await unregisterSlides(piece.id)
        removed[piece.kind].push(piece.id)
        continue
      }
      const opts = { root: piece.root, sessionId: piece.sessionId }
      if (piece.kind === 'motion') {
        await registerMotion(piece.folder, piece.entry, opts)
        await rewatchMotion(piece.id)
        if (await inGallery('motion', piece.id)) {
          void registerMotionCover(piece.id, { sessionId: piece.sessionId }).catch(() => false)
        }
      } else if (piece.kind === 'design') {
        await registerDesign(piece.folder, opts)
        await rewatchDesign(piece.id)
        if (await inGallery('design', piece.id)) refreshDesignCover(piece.id, { sessionId: piece.sessionId })
      } else {
        await registerSlides(piece.folder, { ...opts, entry: piece.entry })
        await rewatchSlides(piece.id)
        if (await inGallery('slides', piece.id)) {
          void registerSlidesCover(piece.id, {
            title: path.basename(piece.folder),
            sessionId: piece.sessionId,
          }).catch(() => false)
        }
      }
    } catch (err) {
      console.error(`[media-revert] reconciliar ${piece.kind} ${piece.id} failed:`, err)
    }
  }
  panelPiecesRemoved(removed)
}

function conflictCount(records: RestoreRecord[], partition: Partition): number {
  const mediaIds = new Set(records.filter((r) => r.type === 'media').map((r) => r.id))
  const pieceIds = new Set(
    partition.conflicts
      .filter((r): r is Extract<RestoreRecord, { type: 'media' }> => r.type === 'media')
      .map((r) => entryPieceId(r.after ?? r.before))
      .filter((id): id is string => Boolean(id)),
  )
  let count = 0
  for (const record of partition.conflicts) {
    if (record.type === 'media') count += 1
    // File of a conflicting entry already counted by the entry.
    else if (record.owner && mediaIds.has(record.owner)) continue
    // Folder of a conflicting piece already counted by the cover (same piece).
    else if (record.piece && pieceIds.has(record.piece.id)) continue
    else count += 1
  }
  return count
}

/**
 * Applies a set of records with the conflict rule.
 *
 * `redoDir` (revert only): before applying, it stores the current state of the safe
 * items — it is what the unrevert gives back. After applying, it writes the final
 * state (what the unrevert will require to find so that it can undo).
 */
async function applyJournal(records: RestoreRecord[], redoDir?: string): Promise<SessionMediaRevert> {
  const part = await partition(records)
  propagatePieceConflicts(part)
  const safe = [...part.safe]
  const safeMedia = part.safe.filter(
    (r): r is Extract<RestoreRecord, { type: 'media' }> => r.type === 'media',
  )

  // Files the safe entry has NOW and did not have before (new cover,
  // new document render, artifact created in the turn): they go away with it.
  // The ones that were already there are restored by their own records.
  for (const record of safeMedia) {
    const now = await currentEntry(record.id)
    if (!now) continue
    const before = new Set(record.before ? await entryOwnedFiles(record.before) : [])
    for (const file of await entryOwnedFiles(now)) {
      if (before.has(file)) continue
      if (safe.some((r) => r.type === 'path' && isInside(r.path, file))) continue
      safe.push({
        type: 'path',
        path: file,
        backupFile: null,
        owner: record.id,
        // The current state is what the turn left (the entry is safe); the
        // record only needs to exist so that the redo stores the bytes.
        after: await hashPath(file),
      })
    }
  }

  if (redoDir) await captureJournal(redoDir, safe, currentEntry)

  // The partition read the state at the start; another conversation may have written in
  // between. Each item is revalidated right before swapping — the entry inside the
  // index lock, the piece folder inside the piece lock — and what changed
  // in that interval stays as it is and counts as a conflict.
  const beforeApply = new Map<string, MediaEntry | null>()
  for (const record of safeMedia) beforeApply.set(record.id, await currentEntry(record.id))
  const afterById = new Map(safeMedia.map((r) => [r.id, r.after ?? null]))
  const lateEntries = await restoreMediaEntries(
    safeMedia.map((r) => ({ id: r.id, before: r.before })),
    (id, current) => sameAssetState(current, afterById.get(id) ?? null),
  )
  const media = safeMedia.filter((r) => !lateEntries.has(r.id))
  const stillSafe = async (record: Extract<RestoreRecord, { type: 'path' }>): Promise<boolean> =>
    !record.after || samePathState(await hashPath(record.path), record.after)

  let late = lateEntries.size
  const pieces = new Map<string, PieceRef>()
  const plain: RestoreRecord[] = []
  for (const record of safe) {
    if (record.type !== 'path') continue
    // The files of an entry that lost the race stay with it.
    if (record.owner && lateEntries.has(record.owner)) continue
    if (record.piece) {
      // The folder of the piece is swapped under the SAME lock as the tools that write it.
      const skipped = await withAssetLock(`${record.piece.kind}:${record.piece.folder}`, () =>
        restorePaths([record], stillSafe),
      )
      if (skipped.length > 0) late += 1
      else pieces.set(pieceKey(record.piece), record.piece)
    } else {
      plain.push(record)
    }
  }
  late += (await restorePaths(plain, stillSafe)).length

  // The video player has its own registry (videos.json): it comes back with the same id
  // the entry stores, or goes away with the file that no longer exists.
  let items = 0
  for (const record of media) {
    const now = beforeApply.get(record.id) ?? null
    const ref = record.before ?? now
    if (!ref) continue
    const kind = mediaKind(ref)
    if (!PIECE_KINDS.includes(kind as PieceKind)) items += 1
    if (kind !== 'video') continue
    if (record.before?.videoUrl) {
      await restoreVideoRegistration(record.before.videoUrl, record.before.path, record.before.sessionId)
    } else if (!record.before && now) {
      await unregisterVideosFor(now.path)
    }
  }

  await reconcilePieces([...pieces.values()])
  if (redoDir) await finalizeJournal(redoDir, currentEntry)

  const conflictLabels = part.conflictLabels.slice(0, 12)
  return {
    restored: true,
    pieces: pieces.size,
    items,
    conflicts: conflictCount(records, part) + late,
    ...(conflictLabels.length > 0 ? { conflictLabels } : {}),
  }
}

/**
 * Revert of the media of the discarded turns (`assistantIds`, in order). Returns the
 * summary for the revert bar, or `undefined` when none of them touched
 * media. Never throws: the failure becomes `restored: false`.
 */
export async function revertMedia(
  sessionId: string,
  assistantIds: string[],
): Promise<SessionMediaRevert | undefined> {
  try {
    const journals: LoadedJournal[] = []
    for (const id of assistantIds) {
      const journal = await readMediaJournal(sessionId, id)
      if (journal && journal.records.length > 0) journals.push(journal)
    }
    if (journals.length === 0) {
      await deleteRedoJournal(sessionId)
      return undefined
    }
    return await applyJournal(
      mergeJournals(journals),
      path.join(sessionJournalDir(sessionId), REDO_DIR),
    )
  } catch (err) {
    console.error('[media-revert] revert failed:', err)
    return {
      restored: false,
      pieces: 0,
      items: 0,
      conflicts: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Unrevert: puts back what the last revert undid, with the same conflict rule. */
export async function unrevertMedia(sessionId: string): Promise<SessionMediaRevert | undefined> {
  const redo = await readRedoJournal(sessionId).catch(() => null)
  if (!redo) return undefined
  try {
    const summary = await applyJournal(mergeJournals([redo]))
    await deleteRedoJournal(sessionId)
    return summary
  } catch (err) {
    console.error('[media-revert] unrevert failed:', err)
    return {
      restored: false,
      pieces: 0,
      items: 0,
      conflicts: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * The revert has become definitive (new message sent): the discarded turns do not
 * come back anymore, so their journals and the redo stop being useful.
 */
export async function discardMediaRevert(sessionId: string, discardedAssistantIds: string[]): Promise<void> {
  await deleteRedoJournal(sessionId).catch(() => {})
  await deleteMediaJournals(sessionId, discardedAssistantIds).catch(() => {})
}
