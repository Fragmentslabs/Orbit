import { app, net, protocol } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Mídia das respostas do assistente (tool show_image): PNGs/JPGs salvos em
 * orbit-data/media e servidos ao renderer pelo protocolo orbit-media:// —
 * as mensagens persistem só a URL, nunca base64.
 */

const SCHEME = 'orbit-media'
const SAFE_ID = /^[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp|gif)$/

function mediaDir(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'media')
}

/** Salva o buffer e retorna a URL orbit-media:// para usar na ImagePart. */
export async function saveMedia(buffer: Buffer, ext: string): Promise<string> {
  const id = `img_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.${ext}`
  if (!SAFE_ID.test(id)) throw new Error(`extensão de imagem inválida: ${ext}`)
  await fsp.mkdir(mediaDir(), { recursive: true })
  await fsp.writeFile(path.join(mediaDir(), id), buffer)
  return `${SCHEME}://${id}`
}

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

/** Lê um arquivo de mídia persistido — usado pelo servidor HTTP do companion
 *  (que não tem acesso ao protocolo orbit-media:// do Electron). Valida o id
 *  com SAFE_ID (nada de path traversal). */
export async function readMedia(id: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  if (!SAFE_ID.test(id)) return null
  try {
    const buffer = await fsp.readFile(path.join(mediaDir(), id))
    const ext = id.split('.').pop() ?? ''
    return { buffer, contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream' }
  } catch {
    return null
  }
}

/** Registra o protocolo (chamar após app.whenReady). */
export function registerMediaProtocol(): void {
  protocol.handle(SCHEME, (request) => {
    // request.url = orbit-media://img_x.png (host carrega o id em schemes não-standard)
    const id = request.url.slice(`${SCHEME}://`.length).replace(/\/+$/, '')
    if (!SAFE_ID.test(id)) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(path.join(mediaDir(), id)).toString())
  })
}
