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
  mergeJournals,
  readMediaJournal,
  readRedoJournal,
  restorePaths,
  sessionJournalDir,
  type LoadedJournal,
  type PieceKind,
  type PieceRef,
  type RestoreRecord,
} from './media-journal'

/**
 * Aplica o diário de mídia (media-journal.ts) no revert e no unrevert da
 * mensagem. Vale nos DOIS modos: as peças e a galeria moram no armazenamento
 * do app, não na pasta de trabalho — o snapshot do modo código não as alcança.
 *
 * Revert: junta os diários dos turnos descartados, guarda o estado atual como
 * redo, devolve caminhos e entradas ao estado de antes e reconcilia o que
 * aponta para eles (registro das peças, watcher, capa, player de vídeo, abas).
 * Unrevert: aplica o redo do mesmo jeito.
 */

const PIECE_KINDS: PieceKind[] = ['motion', 'design', 'slides']

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Uma entrada criada (ou que ganhou arquivos) no turno: os arquivos que ela tem
 * agora e não tinha antes saem do disco junto com ela. Vira registro de caminho
 * "não existia" — e, por isso, entra também no redo.
 */
async function withOrphanFiles(records: RestoreRecord[]): Promise<RestoreRecord[]> {
  const out = [...records]
  const paths = () => out.flatMap((r) => (r.type === 'path' ? [r.path] : []))
  for (const record of records) {
    if (record.type !== 'media') continue
    const current = await getMediaEntry(record.id)
    if (!current) continue
    const before = new Set(record.before ? await entryOwnedFiles(record.before) : [])
    for (const file of await entryOwnedFiles(current)) {
      if (before.has(file) || paths().some((p) => isInside(p, file))) continue
      out.push({ type: 'path', path: file, backupFile: null })
    }
  }
  return out
}

function pieceKey(piece: PieceRef): string {
  return `${piece.kind}:${piece.id}`
}

async function inGallery(kind: PieceKind, id: string): Promise<boolean> {
  const items = await listMedia({ kind }).catch(() => [] as MediaEntry[])
  return items.some((item) => (kind === 'motion' ? item.motionId : kind === 'design' ? item.designId : item.slidesId) === id)
}

/**
 * Depois de a pasta voltar (ou sumir): a peça que existe volta ao registro com
 * o watcher religado e a capa refeita; a que não existe mais sai do registro e
 * tem as abas fechadas.
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
        if (await inGallery('motion', piece.id)) void registerMotionCover(piece.id, { sessionId: piece.sessionId }).catch(() => false)
      } else if (piece.kind === 'design') {
        await registerDesign(piece.folder, opts)
        await rewatchDesign(piece.id)
        if (await inGallery('design', piece.id)) refreshDesignCover(piece.id, { sessionId: piece.sessionId })
      } else {
        await registerSlides(piece.folder, { ...opts, entry: piece.entry })
        await rewatchSlides(piece.id)
        if (await inGallery('slides', piece.id)) {
          void registerSlidesCover(piece.id, { title: path.basename(piece.folder), sessionId: piece.sessionId }).catch(() => false)
        }
      }
    } catch (err) {
      console.error(`[media-revert] reconciliar ${piece.kind} ${piece.id} falhou:`, err)
    }
  }
  panelPiecesRemoved(removed)
}

/** Aplica registros já capturados: caminhos, galeria, player de vídeo, peças. */
async function applyRecords(records: RestoreRecord[]): Promise<SessionMediaRevert> {
  const pieces = new Map<string, PieceRef>()
  const plain: RestoreRecord[] = []
  for (const record of records) {
    if (record.type === 'path' && record.piece) {
      pieces.set(pieceKey(record.piece), record.piece)
      // A pasta da peça troca sob o MESMO lock das tools que a escrevem.
      await withAssetLock(`${record.piece.kind}:${record.piece.folder}`, () => restorePaths([record]))
    } else if (record.type === 'path') {
      plain.push(record)
    }
  }
  await restorePaths(plain)

  const media = records.filter((r): r is Extract<RestoreRecord, { type: 'media' }> => r.type === 'media')
  const current = new Map<string, MediaEntry | null>()
  for (const record of media) current.set(record.id, await getMediaEntry(record.id))
  await restoreMediaEntries(media.map((r) => ({ id: r.id, before: r.before })))

  // O player do vídeo tem registro próprio (videos.json): volta com o mesmo id
  // que a entrada guarda, ou sai com o arquivo que deixou de existir.
  let items = 0
  for (const record of media) {
    const now = current.get(record.id) ?? null
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
  return { restored: true, pieces: pieces.size, items }
}

/**
 * Revert da mídia dos turnos descartados (`assistantIds`, em ordem). Devolve o
 * resumo para a barra de revert, ou `undefined` quando nenhum deles tocou em
 * mídia. Nunca lança: a falha vira `restored: false`.
 */
export async function revertMedia(sessionId: string, assistantIds: string[]): Promise<SessionMediaRevert | undefined> {
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
    const records = await withOrphanFiles(mergeJournals(journals))
    await captureJournal(path.join(sessionJournalDir(sessionId), REDO_DIR), records, getMediaEntry)
    return await applyRecords(records)
  } catch (err) {
    console.error('[media-revert] revert falhou:', err)
    return { restored: false, pieces: 0, items: 0, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Unrevert: põe de volta o que o último revert desfez, e descarta o redo. */
export async function unrevertMedia(sessionId: string): Promise<void> {
  const redo = await readRedoJournal(sessionId).catch(() => null)
  if (!redo) return
  try {
    await applyRecords(mergeJournals([redo]))
  } catch (err) {
    console.error('[media-revert] unrevert falhou:', err)
  }
  await deleteRedoJournal(sessionId)
}

/**
 * O revert virou definitivo (nova mensagem enviada): os turnos descartados não
 * voltam mais, então os diários deles e o redo deixam de servir.
 */
export async function discardMediaRevert(sessionId: string, discardedAssistantIds: string[]): Promise<void> {
  await deleteRedoJournal(sessionId).catch(() => {})
  await deleteMediaJournals(sessionId, discardedAssistantIds).catch(() => {})
}
