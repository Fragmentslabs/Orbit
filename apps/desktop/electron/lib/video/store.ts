import { app, protocol } from 'electron'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { VIDEO_SCHEME } from '@shared/media'

/**
 * Registro dos vídeos mostrados no chat. Diferente do áudio, o arquivo NÃO é
 * copiado para a pasta do app: um corte de 2 GB dobraria no disco. O registro
 * só guarda id → caminho, e o `orbit-video://` serve o arquivo do projeto
 * com Range (por stream, nunca lido inteiro na memória).
 *
 * Só o que o agente mostrou entra aqui — o scheme não abre caminho arbitrário.
 * Se o usuário apagar ou mover o arquivo, o player mostra o erro do <video>.
 */

const SAFE_VIDEO_ID = /^vid_[a-z0-9]+$/

interface VideoEntry {
  path: string
  sessionId?: string
  createdAt: number
}

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
}

function indexFile(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'videos.json')
}

let index: Record<string, VideoEntry> | null = null

async function load(): Promise<Record<string, VideoEntry>> {
  if (index) return index
  try {
    index = JSON.parse(await fsp.readFile(indexFile(), 'utf8')) as Record<string, VideoEntry>
  } catch {
    index = {}
  }
  return index
}

let writing: Promise<void> = Promise.resolve()
function persist(): Promise<void> {
  writing = writing.then(async () => {
    const file = indexFile()
    await fsp.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(index ?? {}))
    await fsp.rename(tmp, file)
  })
  return writing
}

/** Registra (ou reaproveita) um vídeo do disco e devolve a URL do player. */
export async function registerVideo(file: string, sessionId?: string): Promise<{ id: string; url: string }> {
  const entries = await load()
  const resolved = path.resolve(file)
  const existing = Object.entries(entries).find(([, e]) => e.path === resolved && e.sessionId === sessionId)
  const id = existing?.[0] ?? `vid_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`
  if (!existing) {
    entries[id] = { path: resolved, sessionId, createdAt: Date.now() }
    await persist()
  }
  return { id, url: `${VIDEO_SCHEME}://${id}` }
}

/**
 * Tira do registro do player todo vídeo que aponta para este arquivo. Chamado
 * quando o arquivo é apagado (galeria): sem isso o índice guardaria para sempre
 * um caminho morto, e o `orbit-video://` responderia "moved or deleted".
 */
export async function unregisterVideosFor(file: string): Promise<void> {
  const entries = await load()
  const resolved = path.resolve(file)
  let changed = false
  for (const [id, entry] of Object.entries(entries)) {
    if (entry.path === resolved) {
      delete entries[id]
      changed = true
    }
  }
  if (changed) await persist()
}

/** O <video> busca posição e lê a duração por Range — sem isso não há barra. */
export function registerVideoProtocol(): void {
  protocol.handle(VIDEO_SCHEME, async (request) => {
    const id = new URL(request.url).host
    if (!SAFE_VIDEO_ID.test(id)) return new Response('not found', { status: 404 })
    const entry = (await load())[id]
    if (!entry) return new Response('not found', { status: 404 })
    let size: number
    try {
      size = (await fsp.stat(entry.path)).size
    } catch {
      return new Response('file moved or deleted', { status: 404 })
    }
    const type = CONTENT_TYPES[path.extname(entry.path).toLowerCase()] ?? 'application/octet-stream'
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '')
    const stream = (start: number, end: number) =>
      Readable.toWeb(fs.createReadStream(entry.path, { start, end })) as unknown as ReadableStream
    if (range) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2] || 0))
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
      if (start >= size || start > end) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
      }
      return new Response(stream(start, end), {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
        },
      })
    }
    return new Response(stream(0, Math.max(0, size - 1)), {
      headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' },
    })
  })
}
