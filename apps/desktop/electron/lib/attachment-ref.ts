import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { audioFilePath, audioIdFrom } from './audio-store'
import { getMediaEntry, mediaIdFromUrl } from './media'

/**
 * ANEXOS do chat que o agente usa como material de trabalho: o vídeo que o
 * usuário mandou, a foto, o áudio, o GIF.
 *
 * O princípio é o que o áudio já seguia: o agente recebe só uma REFERÊNCIA e uns
 * poucos metadados (nome, duração, tamanho), nunca o conteúdo. O conteúdo entra
 * no contexto quando ele decide ler — transcrever, olhar um instante, descrever —
 * e vai para uma peça quando ele decide usar (motion_asset). Um vídeo de 30
 * minutos custa uma linha no contexto, não a transcrição dele.
 *
 * Três famílias, três prefixos, todos gerados aqui (então confiáveis):
 *   - `vdo_…`  vídeo anexado (guardado nesta pasta);
 *   - `aud_…`  áudio (audio-store.ts);
 *   - `img_…`  imagem ou GIF (media.ts).
 * `resolveAttachmentRef` é a ÚNICA porta de volta: a referência vira um arquivo
 * do próprio app, e nada que o agente escreva abre caminho arbitrário — é o que
 * mantém `motion_asset` e as tools de leitura presas aos anexos da conversa.
 */

const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi'] as const
const VIDEO_EXT = new RegExp(`\\.(${VIDEO_EXTENSIONS.join('|')})$`, 'i')
export const SAFE_VIDEO_ATTACHMENT = new RegExp(`^vdo_[a-z0-9]+\\.(${VIDEO_EXTENSIONS.join('|')})$`)

/** Acima disto um vídeo anexado não é copiado: o agente é avisado, não o disco. */
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

/** O anexo é um vídeo? Pelo MIME, ou pela extensão quando o MIME vem vazio. */
export function isVideoFile(mime: string, filename = ''): boolean {
  return mime.startsWith('video/') || VIDEO_EXT.test(filename)
}

/** Extensão para guardar um vídeo (`null` = formato que não guardamos). */
export function videoAttachmentExt(mime: string, filename = ''): string | null {
  const fromMime = MIME_EXT[mime.split(';')[0].trim().toLowerCase()]
  if (fromMime) return fromMime
  const match = VIDEO_EXT.exec(filename)
  return match ? match[1].toLowerCase() : null
}

/**
 * O caminho de disco de um anexo que o renderer mandou como `file://…` (um vídeo
 * escolhido ou arrastado). O caminho vem do renderer, então só vale se a extensão
 * REAL for de vídeo: o nome declarado no anexo não pode servir de desculpa para
 * copiar qualquer arquivo. `null` quando não é um file:// utilizável.
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
 * Guarda o vídeo anexado. Os bytes vêm da mensagem (colar da área de
 * transferência) ou de um ARQUIVO no disco (arrastar/escolher): o segundo caso
 * é uma cópia por clone quando o sistema de arquivos suporta (APFS, btrfs), que
 * custa zero espaço e zero memória; sem clone, uma cópia comum. Em nenhum dos
 * dois o vídeo passa inteiro pela memória do renderer.
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

// ------------------------------------------------------------------ nomes
// O nome original do arquivo é só para o agente e para a mensagem de erro: o id
// é o que manda. Fica num índice pequeno ao lado dos vídeos.

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

// ------------------------------------------------------------ referências

export type AttachmentKind = 'video' | 'audio' | 'image'

export interface ResolvedAttachment {
  kind: AttachmentKind
  id: string
  /** Arquivo do app (absoluto). */
  file: string
  /** Nome para mostrar e para dar ao arquivo dentro de uma peça. */
  name: string
}

/** A string parece uma referência de anexo (e não um caminho do projeto)? */
export function looksLikeAttachmentRef(ref: string): boolean {
  return /^(?:ref\s+)?(?:orbit-(?:audio|media):\/\/)?(?:vdo|aud|img)_[a-z0-9]/i.test(ref.trim())
}

/**
 * A referência que o agente passou → o anexo. Aceita o id, a URL do scheme ou o
 * caminho que a nota do anexo entrega; recusa tudo o mais (inclusive um caminho
 * de dentro do app que não seja o de um anexo).
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
    return { kind: 'image', id: imageId, file: entry.path, name: entry.name || imageId }
  }
  return null
}
