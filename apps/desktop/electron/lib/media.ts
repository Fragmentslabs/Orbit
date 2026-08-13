import { app, net, protocol } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { StorageKeys, type ChatMessage } from '@shared/chat'
import type { MediaEntry, MediaFilter, MediaSource, MediaUsage } from '@shared/media'
import { listKeys, readJson } from './storage'

export type { MediaEntry, MediaFilter, MediaSource, MediaUsage }

/**
 * Mídia das respostas do assistente (tool show_image), dos screenshots e dos
 * scripts de browser: PNGs/JPGs/WebPs salvos em orbit-data/media e servidos ao
 * renderer pelo protocolo orbit-media:// — as mensagens persistem só a URL,
 * nunca base64.
 *
 * Cada arquivo também ganha um registro em media/index.json (quem criou, em
 * qual sessão/mensagem, quando, dimensões). O índice é o que alimenta a
 * galeria e o rastreio de espaço; o DIRETÓRIO é a fonte da verdade — se o
 * índice sumir ou corromper, ele é reconstruído a partir do disco.
 */

const SCHEME = 'orbit-media'
const SAFE_ID = /^[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp|gif)$/
const INDEX_FILE = 'index.json'

export interface SaveMediaMeta {
  source: MediaSource
  sessionId?: string
  messageId?: string
  taskId?: string
  name?: string
}

function mediaDir(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'media')
}

function indexFile(): string {
  return path.join(mediaDir(), INDEX_FILE)
}

/**
 * Mutex de escrita do índice: toda mutação entra numa fila serial. Sem isso,
 * duas capturas simultâneas (batch + show_image) leriam a mesma versão do
 * index.json e uma sobrescreveria a outra.
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
    // Ausente ou corrompido: o disco é a fonte da verdade
    return []
  }
}

async function writeIndex(entries: MediaEntry[]): Promise<void> {
  await fsp.mkdir(mediaDir(), { recursive: true })
  const tmp = `${indexFile()}.${Date.now()}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(entries, null, 2), 'utf8')
  await fsp.rename(tmp, indexFile())
}

/** Dimensões da imagem — falha silenciosa (o registro vale mesmo sem elas). */
async function dimensions(buffer: Buffer): Promise<{ width?: number; height?: number }> {
  try {
    const meta = await sharp(buffer).metadata()
    return { width: meta.width, height: meta.height }
  } catch {
    return {}
  }
}

/**
 * Salva o buffer e retorna a URL orbit-media:// para usar na ImagePart.
 * `meta` registra a origem no índice — sem ela a imagem entra como 'chat'
 * (compatibilidade com chamadores antigos).
 */
export async function saveMedia(buffer: Buffer, ext: string, meta?: SaveMediaMeta): Promise<string> {
  const id = `img_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.${ext}`
  if (!SAFE_ID.test(id)) throw new Error(`extensão de imagem inválida: ${ext}`)
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
    sessionId: meta?.sessionId,
    messageId: meta?.messageId,
    taskId: meta?.taskId,
    name: meta?.name,
    width,
    height,
  }
  await withIndexLock(async () => {
    const entries = await readIndex()
    entries.push(entry)
    await writeIndex(entries)
  })
  return `${SCHEME}://${id}`
}

/** Extrai o id de uma URL orbit-media:// (ou devolve a entrada se já for um id). */
export function mediaIdFromUrl(url: string): string | null {
  const id = url.startsWith(`${SCHEME}://`) ? url.slice(`${SCHEME}://`.length).replace(/\/+$/, '') : url
  return SAFE_ID.test(id) ? id : null
}

/**
 * Vincula uma imagem já salva à mensagem onde ela apareceu. O show_image não
 * conhece o id da mensagem (a tool roda no meio do turno) — o chat-engine
 * completa o registro quando materializa a ImagePart.
 */
export async function attachMediaMessage(url: string, messageId: string, sessionId?: string): Promise<void> {
  const id = mediaIdFromUrl(url)
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
  if (filter.sessionId && entry.sessionId !== filter.sessionId) return false
  if (filter.since != null && entry.createdAt < filter.since) return false
  if (filter.query) {
    const needle = filter.query.toLowerCase()
    const haystack = `${entry.name ?? ''} ${entry.taskId ?? ''} ${entry.id}`.toLowerCase()
    if (!haystack.includes(needle)) return false
  }
  return true
}

/** Lista o registry (mais recentes primeiro), opcionalmente filtrado. */
export async function listMedia(filter?: MediaFilter): Promise<MediaEntry[]> {
  const entries = await readIndex()
  const filtered = filter ? entries.filter((e) => matches(e, filter)) : entries
  return filtered.sort((a, b) => b.createdAt - a.createdAt)
}

export async function getMediaEntry(id: string): Promise<MediaEntry | null> {
  const entries = await readIndex()
  return entries.find((e) => e.id === id) ?? null
}

/** Remove arquivo + registro. Retorna false quando o id é inválido. */
export async function deleteMedia(id: string): Promise<boolean> {
  if (!SAFE_ID.test(id)) return false
  await fsp.rm(path.join(mediaDir(), id), { force: true })
  await withIndexLock(async () => {
    const entries = await readIndex()
    const next = entries.filter((e) => e.id !== id)
    if (next.length !== entries.length) await writeIndex(next)
  })
  return true
}

/** Remove várias imagens de uma vez (seleção em lote na galeria). */
export async function deleteManyMedia(ids: string[]): Promise<number> {
  let removed = 0
  for (const id of ids) {
    if (await deleteMedia(id)) removed += 1
  }
  return removed
}

/**
 * Limpeza rápida: apaga as imagens geradas por scripts/lotes (source
 * 'script'/'batch') que NÃO foram mostradas em nenhuma mensagem — o material
 * intermediário das automações, que costuma dominar o disco.
 */
export async function cleanupScriptMedia(): Promise<number> {
  const entries = await readIndex()
  const disposable = entries.filter(
    (e) => (e.source === 'script' || e.source === 'batch') && !e.messageId,
  )
  return deleteManyMedia(disposable.map((e) => e.id))
}

/** Uso de disco da pasta media (arquivos reais, não o índice). */
export async function mediaDiskUsage(): Promise<MediaUsage> {
  let count = 0
  let bytes = 0
  try {
    for (const name of await fsp.readdir(mediaDir())) {
      if (!SAFE_ID.test(name)) continue
      try {
        const stat = await fsp.stat(path.join(mediaDir(), name))
        count += 1
        bytes += stat.size
      } catch {
        // arquivo removido no meio da varredura
      }
    }
  } catch {
    // pasta ainda não existe
  }
  return { count, bytes }
}

/**
 * Índice das imagens presentes no disco mas ausentes do registry (mídia
 * anterior ao registry, ou salva enquanto o índice estava corrompido). Varre
 * as mensagens das sessões para descobrir de qual chat/mensagem cada arquivo
 * veio; o que não aparecer em nenhuma mensagem entra como 'chat' órfã.
 *
 * Roda uma vez, na primeira abertura da galeria — barato e idempotente.
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

    // id da imagem → { sessionId, messageId } a partir das ImageParts persistidas
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
        // arquivo ilegível — registra sem dimensões
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
