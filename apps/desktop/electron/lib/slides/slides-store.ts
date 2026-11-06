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
import { fetchRemoteAsset, fetchRemoteText, isRemoteAsset } from '../peers/remote-assets'

/**
 * Registry of the slide decks (a FOLDER with an entry HTML) and the
 * `orbit-slides://` scheme that serves it.
 *
 * Mirrors video/motion-store.ts and design/design-store.ts: the registry holds
 * id → folder + entry, nothing is copied, and every served file is resolved
 * INSIDE the registered folder — `..`, absolute path and escape are refused.
 *
 * The contract difference from design is what makes a slide fast to write: the
 * deck is ONE file (`index.html` with one `<section class="slide">` per slide), not
 * a canvas.json + N artboards. The difference from motion is that there is no
 * timeline: the runtime here only builds the stage and obeys the keyboard.
 *
 * The HTML comes out with the runtime injected in the `<head>` (as motion injects
 * the seek one): the deck remains pure content on disk, and the app is what knows
 * how to navigate.
 */

const SAFE_SLIDES_ID = /^sld_[a-z0-9]+$/

/** Session id as a folder name (see slidesPiecesDir). */
const SAFE_SESSION = /^[A-Za-z0-9_-]{1,80}$/

/** Renderer channel for the live reload. */
export const SLIDES_CHANGED_CHANNEL = 'slides:changed'

/** fs.watch debounce: the editor writes in bursts and we do not want N events. */
const WATCH_DEBOUNCE_MS = 150

export interface SlidesEntry {
  /** Root folder of the deck: the scheme serves nothing outside of it. */
  folder: string
  /** Entry file (absolute), always inside `folder`. */
  entry: string
  /** Working folder that registered it — revalidated when the panel reopens. */
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
    // Re-read: what is in memory and not yet written cannot vanish.
    index = fresh && index ? { ...disk, ...index } : disk
  } catch {
    index = index ?? {}
  }
  return index
}

/**
 * Deck id: derived from the folder + entry, not drawn at random. Registering the
 * same deck again (the reopened preview, the chat card) returns the SAME id — the
 * open tab keeps pointing to a valid URL.
 */
export function slidesIdFor(folder: string, entry: string): string {
  const key = `${path.resolve(folder).toLowerCase()}|${path.resolve(entry).toLowerCase()}`
  return `sld_${createHash('sha1').update(key).digest('hex').slice(0, 16)}`
}

/** Comparable path: normalized separator, no leading `./`, lowercase. */
function normalize(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase()
}

/** The deck registered from the path the agent used (folder or entry). */
export async function slidesIdForPath(target: string): Promise<string | null> {
  const wanted = path.resolve(target).toLowerCase()
  const entries = await load(true)
  for (const [id, entry] of Object.entries(entries)) {
    if (path.resolve(entry.entry).toLowerCase() === wanted) return id
    if (path.resolve(entry.folder).toLowerCase() === wanted) return id
  }
  // The agent sends a path RELATIVE to the session folder, and here there is no session
  // to resolve against: the END of the path still distinguishes the deck (the registry is short).
  const tail = normalize(target)
  if (!tail.includes('/')) return null
  for (const [id, entry] of Object.entries(entries)) {
    if (normalize(entry.entry).endsWith(`/${tail}`)) return id
    if (normalize(entry.folder).endsWith(`/${tail}`)) return id
  }
  return null
}

/** The deck registered from the NAME it has in the conversation (chat mode). */
export async function slidesIdForName(sessionId: string, name: string): Promise<string | null> {
  if (!name.trim()) return null
  // Both sides go through the SAME slug: the card sends the TITLE ("Orbit em 12
  // slides") and the folder is its slug ("orbit-em-12-slides").
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

/** Is `target` inside `root`? (the same test as resolveSafePath). */
function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Inside `root`, but not `root` itself — the lock for delete. */
function isStrictlyInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * Resolves the path of an `orbit-slides://<id>/<path>` URL inside the deck folder.
 * Pure. Refuses an empty path, an absolute one (including `C:\…`), one with `..` in
 * any position or one that escapes the folder after normalization.
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

/** Path (with `/`) of the entry file relative to the folder. */
function relativeEntry(entry: SlidesEntry): string {
  return path
    .relative(entry.folder, entry.entry)
    .split(path.sep)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

/**
 * Folder + entry from whatever the caller has at hand: the pair (folder, entry)
 * or just the path (if it is a folder, the entry is its index.html).
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

/** Registers (or reuses) a deck and returns the stage URL. */
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

// ---------------------------------------------------------- pieces folder

/** Root of the Orbit decks (in both modes) — outside of any project. */
export function slidesPiecesRoot(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'slides')
}

/**
 * Folder of the decks of a conversation. The session id becomes a folder name, so it
 * is validated: without that a `../` in the sessionId would write outside the
 * storage.
 */
export function slidesPiecesDir(sessionId: string): string {
  if (!SAFE_SESSION.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`)
  return path.join(slidesPiecesRoot(), sessionId)
}

/** Record of a deck (validates the id before touching the index). */
export async function getSlides(id: string): Promise<SlidesEntry | undefined> {
  if (!SAFE_SLIDES_ID.test(id)) return undefined
  return (await load())[id] ?? (await load(true))[id]
}

/** `orbit-slides://<id>/<entry>` URL of a REGISTERED deck. */
export async function registeredSlidesUrl(id: string): Promise<string | null> {
  const entry = await getSlides(id)
  return entry ? `${SLIDES_SCHEME}://${id}/${relativeEntry(entry)}` : null
}

/** Takes the deck out of the registry and releases its watcher. */
export async function unregisterSlides(id: string): Promise<void> {
  const entries = await load()
  if (!entries[id]) return
  delete entries[id]
  await persist()
  unwatchSlides(id)
}

export interface SlidesDeletion {
  removedFolder: boolean
  /** Why the folder was preserved (absent when it was deleted). */
  keptBecause?: string
}

/**
 * Deletes a deck for real: the folder, the registry and the watcher. Mirrors
 * `deleteMotionComposition`, with the same locks — deleting in the gallery frees
 * space, but it can never delete the project itself.
 *
 * The three refusal conditions are what separates "freeing space" from "destroying
 * the repository of whoever is working": the folder has to exist, contain the deck
 * entry, and be INSIDE the root of the chat or of the project that registered it —
 * never BE the project.
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
    // of Orbit's own storage
  } else if (entry.root && isStrictlyInside(entry.root, folder)) {
    // inside the project that registered it, and not the project itself
  } else {
    keptBecause = 'the folder is the project itself (or outside the working folder it was registered from)'
  }

  if (!keptBecause) {
    // In the agent's turn (slides_delete), the folder goes to the journal first.
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
 * What does NOT reload the stage: exports, temporaries and what the presentation
 * generates next to the deck. Pure — the tests cover the list.
 */
export function isSlidesSourceChange(filename: string | null | undefined): boolean {
  if (!filename) return true
  const name = filename.replace(/\\/g, '/')
  if (name.split('/').some((segment) => segment.startsWith('.slides-') || segment === '.render')) return false
  // Images do NOT go in the list: `assets/fundo.png` is a source of the deck, not output.
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
    // Linux does not support recursive watch: it falls back to the parent level (the deck is
    // one file per folder, in practice).
    try {
      watchers.set(id, fs.watch(folder, listener))
    } catch {
      // folder gone since registration — the protocol returns 404 right away.
    }
  }
}

/** Reconnects the watcher and reloads the tab after the folder was swapped entirely (revert). */
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
      // already closed
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
      // The deck is edited with the stage open: the cache would serve the old version and
      // the live reload would look like it is not working.
      'Cache-Control': 'no-store',
      ...(length === null ? {} : { 'Content-Length': String(length) }),
      ...extra,
    },
  })
}

/** Registers the protocol of the decks (call after app.whenReady). */
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
    // Reserved path: the script that builds the stage (see slides-runtime.ts). Before
    // the registry: a paired desktop's deck uses this machine's runtime too.
    if (url.pathname === SLIDES_RUNTIME_PATH) {
      return respond(SLIDES_RUNTIME, 'text/javascript; charset=utf-8')
    }
    const entry = await getSlides(id)
    if (!entry) {
      if (!isRemoteAsset(id)) return respond('not found', 'text/plain; charset=utf-8', 404)
      const rel = url.pathname.replace(/^\/+/, '')
      if ((/\.html?$/i.test(rel) || rel === '') && !url.searchParams.has('raw')) {
        const remote = await fetchRemoteText('slides', id, rel)
        if (!remote || remote.status !== 200) return respond('not found', 'text/plain; charset=utf-8', remote?.status ?? 404)
        return respond(injectSlidesRuntime(remote.text), 'text/html; charset=utf-8')
      }
      return (await fetchRemoteAsset('slides', id, rel, request)) ?? respond('not found', 'text/plain; charset=utf-8', 404)
    }
    const file = resolveSlidesFile(entry.folder, url.pathname)
    if (!file) return respond('not found', 'text/plain; charset=utf-8', 404)
    const ext = path.extname(file).toLowerCase()
    const type = CONTENT_TYPES[ext] ?? 'application/octet-stream'
    // The HTML comes out with the runtime in the <head>; `?raw` is the SOURCE as it is on disk
    // (what the tab's "view code" will one day show).
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
