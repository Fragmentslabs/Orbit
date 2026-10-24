import { app, BrowserWindow, protocol } from 'electron'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { DESIGN_SCHEME } from '@shared/media'
import { isSafeBoardFile, readDesignCanvas, writeDesignCanvas, type DesignBoard } from './design-canvas'
import { withAssetLock, writeFileAtomic } from '../asset-lock'
import { allFontFacesCss } from '../fonts/store'
import { DESIGN_RUNTIME, DESIGN_RUNTIME_PATH, injectDesignRuntime } from './design-runtime'

/**
 * Registro dos canvas de design (uma PASTA do app: `canvas.json` + um .html por
 * artboard) e o scheme `orbit-design://` que a serve.
 *
 * Espelha video/motion-store.ts: o registro guarda id → pasta, nada é copiado, e
 * todo arquivo servido é resolvido DENTRO da pasta registrada. Diferente do
 * motion, não há runtime injetado (o artboard é estático: sem linha do tempo,
 * sem seek) nem faixa de mídia — por isso o scheme aqui é bem mais simples.
 */

const SAFE_DESIGN_ID = /^dsg_[a-z0-9]+$/

/** Canal do renderer para a recarga ao vivo. */
export const DESIGN_CHANGED_CHANNEL = 'design:changed'

/** Debounce do fs.watch: o editor grava em rajada e não queremos N eventos. */
const WATCH_DEBOUNCE_MS = 150
/**
 * Teto do debounce. Numa geração o agente escreve uma tela atrás da outra sem
 * pausa suficiente para o debounce "fechar": sem teto, o aviso só sairia no
 * fim da rajada (ou sairia N vezes). Com ele, o canvas atualiza no máximo a
 * cada WATCH_MAX_WAIT_MS contados da PRIMEIRA mudança.
 */
const WATCH_MAX_WAIT_MS = 400

export interface DesignEntry {
  /** Pasta raiz do canvas: o scheme não serve nada fora dela. */
  folder: string
  /** Pasta de trabalho que registrou (reservado — hoje só o modo chat registra). */
  root?: string
  sessionId?: string
  createdAt: number
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
}

function indexFile(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'design.json')
}

let index: Record<string, DesignEntry> | null = null

async function load(fresh = false): Promise<Record<string, DesignEntry>> {
  if (index && !fresh) return index
  try {
    const disk = JSON.parse(await fsp.readFile(indexFile(), 'utf8')) as Record<string, DesignEntry>
    index = fresh && index ? { ...disk, ...index } : disk
  } catch {
    index = index ?? {}
  }
  return index
}

/** Id do canvas: derivado da pasta, não sorteado — registrar de novo o mesmo
 *  canvas devolve o MESMO id, e a aba aberta continua válida. */
export function designIdFor(folder: string): string {
  const key = path.resolve(folder).toLowerCase()
  return `dsg_${createHash('sha1').update(key).digest('hex').slice(0, 16)}`
}

/** O canvas registrado a partir do NOME que ele tem na conversa (modo chat). */
export async function designIdForName(sessionId: string, name: string): Promise<string | null> {
  const wanted = name.trim().toLowerCase()
  if (!wanted) return null
  const entries = await load(true)
  for (const [id, entry] of Object.entries(entries)) {
    if (entry.sessionId !== sessionId) continue
    if (path.basename(entry.folder).toLowerCase() === wanted) return id
  }
  return null
}

/** Caminho comparável: separador normalizado, sem `./` na frente, minúsculo. */
function normalize(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase()
}

/**
 * O canvas registrado a partir do CAMINHO que o agente usou no preview (modo
 * código: a tool design_preview recebe a pasta do canvas). Espelha
 * motionIdForPath — mesmo fallback pelo FIM do caminho quando o agente manda
 * um relativo que não resolve contra o cwd do app.
 */
export async function designIdForPath(target: string): Promise<string | null> {
  const wanted = path.resolve(target).toLowerCase()
  const entries = await load(true)
  for (const [id, entry] of Object.entries(entries)) {
    if (path.resolve(entry.folder).toLowerCase() === wanted) return id
  }
  const tail = normalize(target)
  if (!tail.includes('/')) return null
  for (const [id, entry] of Object.entries(entries)) {
    if (normalize(entry.folder).endsWith(`/${tail}`)) return id
  }
  return null
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

function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Resolve o caminho de uma URL `orbit-design://<id>/<caminho>` dentro da pasta
 * do canvas. Puro. Recusa caminho vazio, absoluto, com `..` ou que escape da
 * pasta depois de normalizado — o mesmo contrato do resolveMotionFile.
 */
export function resolveDesignFile(folder: string, relative: string): string | null {
  let rel = relative ?? ''
  try {
    rel = decodeURIComponent(rel)
  } catch {
    return null
  }
  rel = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!rel || rel.includes('\0')) return null
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return null
  if (rel.split('/').some((segment) => segment === '..')) return null
  const root = path.resolve(folder)
  const target = path.resolve(root, rel)
  return isInside(root, target) ? target : null
}

/** Registra (ou reaproveita) um canvas e devolve a URL do índice. */
export async function registerDesign(
  folder: string,
  opts: { root?: string; sessionId?: string } = {},
): Promise<{ id: string; url: string; created: boolean }> {
  const dir = path.resolve(folder)
  const entries = await load()
  const id = designIdFor(dir)
  const existing = entries[id]
  if (existing) {
    let changed = false
    if (opts.root && existing.root !== path.resolve(opts.root)) {
      existing.root = path.resolve(opts.root)
      changed = true
    }
    if (opts.sessionId && existing.sessionId !== opts.sessionId) {
      existing.sessionId = opts.sessionId
      changed = true
    }
    if (changed) await persist()
  } else {
    entries[id] = {
      folder: dir,
      root: opts.root ? path.resolve(opts.root) : undefined,
      sessionId: opts.sessionId,
      createdAt: Date.now(),
    }
    await persist()
  }
  if (!watchers.has(id)) watchDesign(id, dir)
  return { id, url: `${DESIGN_SCHEME}://${id}/canvas.json`, created: !existing }
}

export async function getDesign(id: string): Promise<DesignEntry | undefined> {
  if (!SAFE_DESIGN_ID.test(id)) return undefined
  return (await load())[id] ?? (await load(true))[id]
}

export async function registeredDesignUrl(id: string): Promise<string | null> {
  const entry = await getDesign(id)
  return entry ? `${DESIGN_SCHEME}://${id}/canvas.json` : null
}

export async function unregisterDesign(id: string): Promise<void> {
  const entries = await load()
  if (!entries[id]) return
  delete entries[id]
  await persist()
  unwatchDesign(id)
}

/** Pastas de canvas que o próprio Orbit guarda (o modo chat) — apagáveis sem
 *  pedir licença a projeto nenhum. */
function chatDesignsRoot(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'design')
}

function isStrictlyInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

export interface DesignDeletion {
  removedFolder: boolean
  keptBecause?: string
}

/**
 * Apaga um canvas: a pasta, o registro e o watcher. Mesma trava do motion — só
 * apaga a pasta quando ela é do armazenamento do Orbit (hoje, sempre, já que só
 * o modo chat registra), nunca a pasta de trabalho de um projeto.
 */
export async function deleteDesignCanvas(id: string): Promise<DesignDeletion> {
  const entry = await getDesign(id)
  if (!entry) return { removedFolder: false, keptBecause: 'not registered' }
  const folder = path.resolve(entry.folder)

  let keptBecause: string | undefined
  const stat = await fsp.stat(folder).catch(() => null)
  if (!stat?.isDirectory()) {
    keptBecause = 'the folder no longer exists'
  } else if (isStrictlyInside(chatDesignsRoot(), folder)) {
    // do Orbit
  } else if (entry.root && isStrictlyInside(entry.root, folder)) {
    // dentro do projeto que o registrou, e não o projeto em si
  } else {
    keptBecause = 'the folder is outside the app storage it was registered from'
  }

  if (!keptBecause) await fsp.rm(folder, { recursive: true, force: true })
  await unregisterDesign(id)
  return keptBecause ? { removedFolder: false, keptBecause } : { removedFolder: true }
}

// ------------------------------------------------------------ edição (IPC)
// O que a aba Design grava quando a PESSOA edita no canvas: o fonte de um
// artboard (propriedades, texto, código) e o arranjo dele no canvas.json. O
// renderer manda só o id e o nome do arquivo — a pasta sai do registro, e o
// nome passa pela mesma trava das tools (plano, .html, sem caminho).

async function boardTarget(id: string, file: string): Promise<{ folder: string; target: string }> {
  const entry = await getDesign(id)
  if (!entry) throw new Error(`unknown design canvas: ${id}`)
  if (!isSafeBoardFile(file)) throw new Error(`invalid artboard file name: ${file}`)
  const target = resolveDesignFile(entry.folder, file)
  if (!target) throw new Error(`artboard outside the canvas folder: ${file}`)
  return { folder: entry.folder, target }
}

/** Reescreve o fonte de um artboard. */
export async function writeDesignBoard(id: string, file: string, html: string): Promise<void> {
  const { folder, target } = await boardTarget(id, file)
  // Mesmo lock/escrita atômica das tools de design: a edição da PESSOA no canvas
  // e um design_edit do agente no mesmo artboard não se intercalam.
  await withAssetLock(`design:${folder}`, () => writeFileAtomic(target, html))
}

/** Lê o fonte de um artboard (sem a ponte). */
export async function readDesignBoard(id: string, file: string): Promise<string> {
  const { target } = await boardTarget(id, file)
  return fsp.readFile(target, 'utf8')
}

/** Muda o arranjo (posição, tamanho, título) de um artboard no canvas.json. */
export async function updateDesignBoard(
  id: string,
  file: string,
  patch: Partial<Pick<DesignBoard, 'title' | 'x' | 'y' | 'w' | 'h'>>,
): Promise<void> {
  const { folder } = await boardTarget(id, file)
  await withAssetLock(`design:${folder}`, async () => {
    const canvas = await readDesignCanvas(folder)
    const board = canvas.boards[file]
    if (!board) throw new Error(`artboard not in canvas.json: ${file}`)
    const num = (value: unknown, min: number, max: number): number | undefined =>
      typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : undefined
    canvas.boards[file] = {
      ...board,
      ...(typeof patch.title === 'string' ? { title: patch.title.slice(0, 120) || undefined } : {}),
      ...(num(patch.x, -100_000, 100_000) !== undefined ? { x: num(patch.x, -100_000, 100_000) as number } : {}),
      ...(num(patch.y, -100_000, 100_000) !== undefined ? { y: num(patch.y, -100_000, 100_000) as number } : {}),
      ...(num(patch.w, 40, 8000) !== undefined ? { w: num(patch.w, 40, 8000) as number } : {}),
      ...(num(patch.h, 40, 8000) !== undefined ? { h: num(patch.h, 40, 8000) as number } : {}),
    }
    await writeDesignCanvas(folder, canvas)
  })
}

// ------------------------------------------------------------------ watcher
const watchers = new Map<string, fs.FSWatcher>()

/**
 * Mudanças pendentes por canvas. O debounce junta os nomes que o fs.watch
 * mandou e manda UMA mensagem — com a LISTA de arquivos: é ela que deixa a aba
 * Design recarregar só o artboard que mudou, em vez de remontar todos os
 * iframes a cada gravação (ver design-tab.tsx).
 */
const pendingChanges = new Map<
  string,
  { files: Set<string>; firstAt: number; timer: ReturnType<typeof setTimeout> }
>()

function notifyChanged(id: string, file?: string | null): void {
  const now = Date.now()
  let pending = pendingChanges.get(id)
  if (!pending) {
    pending = { files: new Set(), firstAt: now, timer: setTimeout(() => flushChanged(id), WATCH_DEBOUNCE_MS) }
    pendingChanges.set(id, pending)
  } else {
    clearTimeout(pending.timer)
    // Espera o silêncio, mas nunca além do teto contado da primeira mudança.
    const wait = Math.max(0, Math.min(WATCH_DEBOUNCE_MS, pending.firstAt + WATCH_MAX_WAIT_MS - now))
    pending.timer = setTimeout(() => flushChanged(id), wait)
  }
  // Separador normalizado: o renderer compara com os nomes do canvas.json.
  if (file) pending.files.add(file.replace(/\\/g, '/'))
}

function flushChanged(id: string): void {
  const pending = pendingChanges.get(id)
  if (!pending) return
  pendingChanges.delete(id)
  const files = [...pending.files]
  forgetInjectedDocuments(id, files)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(DESIGN_CHANGED_CHANNEL, { id, files })
  }
}

/**
 * O watcher é a fonte da verdade sobre o que mudou: esquecer o documento
 * injetado aqui cobre o caso em que `mtime` e tamanho repetem (disco com
 * resolução de milissegundo e a mesma contagem de bytes). Sem nomes, esquece
 * tudo o que é daquela pasta.
 */
function forgetInjectedDocuments(id: string, files: string[]): void {
  const folder = index?.[id]?.folder
  if (!folder) return
  const root = path.resolve(folder)
  if (files.length === 0) {
    for (const key of [...injectedDocuments.keys()]) {
      if (key === root || key.startsWith(`${root}${path.sep}`)) injectedDocuments.delete(key)
    }
    return
  }
  for (const file of files) injectedDocuments.delete(path.resolve(root, file))
}

function watchDesign(id: string, folder: string): void {
  unwatchDesign(id)
  // O nome vem relativo à pasta (recursivo) e é o que permite a recarga
  // cirúrgica; sem ele (ou fora do macOS, quando o watcher não informa), a
  // mensagem sai sem lista e a aba recarrega tudo, como antes.
  const listener = (_event: string, filename: string | Buffer | null) => {
    notifyChanged(id, filename ? filename.toString() : null)
  }
  try {
    watchers.set(id, fs.watch(folder, { recursive: true }, listener))
  } catch {
    try {
      watchers.set(id, fs.watch(folder, listener))
    } catch {
      // pasta sumiu desde o registro — o protocolo devolve 404 na hora.
    }
  }
}

export function unwatchDesign(id: string): void {
  const watcher = watchers.get(id)
  if (watcher) {
    try {
      watcher.close()
    } catch {
      // já fechado
    }
    watchers.delete(id)
  }
  const pending = pendingChanges.get(id)
  if (pending) {
    clearTimeout(pending.timer)
    pendingChanges.delete(id)
  }
}

// ----------------------------------------------------------------- protocol
const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*' } as const

/**
 * Documento já com a ponte injetada, por arquivo. Cada montagem de artboard
 * custava reler o disco, reinjetar a ponte e remontar o CSS das fontes; numa
 * aba com várias telas isso se multiplica. A validade é `mtime`/tamanho + a
 * versão do CSS de fontes (que muda quando a biblioteca muda).
 */
interface InjectedDocument {
  mtimeMs: number
  size: number
  fontCss: string
  body: string
  etag: string
}

const injectedDocuments = new Map<string, InjectedDocument>()
/** Teto do cache: um canvas grande não pode virar memória presa. */
const INJECTED_DOCUMENTS_LIMIT = 64

async function injectedDocument(file: string, fontCss: string): Promise<InjectedDocument | null> {
  const stat = await fsp.stat(file).catch(() => null)
  if (!stat?.isFile()) return null
  const cached = injectedDocuments.get(file)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.fontCss === fontCss) {
    // Reinserir mantém a ordem de uso: o primeiro do Map é o mais antigo.
    injectedDocuments.delete(file)
    injectedDocuments.set(file, cached)
    return cached
  }
  const html = await fsp.readFile(file, 'utf8').catch(() => null)
  if (html === null) return null
  const body = injectDesignRuntime(html, fontCss)
  const entry: InjectedDocument = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    fontCss,
    body,
    // ETag do documento JÁ injetado: muda com o fonte e com a biblioteca de
    // fontes, que é tudo o que entra nele.
    etag: `"${createHash('sha1').update(body).digest('base64url')}"`,
  }
  injectedDocuments.delete(file)
  injectedDocuments.set(file, entry)
  if (injectedDocuments.size > INJECTED_DOCUMENTS_LIMIT) {
    const oldest = injectedDocuments.keys().next().value
    if (oldest) injectedDocuments.delete(oldest)
  }
  return entry
}

function respond(body: BodyInit | null, type: string, status = 200, extra: Record<string, string> = {}): Response {
  const length = typeof body === 'string' ? Buffer.byteLength(body) : body instanceof Uint8Array ? body.byteLength : null
  return new Response(body, {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': type,
      // O canvas é editado com o preview aberto: cache serviria a versão
      // antiga e a recarga ao vivo pareceria não funcionar.
      'Cache-Control': 'no-store',
      ...(length === null ? {} : { 'Content-Length': String(length) }),
      ...extra,
    },
  })
}

/** Registra o protocolo dos canvas de design (chamar após app.whenReady). */
export function registerDesignProtocol(): void {
  protocol.handle(DESIGN_SCHEME, async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return respond('bad url', 'text/plain; charset=utf-8', 400)
    }
    const id = decodeURIComponent(url.host)
    if (!SAFE_DESIGN_ID.test(id)) return respond('not found', 'text/plain; charset=utf-8', 404)
    const entry = await getDesign(id)
    if (!entry) return respond('not found', 'text/plain; charset=utf-8', 404)
    // Caminho reservado: a ponte de seleção/edição (ver design-runtime.ts). O
    // conteúdo é uma constante do build do app e o URL carrega a versão dele
    // (`?v=`, ver injectDesignRuntime): pode ser guardado para sempre, e o
    // iframe reaproveita o script já compilado entre remontagens.
    if (url.pathname === DESIGN_RUNTIME_PATH) {
      return respond(DESIGN_RUNTIME, 'text/javascript; charset=utf-8', 200, {
        'Cache-Control': 'public, max-age=31536000, immutable',
      })
    }
    const file = resolveDesignFile(entry.folder, url.pathname)
    if (!file) return respond('not found', 'text/plain; charset=utf-8', 404)
    const ext = path.extname(file).toLowerCase()
    const type = CONTENT_TYPES[ext] ?? 'application/octet-stream'
    // O artboard sai com a ponte no <head>; `?raw` é o FONTE, como está no disco
    // — é o que a aba de código mostra e o que a edição reescreve.
    if ((ext === '.html' || ext === '.htm') && !url.searchParams.has('raw')) {
      // A biblioteca de fontes do Orbit entra em TODO artboard (ver
      // injectDesignRuntime): a família instalada é usada pelo nome.
      const artboard = await injectedDocument(file, await allFontFacesCss())
      if (!artboard) return respond('file moved or deleted', 'text/plain; charset=utf-8', 404)
      // `no-cache` = pode guardar, mas revalida sempre: o canvas é editado com a
      // aba aberta e servir a versão antiga pareceria a recarga não funcionar.
      // Com o ETag do documento injetado, uma remontagem sem mudança vira 304.
      const headers = { ETag: artboard.etag, 'Cache-Control': 'no-cache' }
      if (request.headers.get('if-none-match') === artboard.etag) return respond(null, type, 304, headers)
      return respond(artboard.body, type, 200, headers)
    }
    const size = await fsp
      .stat(file)
      .then((stat) => (stat.isFile() ? stat.size : null))
      .catch(() => null)
    if (size === null) return respond('file moved or deleted', 'text/plain; charset=utf-8', 404)
    const stream = Readable.toWeb(fs.createReadStream(file)) as unknown as ReadableStream
    return respond(size > 0 ? stream : new Uint8Array(0), type, 200, { 'Content-Length': String(size) })
  })
}
