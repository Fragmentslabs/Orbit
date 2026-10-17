import path from 'node:path'
import { assetUrl, mediaKind, thumbUrl, type MaterialView, type MediaEntry } from '@shared/media'
import { audioExt, isAudioFile, saveAudio } from './audio-store'
import { isVideoFile, saveVideoAttachment, videoAttachmentExt } from './attachment-ref'
import { deleteMedia, getMediaEntry, listMedia, mediaIdFromUrl, saveMedia, updateMediaEntry } from './media'
import { DRAFT_SCOPE, documentFolderId } from './session-documents'
import { t } from './i18n'
import { addVideoToGallery } from './video/video-gallery'

/**
 * MATERIAIS da conversa: foto, GIF, áudio e vídeo na aba Fontes.
 *
 * Os documentos da aba (PDF, planilha…) têm um pipeline de extração, páginas e
 * busca — nada disso se aplica a um vídeo. O material é só um ARQUIVO que a
 * conversa tem à mão e que o agente alcança por REFERÊNCIA (`img_…`, `aud_…`,
 * `vdo_…`), quando decide usar. Por isso ele reaproveita o que já existe: o item
 * de mídia da galeria, com um escopo — a conversa (`sessionId`) ou a pasta da
 * sidebar (`sharedFolderId`) — em vez de um segundo armazenamento.
 *
 * Três consequências desejadas dessa escolha:
 *  - o arquivo é UM: excluí-lo na galeria o tira da aba, e excluí-lo na aba o
 *    tira da galeria, liberando o espaço dos dois;
 *  - a referência nunca muda ao mover o material entre a conversa e a pasta
 *    (os documentos trocam `doc1` por `src1`, e precisam de um rastro para isso);
 *  - o que o usuário anexou numa MENSAGEM também aparece aqui, em "desta
 *    conversa", já que é o mesmo item.
 */

const MATERIAL_KINDS = new Set(['image', 'audio', 'video'])

/** Teto de uma foto/áudio que chega como bytes; o vídeo de arquivo vem por caminho. */
const MAX_IMAGE_BYTES = 40 * 1024 * 1024
const MAX_AUDIO_BYTES = 100 * 1024 * 1024
/** O maior vídeo que ainda se aceita COMO BYTES (colado, sem arquivo no disco). */
const MAX_PASTED_VIDEO_BYTES = 150 * 1024 * 1024

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i
const IMAGE_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export type MaterialKind = 'image' | 'audio' | 'video'

/** Que tipo de material é um arquivo, ou null quando não é um que a aba guarda. */
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

/** Um item de mídia → o que a aba mostra. */
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

/** O material é desta conversa (não compartilhado com a pasta)? */
function isOwn(entry: MediaEntry, scope: string): boolean {
  if (entry.sharedFolderId) return false
  return entry.sessionId === scope || (entry.linkedSessionIds ?? []).includes(scope)
}

/**
 * Os materiais que a conversa alcança, separados como os documentos: os da pasta
 * (compartilhados) e os dela. Só entra o que o USUÁRIO trouxe (`source: 'user'`) —
 * uma imagem que o agente gerou é saída, e fica na galeria.
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
  /** Bytes em base64 (foto, áudio, vídeo colado). */
  data?: string
  /** Caminho do arquivo no disco (vídeo escolhido ou arrastado): copiado no main. */
  path?: string
}

export type AddMaterialResult = { ok: true; material: MaterialView } | { ok: false; error: string }

/**
 * Traz um arquivo para a aba. `shared` só vale quando a conversa está numa pasta;
 * sem pasta, não há escopo maior e o material fica na conversa.
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
        // O caminho vem do renderer: só vale para um arquivo de vídeo de verdade.
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
 * Move um material entre a conversa e a pasta. A referência NÃO muda — é o mesmo
 * arquivo, só o escopo troca —, então nada que já foi dito na conversa deixa de
 * apontar para ele.
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
    // Volta para ESTA conversa: ela é a que pediu, e o material não fica órfão.
    await updateMediaEntry(id, { sharedFolderId: undefined, sessionId: scope })
  }
  return { ok: true }
}

/** O chat novo ganhou sessão: o que foi trazido no rascunho passa a ser dela. */
export async function adoptDraftMaterials(sessionId: string): Promise<number> {
  if (sessionId === DRAFT_SCOPE) return 0
  const draft = (await listMedia({ sessionId: DRAFT_SCOPE })).filter((e) => MATERIAL_KINDS.has(mediaKind(e)))
  for (const entry of draft) await updateMediaEntry(entry.id, { sessionId })
  return draft.length
}

/** Uma linha por material para o agente: referência, tipo, nome e o que importa dele. */
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
