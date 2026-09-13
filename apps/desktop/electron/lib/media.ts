import { app, BrowserWindow, net, protocol, session } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { StorageKeys, type ChatMessage } from '@shared/chat'
import {
  ARTIFACT_SCHEME,
  MEDIA_SCHEME,
  mediaKind,
  type MediaEntry,
  type MediaFilter,
  type MediaKind,
  type MediaSource,
  type MediaUsage,
  type DocumentFormat,
} from '@shared/media'
import { listKeys, readJson } from './storage'
import { buildDocx } from './docx-package'
import { parseMarkdown, renderHtml } from './document-render'

export type { MediaEntry, MediaFilter, MediaSource, MediaUsage }

/**
 * Registry dos ativos que o agente produz.
 *
 * Imagens (tool show_image, screenshots, scripts de browser) são PNGs/JPGs/
 * WebPs em orbit-data/media, servidos pelo protocolo orbit-media://.
 * Artefatos (tool create_artifact) são páginas HTML em orbit-data/artifacts,
 * servidas pelo protocolo orbit-artifact://. Em ambos os casos as mensagens
 * persistem só a URL, nunca o conteúdo.
 *
 * O ÍNDICE é um só (media/index.json) e o arquivo nunca é duplicado: o
 * registro é um ponteiro — `path` absoluto + `kind` — e é isso que deixa a
 * galeria, o uso de disco e o "abrir no chat" valerem para os dois tipos sem
 * duas implementações. Por isso toda leitura/exclusão resolve pelo `path` da
 * ENTRADA, nunca remontando `mediaDir() + id`.
 *
 * O diretório continua sendo a fonte da verdade das imagens: se o índice
 * sumir ou corromper, `backfillMedia` o reconstrói a partir do disco.
 */

const SCHEME = MEDIA_SCHEME
const SAFE_ID = /^[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp|gif)$/
/**
 * Arquivos servidos pelo orbit-artifact://: a página do artefato (.html), a
 * miniatura capturada (.png) e, nos documentos, o fonte (.md) e as
 * renderizações (.pdf/.docx).
 */
const SAFE_ARTIFACT_ID = /^[a-zA-Z0-9_-]+\.(html|png|md|pdf|docx)$/
const INDEX_FILE = 'index.json'

/**
 * Diretório de um arquivo servido pelo scheme, decidido pelo PREFIXO do id
 * (`art_` / `doc_`) — os ids são gerados aqui, então o prefixo é confiável e
 * evita ter que consultar o índice a cada requisição do protocolo.
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
}

function mediaDir(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'media')
}

/** Artefatos moram fora de media/ para não colidirem com o backfill, que varre
 *  o diretório de imagens e registraria qualquer arquivo novo como imagem. */
function artifactsDir(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'artifacts')
}

/** Documentos: fonte .md, preview .html, renderizações .pdf/.docx e a
 *  miniatura .png, todos com o mesmo id-base. */
function documentsDir(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'documents')
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
    kind: 'image',
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
  if (filter.kind) {
    const kinds = Array.isArray(filter.kind) ? filter.kind : [filter.kind]
    if (!kinds.includes(mediaKind(entry))) return false
  }
  if (filter.sessionId && entry.sessionId !== filter.sessionId) return false
  // Escopo de projeto: é o que faz o agente reencontrar, no modo código, o
  // que ele produziu antes no MESMO repositório — em qualquer sessão.
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

/**
 * Remove arquivo + registro. Retorna false quando o id é inválido.
 *
 * O caminho sai da ENTRADA (imagens e artefatos vivem em pastas diferentes);
 * o `mediaDir() + id` só entra como fallback para registros órfãos — mídia em
 * disco que o índice perdeu. Num artefato, a miniatura vai junto.
 */
export async function deleteMedia(id: string): Promise<boolean> {
  const isImage = SAFE_ID.test(id)
  if (!isImage && !SAFE_ARTIFACT_ID.test(id)) return false

  const entry = await getMediaEntry(id)
  const file = entry?.path ?? (isImage ? path.join(mediaDir(), id) : null)
  if (!file) return false
  await fsp.rm(file, { force: true })
  if (entry?.thumb && SAFE_ARTIFACT_ID.test(entry.thumb)) {
    await fsp.rm(path.join(artifactsDir(), entry.thumb), { force: true })
  }

  await withIndexLock(async () => {
    const entries = await readIndex()
    const next = entries.filter((e) => e.id !== id)
    if (next.length !== entries.length) await writeIndex(next)
  })
  return true
}

/** Remove vários ativos de uma vez (seleção em lote na galeria). */
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

/**
 * Uso de disco dos ativos (arquivos reais, não o índice): imagens em media/ e
 * artefatos em artifacts/.
 *
 * `count` conta ATIVOS — as miniaturas dos artefatos somam bytes mas não
 * contam como item, senão cada artefato apareceria duas vezes no número que o
 * usuário lê na galeria.
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
          // arquivo removido no meio da varredura
        }
      }
    } catch {
      // pasta ainda não existe
    }
  }

  await scan(mediaDir(), SAFE_ID, () => true)
  await scan(artifactsDir(), SAFE_ARTIFACT_ID, (name) => name.endsWith('.html'))
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

// ─── Artefatos HTML ──────────────────────────────────────────────────────────

/**
 * Página renderizável produzida pelo agente (create_artifact): dashboard,
 * protótipo, diagrama, relatório. Mesma mecânica das imagens — arquivo em
 * disco, registro no índice, URL na mensagem — com duas diferenças:
 *
 * 1. Scheme próprio. `orbit-media://` não é privilegiado, e HTML sem origem
 *    não roda script nem carrega módulo. `orbit-artifact://` é registrado como
 *    standard+secure (ver registerArtifactSchemePrivileges, que PRECISA rodar
 *    antes do app ficar pronto).
 * 2. Miniatura. A galeria é um grid de <img>; o artefato ganha um PNG
 *    capturado numa janela oculta para caber nesse grid.
 *
 * O conteúdo é escrito pelo modelo, que pode ter lido a web no mesmo turno:
 * quem renderiza trata como não-confiável (iframe sandbox sem
 * allow-same-origin, partição isolada).
 */

/** Altura máxima capturada na miniatura — páginas longas viram tira inútil. */
const THUMB_VIEWPORT = { width: 1024, height: 768 }
const THUMB_WIDTH = 640
const THUMB_LOAD_TIMEOUT_MS = 8_000

export interface SaveArtifactMeta {
  title: string
  sessionId?: string
  messageId?: string
}

export interface ArtifactRef {
  /** Nome do arquivo: art_xxx.html — também o id do registro na galeria */
  id: string
  url: string
  title: string
  thumb?: string
  revision: number
}

/**
 * Privilégios do scheme dos artefatos. TEM que ser chamado no topo do main,
 * antes de `app.whenReady()` — depois disso o Chromium já fixou a tabela de
 * schemes e a chamada não tem efeito (a página carregaria como origem opaca,
 * sem script).
 */
export function registerArtifactSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ARTIFACT_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        // Sem CORS o artefato não consegue nem buscar dados de uma API pública
        // que o próprio modelo colocou no script.
        corsEnabled: true,
        stream: true,
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

async function handleArtifactRequest(request: Request): Promise<Response> {
  // Scheme standard: a URL tem host + path (orbit-artifact://art_x.html/?rev=2),
  // diferente do orbit-media://, onde o id inteiro cai no host e não há query.
  const parsed = new URL(request.url)
  const id = decodeURIComponent(parsed.host || parsed.pathname.replace(/^\/+/, '')).replace(/\/+$/, '')
  if (!SAFE_ARTIFACT_ID.test(id)) return new Response('not found', { status: 404 })
  try {
    const buffer = await fsp.readFile(path.join(assetFileDir(id), id))
    const ext = id.split('.').pop() ?? ''
    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': ARTIFACT_CONTENT_TYPES[ext] ?? 'application/octet-stream',
        // O arquivo é reescrito no lugar pelo update_artifact: cache aqui
        // serviria a revisão antiga.
        'Cache-Control': 'no-store',
      },
    })
  } catch {
    return new Response('not found', { status: 404 })
  }
}

/** Registra o protocolo dos artefatos (chamar após app.whenReady). */
export function registerArtifactProtocol(): void {
  protocol.handle(ARTIFACT_SCHEME, handleArtifactRequest)
}

/** Extrai o id de uma URL orbit-artifact:// (ou devolve a entrada se já for um id). */
export function artifactIdFromUrl(url: string): string | null {
  let id = url
  if (url.startsWith(`${ARTIFACT_SCHEME}://`)) {
    id = url.slice(`${ARTIFACT_SCHEME}://`.length)
  }
  id = id.replace(/\/+$/, '')
  return SAFE_ARTIFACT_ID.test(id) ? id : null
}

/**
 * Captura a miniatura numa janela oculta isolada. Best-effort: qualquer falha
 * devolve undefined e o artefato fica sem thumb (o tile cai no ícone) — nunca
 * derruba a criação do artefato.
 */
async function captureThumbnail(artifactId: string): Promise<string | undefined> {
  let win: BrowserWindow | null = null
  try {
    // Partição efêmera e exclusiva: o artefato é conteúdo do modelo e não
    // divide cookies/storage com o browser do agente nem com o app. Sem o
    // prefixo "persist:" nada disso encosta no disco.
    const partition = `artifact-thumb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    // O protocolo TEM que ser registrado nesta sessão também: protocol.handle
    // vale só para a sessão default, e sem isto o loadURL abaixo fica pendurado
    // para sempre (nem carrega, nem rejeita).
    session.fromPartition(partition).protocol.handle(ARTIFACT_SCHEME, handleArtifactRequest)

    win = new BrowserWindow({
      show: false,
      width: THUMB_VIEWPORT.width,
      height: THUMB_VIEWPORT.height,
      useContentSize: true,
      // Sem isto o Chromium não pinta uma janela nunca exibida e o capturePage
      // volta em branco (mesmo motivo do engine de scripts).
      paintWhenInitiallyHidden: true,
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    })
    const target = win
    // O .catch é obrigatório no race: uma rejeição do loadURL depois do timeout
    // ficaria sem tratamento e derrubaria o processo main.
    await Promise.race([
      target.loadURL(`${ARTIFACT_SCHEME}://${artifactId}`).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, THUMB_LOAD_TIMEOUT_MS)),
    ])
    // Um respiro para fontes/CDN/script do artefato pintarem
    await new Promise((resolve) => setTimeout(resolve, 900))
    if (target.isDestroyed()) return undefined

    // Mesma proteção do painel: com o renderer ocupado o capturePage pode
    // nunca resolver, e aí a tool inteira ficaria pendurada.
    const CAPTURE_TIMED_OUT = Symbol('captureTimedOut')
    const outcome = await Promise.race([
      target.webContents.capturePage(),
      new Promise<typeof CAPTURE_TIMED_OUT>((resolve) =>
        setTimeout(() => resolve(CAPTURE_TIMED_OUT), THUMB_LOAD_TIMEOUT_MS),
      ),
    ])
    if (outcome === CAPTURE_TIMED_OUT) return undefined
    const image = outcome
    const png = image.toPNG()
    if (png.length === 0) return undefined
    const buffer = await sharp(png).resize({ width: THUMB_WIDTH, withoutEnlargement: true }).png().toBuffer()

    const thumbId = `${artifactId.replace(/\.html$/, '')}.png`
    // assetFileDir pelo prefixo: a mesma captura serve artefato e documento,
    // que moram em diretórios diferentes.
    await fsp.writeFile(path.join(assetFileDir(thumbId), thumbId), buffer)
    return thumbId
  } catch {
    return undefined
  } finally {
    if (win && !win.isDestroyed()) win.destroy()
  }
}

/** Salva o HTML, captura a miniatura e registra o artefato na galeria. */
export async function saveArtifact(html: string, meta: SaveArtifactMeta): Promise<ArtifactRef> {
  const id = `art_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.html`
  await fsp.mkdir(artifactsDir(), { recursive: true })
  const file = path.join(artifactsDir(), id)
  await fsp.writeFile(file, html, 'utf8')

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
 * Reescreve um artefato existente NO MESMO arquivo (a URL e o lugar dele na
 * conversa se mantêm) e recaptura a miniatura. Retorna null quando o id não
 * existe no índice.
 */
export async function updateArtifact(
  id: string,
  html: string,
  title?: string,
): Promise<ArtifactRef | null> {
  if (!SAFE_ARTIFACT_ID.test(id) || !id.endsWith('.html')) return null
  const entry = await getMediaEntry(id)
  if (!entry || mediaKind(entry) !== 'artifact') return null

  await fsp.writeFile(entry.path, html, 'utf8')
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
   * Avisa as janelas. O arquivo é um só, mas quem JÁ está na tela não
   * descobre sozinho: o iframe do card antigo foi montado com a revisão
   * anterior e não recarrega por conta própria. Sem este evento o usuário
   * veria a versão velha logo acima da nova, na mesma conversa.
   *
   * Emitido direto daqui (e não pelo broadcast.ts) para não criar o ciclo
   * media → broadcast → companion-server → companion-http → media.
   */
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('artifact:updated', { artifactId: id, revision })
  }

  return { id, url: `${ARTIFACT_SCHEME}://${id}`, title: name, thumb, revision }
}

/**
 * Vincula um artefato à mensagem onde ele apareceu — mesmo motivo do
 * attachMediaMessage: a tool roda no meio do turno e não conhece o id da
 * mensagem, e é esse vínculo que faz o "abrir no chat" da galeria funcionar.
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

/** Lê o HTML de um artefato — usado pelo companion (sem acesso ao protocolo)
 *  e pela exportação. */
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

// ─── Documentos (PDF / DOCX) ─────────────────────────────────────────────

/**
 * Documento autorado pelo agente. O FONTE é Markdown; PDF e DOCX são
 * renderizações dele, e o HTML é o preview mostrado na conversa.
 *
 * O preview é HTML, e não o PDF, por uma limitação dura: o Electron não
 * embarca o visualizador de PDF do Chrome — carregar um .pdf falha com
 * ERR_FAILED até como página de topo. Como o PDF nasce DESTE html (via
 * printToPDF), o preview é fiel ao impresso mesmo sem renderizar o binário.
 *
 * Guardar o Markdown é o que torna "modificar" possível de verdade: editar um
 * PDF ou preservar a formatação de um .docx existente é intratável; reescrever
 * o fonte e renderizar de novo é exato.
 */

export interface SaveDocumentMeta {
  title: string
  sessionId?: string
  messageId?: string
  /** Pasta de trabalho da sessão — escopo de projeto do documento. */
  directory?: string
  /** Pasta da sidebar (modo chat, sem diretório). */
  folderId?: string
}

export interface DocumentRef {
  /** Id do FONTE: doc_xxx.md — também o id do registro na galeria. */
  id: string
  title: string
  previewUrl: string
  formats: DocumentFormat[]
  thumb?: string
  revision: number
}

/** Base do id, sem extensão: doc_xxx */
function documentBase(id: string): string {
  return id.replace(/\.(md|html|pdf|docx|png)$/, '')
}

/**
 * Gera o PDF a partir do HTML já gravado, com o Chromium — nenhuma biblioteca
 * de PDF entra no projeto. A janela carrega pelo orbit-artifact://, então o
 * CSS de impressão (@page A4) é o mesmo que o preview usa.
 */
async function renderPdf(htmlId: string): Promise<Buffer | null> {
  let win: BrowserWindow | null = null
  try {
    const partition = `document-pdf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    // Mesma armadilha do thumbnail: protocol.handle só vale na sessão default,
    // e sem registrar aqui o loadURL nunca resolve.
    session.fromPartition(partition).protocol.handle(ARTIFACT_SCHEME, handleArtifactRequest)

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
      // Zero aqui de propósito: as margens já vêm do padding do CSS do
      // documento (@page + body), e somar as do printToPDF daria margem
      // dobrada — o texto ficaria espremido no meio da folha.
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    })
  } catch {
    return null
  } finally {
    if (win && !win.isDestroyed()) win.destroy()
  }
}

/** Escreve fonte, preview e as renderizações pedidas. Retorna os formatos que
 *  realmente foram gerados — um PDF que falhou não pode constar no registro. */
async function writeDocumentFiles(
  base: string,
  markdown: string,
  html: string,
  formats: DocumentFormat[],
  title: string,
): Promise<DocumentFormat[]> {
  const dir = documentsDir()
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, `${base}.md`), markdown, 'utf8')
  await fsp.writeFile(path.join(dir, `${base}.html`), html, 'utf8')

  const done: DocumentFormat[] = []
  if (formats.includes('pdf')) {
    const pdf = await renderPdf(`${base}.html`)
    if (pdf) {
      await fsp.writeFile(path.join(dir, `${base}.pdf`), pdf)
      done.push('pdf')
    }
  }
  if (formats.includes('docx')) {
    try {
      const docx = await buildDocx(parseMarkdown(markdown), title)
      await fsp.writeFile(path.join(dir, `${base}.docx`), docx)
      done.push('docx')
    } catch {
      // formato que falhou simplesmente não entra em `formats`
    }
  }
  return done
}

export async function saveDocument(
  markdown: string,
  formats: DocumentFormat[],
  meta: SaveDocumentMeta,
): Promise<DocumentRef> {
  const base = `doc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const html = renderHtml(parseMarkdown(markdown), meta.title)
  const written = await writeDocumentFiles(base, markdown, html, formats, meta.title)
  const thumb = await captureThumbnail(`${base}.html`)

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
    formats: written,
    thumb,
    revision: 1,
  }
}

/**
 * Reescreve um documento existente NO MESMO id. "Modificar" é reescrever o
 * fonte e renderizar de novo: editar o binário preservando formatação é
 * intratável, e o fonte guardado torna a reescrita exata.
 */
export async function updateDocument(
  id: string,
  markdown: string,
  options: { title?: string; formats?: DocumentFormat[] },
): Promise<DocumentRef | null> {
  const entry = await getMediaEntry(id)
  if (!entry || mediaKind(entry) !== 'document') return null

  const base = documentBase(id)
  const title = options.title ?? entry.name ?? 'Documento'
  const formats = options.formats ?? entry.formats ?? ['pdf']
  const html = renderHtml(parseMarkdown(markdown), title)
  const written = await writeDocumentFiles(base, markdown, html, formats, title)
  const thumb = (await captureThumbnail(`${base}.html`)) ?? entry.thumb
  const revision = (entry.revision ?? 1) + 1

  await withIndexLock(async () => {
    const entries = await readIndex()
    const current = entries.find((e) => e.id === id)
    if (!current) return
    current.size = Buffer.byteLength(markdown, 'utf8')
    current.name = title
    current.formats = written
    current.thumb = thumb
    current.revision = revision
    await writeIndex(entries)
  })

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('artifact:updated', { artifactId: `${base}.html`, revision })
    }
  }

  return { id, title, previewUrl: `${ARTIFACT_SCHEME}://${base}.html`, formats: written, thumb, revision }
}

/** Markdown de origem — é o que o agente relê antes de modificar. */
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

/** Caminho absoluto de uma renderização, para exportar/abrir fora. */
export async function documentFilePath(id: string, format: DocumentFormat): Promise<string | null> {
  const entry = await getMediaEntry(id)
  if (!entry || mediaKind(entry) !== 'document') return null
  if (!(entry.formats ?? []).includes(format)) return null
  return path.join(documentsDir(), `${documentBase(id)}.${format}`)
}

/** Vincula o documento à mensagem onde ele apareceu (mesmo motivo do
 *  attachMediaMessage: a tool roda no meio do turno). */
export async function attachDocumentMessage(
  id: string,
  messageId: string,
  sessionId?: string,
): Promise<void> {
  await attachArtifactMessage(id, messageId, sessionId)
}

export type { MediaKind }
