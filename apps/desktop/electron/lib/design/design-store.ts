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
import { journalPath } from '../session/media-journal'
import { fetchRemoteAsset, fetchRemoteText, isRemoteAsset } from '../peers/remote-assets'

/**
 * Registry of the design canvases (an app FOLDER: `canvas.json` + one .html per
 * artboard) and the `orbit-design://` scheme that serves it.
 *
 * Mirrors video/motion-store.ts: the registry holds id → folder, nothing is copied,
 * and every served file is resolved INSIDE the registered folder. Unlike motion,
 * there is no injected runtime (the artboard is static: no timeline, no seek) nor a
 * media track — which is why the scheme here is a lot simpler.
 */

const SAFE_DESIGN_ID = /^dsg_[a-z0-9]+$/

/** Renderer channel for the live reload. */
export const DESIGN_CHANGED_CHANNEL = 'design:changed'

/** fs.watch debounce: the editor writes in bursts and we do not want N events. */
const WATCH_DEBOUNCE_MS = 150
/**
 * Debounce ceiling. During a generation the agent writes one screen after the other
 * without enough pause for the debounce to "close": without a ceiling, the notice
 * would only go out at the end of the burst (or would go out N times). With it, the
 * canvas refreshes at most every WATCH_MAX_WAIT_MS counted from the FIRST change.
 */
const WATCH_MAX_WAIT_MS = 400

export interface DesignEntry {
  /** Root folder of the canvas: the scheme serves nothing outside of it. */
  folder: string
  /** Working folder that registered it (reserved — today only chat mode registers). */
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

/** Canvas id: derived from the folder, not drawn at random — registering the same
 *  canvas again returns the SAME id, and the open tab stays valid. */
export function designIdFor(folder: string): string {
  const key = path.resolve(folder).toLowerCase()
  return `dsg_${createHash('sha1').update(key).digest('hex').slice(0, 16)}`
}

/** The canvas registered from the NAME it has in the conversation (chat mode). */
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

/** Comparable path: normalized separator, no leading `./`, lowercase. */
function normalize(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase()
}

/**
 * The canvas registered from the PATH the agent used in the preview (code mode:
 * the design_preview tool receives the canvas folder). Mirrors motionIdForPath —
 * same fallback by the END of the path when the agent sends a relative one that does
 * not resolve against the app cwd.
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
 * Resolves the path of an `orbit-design://<id>/<path>` URL inside the canvas
 * folder. Pure. Refuses an empty path, an absolute one, one with `..` or one that
 * escapes the folder after normalization — the same contract as resolveMotionFile.
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

/** Registers (or reuses) a canvas and returns the index URL. */
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

/** Canvas folders that Orbit itself keeps (chat mode) — deletable without
 *  asking permission from any project. */
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
 * Deletes a canvas: the folder, the registry entry and the watcher. Same lock as
 * motion — the folder is only deleted when it belongs to Orbit's storage (today,
 * always, since only chat mode registers), never a project's working folder.
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
    // of Orbit's own storage
  } else if (entry.root && isStrictlyInside(entry.root, folder)) {
    // inside the project that registered it, and not the project itself
  } else {
    keptBecause = 'the folder is outside the app storage it was registered from'
  }

  if (!keptBecause) {
    // In the agent's turn (design_delete), the folder goes to the journal first.
    await journalPath(folder, { kind: 'design', id, folder, root: entry.root, sessionId: entry.sessionId })
    await fsp.rm(folder, { recursive: true, force: true })
  }
  await unregisterDesign(id)
  return keptBecause ? { removedFolder: false, keptBecause } : { removedFolder: true }
}

// ------------------------------------------------------------ editing (IPC)
// What the Design tab writes when the PERSON edits in the canvas: the source of an
// artboard (properties, text, code) and its layout in canvas.json. The
// renderer sends only the id and the file name — the folder comes from the registry,
// and the name goes through the same lock as the tools (flat, .html, no path).

async function boardTarget(id: string, file: string): Promise<{ folder: string; target: string }> {
  const entry = await getDesign(id)
  if (!entry) throw new Error(`unknown design canvas: ${id}`)
  if (!isSafeBoardFile(file)) throw new Error(`invalid artboard file name: ${file}`)
  const target = resolveDesignFile(entry.folder, file)
  if (!target) throw new Error(`artboard outside the canvas folder: ${file}`)
  return { folder: entry.folder, target }
}

/** Rewrites the source of an artboard. */
export async function writeDesignBoard(id: string, file: string, html: string): Promise<void> {
  const { folder, target } = await boardTarget(id, file)
  // Same lock/atomic write as the design tools: the PERSON's edit in the canvas
  // and a design_edit from the agent on the same artboard do not interleave.
  await withAssetLock(`design:${folder}`, () => writeFileAtomic(target, html))
}

/** Reads the source of an artboard (without the bridge). */
export async function readDesignBoard(id: string, file: string): Promise<string> {
  const { target } = await boardTarget(id, file)
  return fsp.readFile(target, 'utf8')
}

/** Changes the layout (position, size, title) of an artboard in canvas.json. */
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
 * Pending changes per canvas. The debounce gathers the names fs.watch sent and sends
 * ONE message — with the LIST of files: it is what lets the Design tab reload only
 * the artboard that changed, instead of remounting all the iframes on every write
 * (see design-tab.tsx).
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
    // Waits for silence, but never beyond the ceiling counted from the first change.
    const wait = Math.max(0, Math.min(WATCH_DEBOUNCE_MS, pending.firstAt + WATCH_MAX_WAIT_MS - now))
    pending.timer = setTimeout(() => flushChanged(id), wait)
  }
  // Normalized separator: the renderer compares it with the names in canvas.json.
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
 * The watcher is the source of truth about what changed: forgetting the injected
 * document here covers the case where `mtime` and size repeat (a disk with
 * millisecond resolution and the same byte count). Without names, it forgets
 * everything that belongs to that folder.
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
  // The name comes relative to the folder (recursive) and it is what allows the surgical
  // reload; without it (or outside macOS, when the watcher does not report it), the
  // message goes out without a list and the tab reloads everything, as before.
  const listener = (_event: string, filename: string | Buffer | null) => {
    notifyChanged(id, filename ? filename.toString() : null)
  }
  try {
    watchers.set(id, fs.watch(folder, { recursive: true }, listener))
  } catch {
    try {
      watchers.set(id, fs.watch(folder, listener))
    } catch {
      // folder gone since registration — the protocol returns 404 right away.
    }
  }
}

/** Reconnects the watcher and reloads the tab after the folder was swapped entirely (revert). */
export async function rewatchDesign(id: string): Promise<void> {
  const entry = await getDesign(id)
  if (!entry) return
  watchDesign(id, entry.folder)
  notifyChanged(id, null)
}

export function unwatchDesign(id: string): void {
  const watcher = watchers.get(id)
  if (watcher) {
    try {
      watcher.close()
    } catch {
      // already closed
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
 * Document already with the bridge injected, per file. Each artboard mount cost
 * re-reading the disk, re-injecting the bridge and rebuilding the font CSS; in a tab
 * with several screens that multiplies. The validity is `mtime`/size + the version
 * of the font CSS (which changes when the library changes).
 */
interface InjectedDocument {
  mtimeMs: number
  size: number
  fontCss: string
  body: string
  etag: string
}

const injectedDocuments = new Map<string, InjectedDocument>()
/** Cache ceiling: a big canvas cannot become memory held forever. */
const INJECTED_DOCUMENTS_LIMIT = 64

async function injectedDocument(file: string, fontCss: string): Promise<InjectedDocument | null> {
  const stat = await fsp.stat(file).catch(() => null)
  if (!stat?.isFile()) return null
  const cached = injectedDocuments.get(file)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.fontCss === fontCss) {
    // Re-inserting keeps the use order: the first in the Map is the oldest.
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
    // ETag of the document ALREADY injected: it changes with the source and with the font
    // library, which is everything that goes into it.
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
      // The canvas is edited with the preview open: the cache would serve the old
      // version and the live reload would look like it is not working.
      'Cache-Control': 'no-store',
      ...(length === null ? {} : { 'Content-Length': String(length) }),
      ...extra,
    },
  })
}

/** Registers the protocol of the design canvases (call after app.whenReady). */
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
    // Reserved path: the selection/editing bridge (see design-runtime.ts). The
    // content is a build constant of the app and the URL carries its version
    // (`?v=`, see injectDesignRuntime): it can be stored forever, and
    // the iframe reuses the script already compiled across remounts. Before the
    // registry: a paired desktop's canvas uses this machine's bridge too.
    if (url.pathname === DESIGN_RUNTIME_PATH) {
      return respond(DESIGN_RUNTIME, 'text/javascript; charset=utf-8', 200, {
        'Cache-Control': 'public, max-age=31536000, immutable',
      })
    }
    const entry = await getDesign(id)
    if (!entry) {
      // A canvas of a paired desktop: files from there, the bridge and fonts from here.
      if (!isRemoteAsset(id)) return respond('not found', 'text/plain; charset=utf-8', 404)
      const rel = url.pathname.replace(/^\/+/, '')
      if (/\.html?$/i.test(rel) && !url.searchParams.has('raw')) {
        const remote = await fetchRemoteText('design', id, rel)
        if (!remote || remote.status !== 200) return respond('not found', 'text/plain; charset=utf-8', remote?.status ?? 404)
        return respond(injectDesignRuntime(remote.text, await allFontFacesCss()), 'text/html; charset=utf-8', 200, { 'Cache-Control': 'no-cache' })
      }
      return (await fetchRemoteAsset('design', id, rel, request)) ?? respond('not found', 'text/plain; charset=utf-8', 404)
    }
    const file = resolveDesignFile(entry.folder, url.pathname)
    if (!file) return respond('not found', 'text/plain; charset=utf-8', 404)
    const ext = path.extname(file).toLowerCase()
    const type = CONTENT_TYPES[ext] ?? 'application/octet-stream'
    // The artboard comes out with the bridge in the <head>; `?raw` is the SOURCE, as it is
    // on disk — it is what the code tab shows and what editing rewrites.
    if ((ext === '.html' || ext === '.htm') && !url.searchParams.has('raw')) {
      // Orbit's font library goes into EVERY artboard (see
      // injectDesignRuntime): the installed family is used by name.
      const artboard = await injectedDocument(file, await allFontFacesCss())
      if (!artboard) return respond('file moved or deleted', 'text/plain; charset=utf-8', 404)
      // `no-cache` = may store, but always revalidates: the canvas is edited with the
      // tab open and serving the old version would look like the reload is not working.
      // With the ETag of the injected document, a remount without changes becomes a 304.
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
