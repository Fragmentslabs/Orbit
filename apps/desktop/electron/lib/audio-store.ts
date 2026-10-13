import { app, protocol } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { AUDIO_SCHEME } from '@shared/media'
import type { MediaSource } from '@shared/media'
import { SAFE_AUDIO_ID, audioMediaId, getMediaEntry, registerAudioMedia } from './media'

export { AUDIO_SCHEME }

/**
 * Áudios das conversas: os anexados pelo usuário e os que o agente gera
 * (tool audio_generate). Entram no ACERVO de mídia do chat (kind "audio" no
 * índice de media.ts — galeria, "Neste chat", uso de disco, excluir), mas o
 * arquivo mora numa pasta própria: a reconstrução do índice varre media/ e
 * registraria tudo lá como imagem.
 *
 * Servidos por `orbit-audio://`, um scheme com o privilégio `stream` (sem ele
 * o <audio> do Chromium não toca, nem busca posição) — registrado junto com o
 * dos artefatos, antes de o app ficar pronto (ver registerArtifactSchemePrivileges).
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

/** MIME de áudio → extensão aceita aqui (o resto cai na extensão do nome). */
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

function audioDir(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'audio')
}

/** Caminho do arquivo de um áudio guardado — é o que o agente recebe pelo anexo. */
export function audioFilePath(id: string): string {
  return path.join(audioDir(), id)
}

/** O anexo é um áudio? Pelo MIME, ou pela extensão quando o MIME vem vazio. */
export function isAudioFile(mime: string, filename = ''): boolean {
  return mime.startsWith('audio/') || AUDIO_EXT.test(filename)
}

/** Extensão para gravar um áudio de MIME/nome dados (`null` = formato que não servimos). */
export function audioExt(mime: string, filename = ''): string | null {
  const fromMime = MIME_EXT[mime.split(';')[0].trim().toLowerCase()]
  if (fromMime) return fromMime
  const match = AUDIO_EXT.exec(filename)
  return match ? match[1].toLowerCase() : null
}

/** Grava o áudio, registra no acervo do chat e devolve o id e a URL orbit-audio://. */
export async function saveAudio(
  buffer: Buffer,
  ext: string,
  meta: { sessionId?: string; messageId?: string; name?: string; source: MediaSource },
): Promise<{ id: string; url: string; path: string }> {
  const id = `aud_${Date.now().toString(36)}${randomBytes(4).toString('hex')}.${ext.toLowerCase()}`
  if (!SAFE_AUDIO_ID.test(id)) throw new Error(`formato de áudio não suportado: ${ext}`)
  await fs.mkdir(audioDir(), { recursive: true })
  const file = audioFilePath(id)
  await fs.writeFile(file, buffer)
  await registerAudioMedia({ id, path: file, size: buffer.length, ...meta })
  return { id, url: `${AUDIO_SCHEME}://${id}`, path: file }
}

/**
 * Id de um áudio guardado a partir do que o agente passar: o id cru, a URL
 * orbit-audio:// ou o CAMINHO do arquivo na pasta de áudio (o que a nota do
 * anexo entrega).
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

/** Bytes e nome de um áudio guardado (`null` se não existe). */
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
 * Serve orbit-audio://<id> com suporte a Range: o <audio> pede pedaços para
 * buscar uma posição e para saber a duração de formatos sem cabeçalho.
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
