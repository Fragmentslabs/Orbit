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
 * Aplica o diário de mídia (media-journal.ts) no revert e no unrevert da
 * mensagem. Vale nos DOIS modos: as peças e a galeria moram no armazenamento
 * do app, não na pasta de trabalho — o snapshot do modo código não as alcança.
 *
 * Revert: junta os diários dos turnos descartados e, para CADA caminho/entrada,
 * compara o estado atual com o estado FINAL que o turno deixou. Só desfaz o
 * que ainda está como o turno deixou; o que mudou depois (outra conversa,
 * edição no painel, arquivo mexido por fora) fica intacto e é reportado como
 * conflito. Guarda o estado atual como redo (com o estado pós-revert) e
 * reconcilia o que aponta para os caminhos (registro das peças, watcher, capa,
 * player de vídeo, abas).
 *
 * Unrevert: aplica o redo com a MESMA regra — se algo mudou entre o revert e
 * o unrevert, aquele item é preservado e vira conflito.
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

/** Id da peça numa entrada da galeria (capa), ou null num ativo comum. */
function entryPieceId(entry: MediaEntry | null | undefined): string | null {
  if (!entry) return null
  return entry.motionId ?? entry.designId ?? entry.slidesId ?? null
}

/**
 * Uma entrada da galeria é a CAPA de uma peça cuja pasta é um registro
 * separado. Se a pasta foi preservada (edição à mão depois do turno), a capa
 * também não pode sumir — senão a peça fica no disco sem tile na galeria.
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
 * Campos que dizem o que um ativo É. Capa (`thumb`/`thumbDark`), `url`,
 * `messageId` e `linkedSessionIds` ficam de fora: são cosméticos/bookkeeping e
 * mudam em segundo plano (a capa da peça é refeita depois do turno) — comparar
 * por eles faria todo revert de peça virar conflito falso.
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

/** Mesma identidade e mesmo estado de conteúdo — não o mesmo objeto. */
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
 * Decide, registro por registro, o que pode ser desfeito.
 *
 * Entrada da galeria: `after` é o que o turno gravou; se o atual bate, é
 * seguro; se bate com o `before`, já está desfeito; senão é conflito.
 * Arquivo: o mesmo, com hash. Arquivo que pertence a uma entrada (artefato,
 * documento) NÃO é julgado sozinho — quem manda é a entrada; a capa pode ser
 * regerada em segundo plano sem ser edição.
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
   * O arquivo PRINCIPAL de cada entrada (o HTML do artefato, o .md do
   * documento). A revisão sozinha não basta: depois de um revert a revisão
   * volta, e uma escrita externa seguinte pode reusar o mesmo número com outro
   * conteúdo. O hash do arquivo é a prova que a revisão não dá.
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
      // Sem estado final do arquivo (diário antigo/crash), não há como provar.
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
      // Diário antigo/crashado: sem estado final não há como provar que o
      // turno ainda é o dono do estado atual.
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
    // Arquivo de uma entrada conhecida: a entrada decide.
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
      console.error(`[media-revert] reconciliar ${piece.kind} ${piece.id} falhou:`, err)
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
    // Arquivo de uma entrada conflitante já contado pela entrada.
    else if (record.owner && mediaIds.has(record.owner)) continue
    // Pasta de peça conflitante já contada pela capa (mesma peça).
    else if (record.piece && pieceIds.has(record.piece.id)) continue
    else count += 1
  }
  return count
}

/**
 * Aplica um conjunto de registros com a regra de conflito.
 *
 * `redoDir` (só no revert): antes de aplicar, guarda o estado atual dos itens
 * seguros — é o que o unrevert devolve. Depois de aplicar, grava o estado
 * final (o que o unrevert vai exigir encontrar para poder desfazer).
 */
async function applyJournal(records: RestoreRecord[], redoDir?: string): Promise<SessionMediaRevert> {
  const part = await partition(records)
  propagatePieceConflicts(part)
  const safe = [...part.safe]
  const safeMedia = part.safe.filter(
    (r): r is Extract<RestoreRecord, { type: 'media' }> => r.type === 'media',
  )

  // Arquivos que a entrada segura tem AGORA e não tinha antes (capa nova,
  // render novo de documento, artefato criado no turno): saem junto com ela.
  // Os que já estavam antes são restaurados pelos próprios registros.
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
        // O estado atual é o que o turno deixou (a entrada é segura); o
        // registro só precisa existir para o redo guardar os bytes.
        after: await hashPath(file),
      })
    }
  }

  if (redoDir) await captureJournal(redoDir, safe, currentEntry)

  // A partição leu o estado no começo; outra conversa pode ter gravado no
  // meio. Cada item é revalidado logo antes de trocar — a entrada dentro da
  // trava do índice, a pasta da peça dentro da trava da peça — e o que mudou
  // nesse intervalo fica como está e conta como conflito.
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
    // Os arquivos de uma entrada que perdeu a corrida ficam com ela.
    if (record.owner && lateEntries.has(record.owner)) continue
    if (record.piece) {
      // A pasta da peça troca sob o MESMO lock das tools que a escrevem.
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

  // O player do vídeo tem registro próprio (videos.json): volta com o mesmo id
  // que a entrada guarda, ou sai com o arquivo que deixou de existir.
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
 * Revert da mídia dos turnos descartados (`assistantIds`, em ordem). Devolve o
 * resumo para a barra de revert, ou `undefined` quando nenhum deles tocou em
 * mídia. Nunca lança: a falha vira `restored: false`.
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
    console.error('[media-revert] revert falhou:', err)
    return {
      restored: false,
      pieces: 0,
      items: 0,
      conflicts: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Unrevert: põe de volta o que o último revert desfez, com a mesma regra de conflito. */
export async function unrevertMedia(sessionId: string): Promise<SessionMediaRevert | undefined> {
  const redo = await readRedoJournal(sessionId).catch(() => null)
  if (!redo) return undefined
  try {
    const summary = await applyJournal(mergeJournals([redo]))
    await deleteRedoJournal(sessionId)
    return summary
  } catch (err) {
    console.error('[media-revert] unrevert falhou:', err)
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
 * O revert virou definitivo (nova mensagem enviada): os turnos descartados não
 * voltam mais, então os diários deles e o redo deixam de servir.
 */
export async function discardMediaRevert(sessionId: string, discardedAssistantIds: string[]): Promise<void> {
  await deleteRedoJournal(sessionId).catch(() => {})
  await deleteMediaJournals(sessionId, discardedAssistantIds).catch(() => {})
}
