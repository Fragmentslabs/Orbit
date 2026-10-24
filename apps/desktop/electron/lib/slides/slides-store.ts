import { app, BrowserWindow, protocol } from 'electron'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { SLIDES_SCHEME } from '@shared/media'
import { SLIDES_RUNTIME, SLIDES_RUNTIME_PATH, injectSlidesRuntime } from './slides-runtime'
import { slidesSlug } from './slides-slug'
import { journalPath } from '../session/media-journal'

/**
 * Registro dos decks de slides (uma PASTA com um HTML de entrada) e o scheme
 * `orbit-slides://` que a serve.
 *
 * Espelha video/motion-store.ts e design/design-store.ts: o registro guarda
 * id → pasta + entrada, nada é copiado, e todo arquivo servido é resolvido
 * DENTRO da pasta registrada — `..`, caminho absoluto e escape são recusados.
 *
 * A diferença de contrato com o design é o que faz o slide ser rápido de
 * escrever: o deck é UM arquivo (`index.html` com um `<section class="slide">`
 * por slide), não um canvas.json + N artboards. A diferença com o motion é que
 * não há linha do tempo: o runtime aqui só monta o palco e obedece ao teclado.
 *
 * O HTML sai com o runtime injetado no `<head>` (como o motion injeta o de
 * seek): o deck continua sendo conteúdo puro no disco, e quem sabe navegar é o
 * app.
 */

const SAFE_SLIDES_ID = /^sld_[a-z0-9]+$/

/** Id de sessão como nome de pasta (ver slidesPiecesDir). */
const SAFE_SESSION = /^[A-Za-z0-9_-]{1,80}$/

/** Canal do renderer para a recarga ao vivo. */
export const SLIDES_CHANGED_CHANNEL = 'slides:changed'

/** Debounce do fs.watch: o editor grava em rajada e não queremos N eventos. */
const WATCH_DEBOUNCE_MS = 150

export interface SlidesEntry {
  /** Pasta raiz do deck: o scheme não serve nada fora dela. */
  folder: string
  /** Arquivo de entrada (absoluto), sempre dentro de `folder`. */
  entry: string
  /** Pasta de trabalho que registrou — revalidada quando o painel reabre. */
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
  return path.join(app.getPath('userData'), 'orbit-data', 'slides.json')
}

let index: Record<string, SlidesEntry> | null = null

async function load(fresh = false): Promise<Record<string, SlidesEntry>> {
  if (index && !fresh) return index
  try {
    const disk = JSON.parse(await fsp.readFile(indexFile(), 'utf8')) as Record<string, SlidesEntry>
    // Releitura: o que está em memória e ainda não foi gravado não pode sumir.
    index = fresh && index ? { ...disk, ...index } : disk
  } catch {
    index = index ?? {}
  }
  return index
}

/**
 * Id do deck: derivado da pasta + entrada, não sorteado. Registrar de novo o
 * mesmo deck (o preview reaberto, o card do chat) devolve o MESMO id — a aba
 * aberta continua apontando para uma URL válida.
 */
export function slidesIdFor(folder: string, entry: string): string {
  const key = `${path.resolve(folder).toLowerCase()}|${path.resolve(entry).toLowerCase()}`
  return `sld_${createHash('sha1').update(key).digest('hex').slice(0, 16)}`
}

/** Caminho comparável: separador normalizado, sem `./` na frente, minúsculo. */
function normalize(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase()
}

/** O deck registrado a partir do caminho que o agente usou (pasta ou entrada). */
export async function slidesIdForPath(target: string): Promise<string | null> {
  const wanted = path.resolve(target).toLowerCase()
  const entries = await load(true)
  for (const [id, entry] of Object.entries(entries)) {
    if (path.resolve(entry.entry).toLowerCase() === wanted) return id
    if (path.resolve(entry.folder).toLowerCase() === wanted) return id
  }
  // O agente manda caminho RELATIVO à pasta da sessão, e aqui não há sessão para
  // resolver contra: o FIM do caminho ainda distingue o deck (o registro é curto).
  const tail = normalize(target)
  if (!tail.includes('/')) return null
  for (const [id, entry] of Object.entries(entries)) {
    if (normalize(entry.entry).endsWith(`/${tail}`)) return id
    if (normalize(entry.folder).endsWith(`/${tail}`)) return id
  }
  return null
}

/** O deck registrado a partir do NOME que ele tem na conversa (modo chat). */
export async function slidesIdForName(sessionId: string, name: string): Promise<string | null> {
  if (!name.trim()) return null
  // Os dois lados passam pelo MESMO slug: o card manda o TÍTULO ("Orbit em 12
  // slides") e a pasta é o slug dele ("orbit-em-12-slides").
  const wanted = slidesSlug(name)
  const entries = await load(true)
  for (const [id, entry] of Object.entries(entries)) {
    if (entry.sessionId !== sessionId) continue
    if (slidesSlug(path.basename(entry.folder)) === wanted) return id
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

/** `target` está dentro de `root`? (o mesmo teste do resolveSafePath). */
function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Dentro de `root`, mas não o próprio `root` — a trava do delete. */
function isStrictlyInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * Resolve o caminho de uma URL `orbit-slides://<id>/<caminho>` dentro da pasta
 * do deck. Puro. Recusa caminho vazio, absoluto (inclusive `C:\…`), com `..` em
 * qualquer posição ou que escape da pasta depois de normalizado.
 */
export function resolveSlidesFile(folder: string, relative: string): string | null {
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

/** Relativo (com `/`) do arquivo de entrada em relação à pasta. */
function relativeEntry(entry: SlidesEntry): string {
  return path
    .relative(entry.folder, entry.entry)
    .split(path.sep)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

/**
 * Pasta + entrada a partir do que quem chama tem em mãos: o par (pasta,
 * entrada) ou só o caminho (se for pasta, a entrada é o index.html dela).
 */
async function resolveDeck(target: string, entry?: string): Promise<{ folder: string; entry: string }> {
  const abs = path.resolve(target)
  if (entry !== undefined) return { folder: abs, entry: path.resolve(entry) }
  let isDir = false
  try {
    isDir = (await fsp.stat(abs)).isDirectory()
  } catch {
    isDir = false
  }
  return isDir ? { folder: abs, entry: path.join(abs, 'index.html') } : { folder: path.dirname(abs), entry: abs }
}

/** Registra (ou reaproveita) um deck e devolve a URL do palco. */
export async function registerSlides(
  target: string,
  opts: { entry?: string; root?: string; sessionId?: string } = {},
): Promise<{ id: string; url: string; created: boolean; folder: string; entry: string }> {
  const deck = await resolveDeck(target, opts.entry)
  const dir = deck.folder
  const file = deck.entry
  if (!isInside(dir, file)) {
    throw new Error(`slides entry ${file} is outside the deck folder ${dir}`)
  }
  const entries = await load()
  const id = slidesIdFor(dir, file)
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
      entry: file,
      root: opts.root ? path.resolve(opts.root) : undefined,
      sessionId: opts.sessionId,
      createdAt: Date.now(),
    }
    await persist()
  }
  if (!watchers.has(id)) watchSlides(id, dir)
  return {
    id,
    url: `${SLIDES_SCHEME}://${id}/${relativeEntry(entries[id])}`,
    created: !existing,
    folder: dir,
    entry: file,
  }
}

// ---------------------------------------------------------- pasta das peças

/** Raiz dos decks do Orbit (nos dois modos) — fora de qualquer projeto. */
export function slidesPiecesRoot(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'slides')
}

/**
 * Pasta dos decks de uma conversa. O id da sessão vira nome de pasta, então é
 * validado: sem isso um `../` no sessionId escreveria fora do armazenamento.
 */
export function slidesPiecesDir(sessionId: string): string {
  if (!SAFE_SESSION.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`)
  return path.join(slidesPiecesRoot(), sessionId)
}

/** Registro de um deck (valida o id antes de tocar no índice). */
export async function getSlides(id: string): Promise<SlidesEntry | undefined> {
  if (!SAFE_SLIDES_ID.test(id)) return undefined
  return (await load())[id] ?? (await load(true))[id]
}

/** URL `orbit-slides://<id>/<entrada>` de um deck REGISTRADO. */
export async function registeredSlidesUrl(id: string): Promise<string | null> {
  const entry = await getSlides(id)
  return entry ? `${SLIDES_SCHEME}://${id}/${relativeEntry(entry)}` : null
}

/** Tira o deck do registro e libera o watcher dele. */
export async function unregisterSlides(id: string): Promise<void> {
  const entries = await load()
  if (!entries[id]) return
  delete entries[id]
  await persist()
  unwatchSlides(id)
}

export interface SlidesDeletion {
  removedFolder: boolean
  /** Por que a pasta foi preservada (ausente quando ela foi apagada). */
  keptBecause?: string
}

/**
 * Apaga um deck de verdade: a pasta, o registro e o watcher. Espelha
 * `deleteMotionComposition`, com as mesmas travas — excluir na galeria é
 * liberar espaço, mas nunca pode apagar o projeto em si.
 *
 * As três condições de recusa são o que separa "liberar espaço" de "destruir o
 * repositório de quem trabalha": a pasta tem de existir, conter a entrada do
 * deck, e estar DENTRO da raiz do chat ou do projeto que a registrou — nunca
 * SER o projeto.
 */
export async function deleteSlidesDeck(id: string): Promise<SlidesDeletion> {
  const entry = await getSlides(id)
  if (!entry) return { removedFolder: false, keptBecause: 'not registered' }
  const folder = path.resolve(entry.folder)

  let keptBecause: string | undefined
  const stat = await fsp.stat(folder).catch(() => null)
  const hasEntry = await fsp.stat(entry.entry).then((s) => s.isFile()).catch(() => false)
  if (!stat?.isDirectory()) {
    keptBecause = 'the folder no longer exists'
  } else if (!hasEntry) {
    keptBecause = 'the folder does not contain the deck entry'
  } else if (isStrictlyInside(slidesPiecesRoot(), folder)) {
    // do Orbit
  } else if (entry.root && isStrictlyInside(entry.root, folder)) {
    // dentro do projeto que o registrou, e não o projeto em si
  } else {
    keptBecause = 'the folder is the project itself (or outside the working folder it was registered from)'
  }

  if (!keptBecause) {
    // No turno do agente (slides_delete), a pasta vai para o diário antes.
    await journalPath(folder, { kind: 'slides', id, folder, entry: entry.entry, root: entry.root, sessionId: entry.sessionId })
    await fsp.rm(folder, { recursive: true, force: true })
  }
  await unregisterSlides(id)
  return keptBecause ? { removedFolder: false, keptBecause } : { removedFolder: true }
}

// ------------------------------------------------------------------ watcher
const watchers = new Map<string, fs.FSWatcher>()
const debounces = new Map<string, ReturnType<typeof setTimeout>>()

function notifyChanged(id: string): void {
  const pending = debounces.get(id)
  if (pending) clearTimeout(pending)
  debounces.set(
    id,
    setTimeout(() => {
      debounces.delete(id)
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(SLIDES_CHANGED_CHANNEL, { id })
      }
    }, WATCH_DEBOUNCE_MS),
  )
}

/**
 * O que NÃO recarrega o palco: exportações, temporários e o que a apresentação
 * gera ao lado do deck. Puro — os testes cobrem a lista.
 */
export function isSlidesSourceChange(filename: string | null | undefined): boolean {
  if (!filename) return true
  const name = filename.replace(/\\/g, '/')
  if (name.split('/').some((segment) => segment.startsWith('.slides-') || segment === '.render')) return false
  // Imagem NÃO entra na lista: `assets/fundo.png` é fonte do deck, não saída.
  return !/\.(pdf|mp4|mov|webm|tmp|part|crdownload)$/i.test(name)
}

function watchSlides(id: string, folder: string): void {
  unwatchSlides(id)
  const listener = (_event: string, filename: string | Buffer | null) => {
    if (isSlidesSourceChange(filename == null ? null : String(filename))) notifyChanged(id)
  }
  try {
    watchers.set(id, fs.watch(folder, { recursive: true }, listener))
  } catch {
    // Linux não suporta watch recursivo: cai para o nível de cima (o deck é um
    // arquivo por pasta, na prática).
    try {
      watchers.set(id, fs.watch(folder, listener))
    } catch {
      // pasta sumiu desde o registro — o protocolo devolve 404 na hora.
    }
  }
}

/** Religa o watcher e recarrega a aba depois que a pasta foi trocada inteira (revert). */
export async function rewatchSlides(id: string): Promise<void> {
  const entry = await getSlides(id)
  if (!entry) return
  watchSlides(id, entry.folder)
  notifyChanged(id)
}

export function unwatchSlides(id: string): void {
  const watcher = watchers.get(id)
  if (watcher) {
    try {
      watcher.close()
    } catch {
      // já fechado
    }
    watchers.delete(id)
  }
  const pending = debounces.get(id)
  if (pending) {
    clearTimeout(pending)
    debounces.delete(id)
  }
}

// ----------------------------------------------------------------- protocol
const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*' } as const

function respond(body: BodyInit | null, type: string, status = 200, extra: Record<string, string> = {}): Response {
  const length = typeof body === 'string' ? Buffer.byteLength(body) : body instanceof Uint8Array ? body.byteLength : null
  return new Response(body, {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': type,
      // O deck é editado com o palco aberto: cache serviria a versão antiga e a
      // recarga ao vivo pareceria não funcionar.
      'Cache-Control': 'no-store',
      ...(length === null ? {} : { 'Content-Length': String(length) }),
      ...extra,
    },
  })
}

/** Registra o protocolo dos decks (chamar após app.whenReady). */
export function registerSlidesProtocol(): void {
  protocol.handle(SLIDES_SCHEME, async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return respond('bad url', 'text/plain; charset=utf-8', 400)
    }
    const id = decodeURIComponent(url.host)
    if (!SAFE_SLIDES_ID.test(id)) return respond('not found', 'text/plain; charset=utf-8', 404)
    const entry = await getSlides(id)
    if (!entry) return respond('not found', 'text/plain; charset=utf-8', 404)
    // Caminho reservado: o script que monta o palco (ver slides-runtime.ts).
    if (url.pathname === SLIDES_RUNTIME_PATH) {
      return respond(SLIDES_RUNTIME, 'text/javascript; charset=utf-8')
    }
    const file = resolveSlidesFile(entry.folder, url.pathname)
    if (!file) return respond('not found', 'text/plain; charset=utf-8', 404)
    const ext = path.extname(file).toLowerCase()
    const type = CONTENT_TYPES[ext] ?? 'application/octet-stream'
    // O HTML sai com o runtime no <head>; `?raw` é o FONTE como está no disco
    // (o que um dia o "ver código" da aba vai mostrar).
    if ((ext === '.html' || ext === '.htm') && !url.searchParams.has('raw')) {
      const html = await fsp.readFile(file, 'utf8').catch(() => null)
      if (html === null) return respond('file moved or deleted', 'text/plain; charset=utf-8', 404)
      return respond(injectSlidesRuntime(html), type)
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
