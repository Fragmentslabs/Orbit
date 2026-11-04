import { app, BrowserWindow, protocol } from 'electron'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { MOTION_SCHEME } from '@shared/media'
import { resolveSafePath, type ToolContext } from '../tools/context'
import {
  isAlphaFormat,
  motionFormatExt,
  normalizeMotionFormat,
  type MotionFormatInput,
  type MotionQuality,
} from './motion-render-args'
import { renderMotion } from './motion'
import { MOTION_RUNTIME, MOTION_RUNTIME_PATH, injectMotionRuntime } from './motion-runtime'
import { PROPS_QUERY, propsForPage } from './motion-props'
import { MOTION_THREE_PREFIX, findThreeRoot, resolveThreeFile } from './motion-three'
import { MOTION_THREE_HELPER, MOTION_THREE_HELPER_PATH } from './motion-three-helper'
import { journalPath } from '../session/media-journal'

/**
 * Registry of motion compositions (a project FOLDER with an entry
 * file and relative dependencies) and the `orbit-motion://` scheme that serves it.
 *
 * It mirrors video/store.ts: the registry keeps id → folder + entry, nothing is
 * copied, and every served file is resolved INSIDE the registered folder — `..`,
 * absolute path and escaping the folder are refused. The preview (panel tab) and
 * the render via IPC read from here.
 *
 * Why a scheme, and not file://: a page at file:// has an opaque origin, without
 * CORS and without modules; served by a standard+secure+corsEnabled scheme, the
 * `<script type="module">` and the composition's @font-face work. That is why
 * EVERY response carries Access-Control-Allow-Origin: *.
 */

const SAFE_MOTION_ID = /^mv_[a-z0-9]+$/

/** Renderer channel for live reload. */
export const MOTION_CHANGED_CHANNEL = 'motion:changed'
/** Renderer channel for the render progress. */
export const MOTION_PROGRESS_CHANNEL = 'motion:render:progress'

/** fs.watch debounce: the editor writes in bursts and we do not want N events. */
const WATCH_DEBOUNCE_MS = 150

export interface MotionEntry {
  /** Root folder of the composition: the scheme serves nothing outside it. */
  folder: string
  /** Entry file (absolute), always inside `folder`. */
  entry: string
  /** Working folder that registered it — revalidated when the panel asks for a render. */
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
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  // Every extension the render accepts as a track must play in the
  // preview: an audio the render muxes and the tab does not open would be half a truth.
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
}

function indexFile(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'motion.json')
}

let index: Record<string, MotionEntry> | null = null

async function load(fresh = false): Promise<Record<string, MotionEntry>> {
  if (index && !fresh) return index
  try {
    const disk = JSON.parse(await fsp.readFile(indexFile(), 'utf8')) as Record<string, MotionEntry>
    // Re-read: what is in memory and not yet written cannot vanish.
    index = fresh && index ? { ...disk, ...index } : disk
  } catch {
    index = index ?? {}
  }
  return index
}

/**
 * Composition id: derived from the folder + entry, not drawn at random. Registering the
 * same composition again (the reopened preview, motion_frame, the render) returns the
 * SAME id — the open tab keeps pointing at a valid URL, instead of
 * getting stuck on an id that another step replaced or released.
 */
export function motionIdFor(folder: string, entry: string): string {
  const key = `${path.resolve(folder).toLowerCase()}|${path.resolve(entry).toLowerCase()}`
  return `mv_${createHash('sha1').update(key).digest('hex').slice(0, 16)}`
}

/**
 * The piece registered from the path the agent used in the preview.
 *
 * It is what the chat card has at hand: the tool's `input.path`, which may be the
 * composition's folder or the entry HTML. The renderer knows no id at all —
 * whoever knows how to translate a path into a piece is the registry, here.
 */
export async function motionIdForPath(target: string): Promise<string | null> {
  const wanted = path.resolve(target).toLowerCase()
  const entries = await load(true)
  for (const [id, entry] of Object.entries(entries)) {
    if (path.resolve(entry.entry).toLowerCase() === wanted) return id
    if (path.resolve(entry.folder).toLowerCase() === wanted) return id
  }
  // The agent usually gives the path RELATIVE to the session's folder (it is what the tool
  // receives), and here there is no session to resolve against: `path.resolve` would land in the
  // app's cwd and would not match anything. The END of the path still tells the piece apart —
  // the registry is short, one folder per composition —, and the leading slash prevents
  // `…/intro` from matching `…/orbit-intro`.
  const tail = normalize(target)
  if (!tail.includes("/")) return null
  for (const [id, entry] of Object.entries(entries)) {
    if (normalize(entry.entry).endsWith(`/${tail}`)) return id
    if (normalize(entry.folder).endsWith(`/${tail}`)) return id
  }
  return null
}

/** Comparable path: normalized separator, no leading `./`, lowercase. */
function normalize(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase()
}

/**
 * The piece registered from the NAME the composition has in the conversation.
 *
 * It is the case of CHAT mode: `motion_write({ name, html })` has no path at all
 * in `input`, only the name — the composition lives in Orbit's storage, one folder
 * per conversation, and the folder carries the slug of the name. The card sends the name the tool
 * reported (already normalized) and the session; whoever knows which folder it landed in is the
 * registry. The session is part of the key because the same name in two conversations
 * are two different pieces.
 */
export async function motionIdForName(sessionId: string, name: string): Promise<string | null> {
  const wanted = name.trim().toLowerCase()
  if (!wanted) return null
  const entries = await load(true)
  for (const [id, entry] of Object.entries(entries)) {
    if (entry.sessionId !== sessionId) continue
    if (path.basename(entry.folder).toLowerCase() === wanted) return id
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

/**
 * Resolves the path of an `orbit-motion://<id>/<path>` URL inside the composition's
 * folder. Pure. Refuses an empty path, absolute (including `C:\…`), with
 * `..` in any position or that escapes the folder after normalization.
 */
export function resolveMotionFile(folder: string, relative: string): string | null {
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

/** Relative (with `/`) path of the entry file with respect to the folder. */
function relativeEntry(entry: MotionEntry): string {
  return path
    .relative(entry.folder, entry.entry)
    .split(path.sep)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

/**
 * Folder + entry of the composition from what the caller has at hand: the pair
 * (folder, entry) or only the entry path (the folder is the one containing it; if it is
 * a folder, the entry is its index.html).
 */
async function resolveComposition(target: string, entry?: string): Promise<{ folder: string; entry: string }> {
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

/**
 * Registers (or reuses) a composition and returns the preview URL. The
 * entry has to be inside the folder — that is what authorizes the scheme to serve
 * its files.
 */
export async function registerMotion(
  folder: string,
  entry?: string,
  opts: { root?: string; sessionId?: string } = {},
): Promise<{ id: string; url: string; created: boolean }> {
  const composition = await resolveComposition(folder, entry)
  const dir = composition.folder
  const file = composition.entry
  if (!isInside(dir, file)) {
    throw new Error(`motion entry ${file} is outside the composition folder ${dir}`)
  }
  const entries = await load()
  const id = motionIdFor(dir, file)
  const existing = entries[id]
  if (existing) {
    // Whoever registers it again (another session, the tool with the working folder)
    // updates the owner, without changing the id nor tearing down the watcher.
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
  if (!watchers.has(id)) watchMotion(id, dir)
  return { id, url: `${MOTION_SCHEME}://${id}/${relativeEntry(entries[id])}`, created: !existing }
}

/** Registry record of a composition (validates the id before touching the index). */
export async function getMotion(id: string): Promise<MotionEntry | undefined> {
  if (!SAFE_MOTION_ID.test(id)) return undefined
  // Not found in memory: re-reads the disk before saying "it does not exist" — a 404
  // here leaves the tab without a composition, and the cost of re-reading is a small file.
  return (await load())[id] ?? (await load(true))[id]
}

/**
 * `orbit-motion://<id>/<entry>` URL of a REGISTERED composition. It is through it that
 * the render loads the composition (motion.ts) — the same path as the preview, with the
 * runtime as the first script of the `<head>`.
 */
export async function registeredMotionUrl(id: string): Promise<string | null> {
  const entry = await getMotion(id)
  return entry ? `${MOTION_SCHEME}://${id}/${relativeEntry(entry)}` : null
}

/**
 * URL of the composition's AUDIO in the scheme: it is through here that the tab plays the piece with sound,
 * through the same path that serves the folder (nothing is copied anywhere).
 * `null` when the file is OUTSIDE the folder — the scheme serves nothing outside the
 * composition, so the render muxes by the absolute path and the preview is left without sound.
 */
export function motionAudioUrl(id: string, relative: string | null): string | null {
  return relative ? `${MOTION_SCHEME}://${id}/${relative}` : null
}

/**
 * The compositions of a CONVERSATION — what the piece card in the chat needs to know
 * in order to gather its files: the folder and the entry file.
 *
 * Only the ones that chat mode keeps (`sessionId` written in the registry): a
 * project piece registered from another conversation is not this one's business.
 */
export async function motionPiecesForSession(
  sessionId: string,
): Promise<Array<{ id: string; folder: string; entry: string }>> {
  const entries = await load(true)
  return Object.entries(entries)
    .filter(([, entry]) => entry.sessionId === sessionId)
    .map(([id, entry]) => ({ id, folder: entry.folder, entry: entry.entry }))
}

/** Removes the composition from the registry and releases its watcher. */
export async function unregisterMotion(id: string): Promise<void> {
  const entries = await load()
  if (!entries[id]) return
  delete entries[id]
  await persist()
  unwatchMotion(id)
  // The origin of the files dies with the piece: reopening the same folder later creates
  // a NEW piece, which did not inherit the previous one's `aud_…`. The import is late
  // because motion-files reads this registry.
  const files = await import('./motion-files').catch(() => null)
  await files?.forgetMotionFiles(id).catch(() => {})
}

/**
 * Composition folders that Orbit itself keeps (chat mode). Everything that lives
 * here is its own — it can be deleted without asking anyone's project for permission.
 */
function chatCompositionsRoot(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'motion')
}

/** Is `child` strictly INSIDE `parent` (never equal to it)? */
function isStrictlyInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

export interface MotionDeletion {
  /** The composition's folder was deleted from disk. */
  removedFolder: boolean
  /** Why the folder stayed, when it did (the piece leaves the registry anyway). */
  keptBecause?: string
}

/**
 * Deletes a composition: its FOLDER, the registry and the watcher.
 *
 * Deleting in the gallery is freeing space, so the folder goes away — but a project
 * folder belongs to the user, and the registry only knows what the agent declared. The
 * locks: the folder has to be the real composition (contain the entry
 * file) and be INSIDE a place this app may clean — the
 * chat mode storage, or strictly inside the working folder that
 * registered the piece. A composition that IS the working folder (index.html at the root
 * of the project) never deletes the folder: it only leaves the registry. The rendered videos
 * stay outside the composition's folder (edit/renders) and are not touched.
 */
export async function deleteMotionComposition(id: string): Promise<MotionDeletion> {
  const entry = await getMotion(id)
  if (!entry) return { removedFolder: false, keptBecause: 'not registered' }
  const folder = path.resolve(entry.folder)

  let keptBecause: string | undefined
  const stat = await fsp.stat(folder).catch(() => null)
  const hasEntry = await fsp.stat(entry.entry).then((s) => s.isFile()).catch(() => false)
  if (!stat?.isDirectory()) {
    keptBecause = 'the folder no longer exists'
  } else if (!hasEntry) {
    keptBecause = 'the folder does not contain the composition entry'
  } else if (isStrictlyInside(chatCompositionsRoot(), folder)) {
    // from Orbit
  } else if (entry.root && isStrictlyInside(entry.root, folder)) {
    // inside the project that registered it, and not the project itself
  } else {
    keptBecause = 'the folder is the project itself (or outside the working folder it was registered from)'
  }

  if (!keptBecause) {
    // In the agent's turn (motion_delete), the folder goes to the journal beforehand: the
    // revert of the message brings it back and registers it again.
    await journalPath(folder, { kind: 'motion', id, folder, entry: entry.entry, root: entry.root, sessionId: entry.sessionId })
    await fsp.rm(folder, { recursive: true, force: true })
  }
  await unregisterMotion(id)
  return keptBecause ? { removedFolder: false, keptBecause } : { removedFolder: true }
}

// ------------------------------------------------------------------ watcher
// Live reload: the watcher only exists while the id is registered.
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
        if (!win.isDestroyed()) win.webContents.send(MOTION_CHANGED_CHANNEL, { id })
      }
    }, WATCH_DEBOUNCE_MS),
  )
}

/**
 * What does NOT reload the preview: rendered videos, the
 * render's temporary folder and work files. Without this filter, a render written inside the
 * composition's folder reloaded the tab at every piece written. Pure.
 */
export function isMotionSourceChange(filename: string | null | undefined): boolean {
  if (!filename) return true
  const name = filename.replace(/\\/g, '/')
  if (name.split('/').some((segment) => segment.startsWith('.motion-') || segment === '.render' || segment.startsWith('.render-'))) return false
  return !/\.(mp4|mov|webm|mkv|m4v|tmp|part|crdownload)$/i.test(name)
}

function watchMotion(id: string, folder: string): void {
  unwatchMotion(id)
  const listener = (_event: string, filename: string | Buffer | null) => {
    if (isMotionSourceChange(filename == null ? null : String(filename))) notifyChanged(id)
  }
  try {
    watchers.set(id, fs.watch(folder, { recursive: true }, listener))
  } catch {
    // Linux does not support recursive watch: it falls back to the top level (the entry and
    // the loose files of the folder, which is what the composition really edits).
    try {
      watchers.set(id, fs.watch(folder, listener))
    } catch {
      // the folder vanished since registration — the protocol answers 404 right away.
    }
  }
}

/**
 * Reconnects the watcher and tells the tab to reload — after the folder was replaced
 * whole (the revert deletes it and puts the copy back, and the old watcher died
 * with the folder it was watching).
 */
export async function rewatchMotion(id: string): Promise<void> {
  const entry = await getMotion(id)
  if (!entry) return
  watchMotion(id, entry.folder)
  notifyChanged(id)
}

export function unwatchMotion(id: string): void {
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

function respond(
  body: BodyInit | null,
  type: string,
  status = 200,
  extra: Record<string, string> = {},
): Response {
  // A stream body has no known length: whoever builds it gives the
  // `Content-Length` in `extra` (it is the size of the RANGE, not of the file).
  const length =
    typeof body === 'string' ? Buffer.byteLength(body) : body instanceof Uint8Array ? body.byteLength : null
  return new Response(body, {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': type,
      // The composition is edited with the preview open: cache would serve the old
      // version and the live reload would seem not to work.
      'Cache-Control': 'no-store',
      // It is THIS line that tells Chromium the resource accepts repositioning.
      // Without it an <audio> of the piece still plays (the flow is sequential), but
      // `currentTime` becomes a suggestion: pausing and coming back restarts from zero.
      'Accept-Ranges': 'bytes',
      ...(length === null ? {} : { 'Content-Length': String(length) }),
      ...extra,
    },
  })
}

/**
 * What Chromium loads as MEDIA (the piece's `<audio>`/`<video>`). Only these
 * files are exempt from `no-store` — see `respondMedia`.
 */
const MEDIA_EXTENSIONS = new Set([
  '.mp3',
  '.m4a',
  '.aac',
  '.wav',
  '.ogg',
  '.oga',
  '.opus',
  '.flac',
  '.mp4',
  '.webm',
  '.mov',
])

/**
 * MEDIA response (the piece's `<audio>`/`<video>`): `respond` WITHOUT `Cache-Control`.
 *
 * `no-store` exists for live reload — the composition is edited with the
 * preview open, and cache would serve the old bytes. But it is poison for
 * media: without being able to keep what it already downloaded, the element redoes the request at every
 * repositioning. While the scheme did not announce ranges this did not show up
 * (every request was sequential, and the seek was ignored); now that it announces — and
 * Chromium really REPOSITIONS — every seek discarded the buffer and re-downloaded
 * the file, and the sound stuttered instead of playing. That is why `video/store.ts`
 * and `audio-store.ts`, which have always played fine, do not send that header.
 *
 * Live reload loses nothing: the preview puts `?r=` in the media URL too,
 * so the regenerated voice arrives through a new URL.
 *
 * It only applies to `MEDIA_EXTENSIONS`. The composition's JS/CSS/image is requested by
 * the SAME URL at every reload, and for those `no-store` keeps being what makes the
 * edit show up.
 */
function respondMedia(
  body: BodyInit | null,
  type: string,
  status: number,
  extra: Record<string, string>,
): Response {
  return new Response(body, {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      ...extra,
    },
  })
}

/** Registers the protocol of the compositions (call after app.whenReady). */
export function registerMotionProtocol(): void {
  protocol.handle(MOTION_SCHEME, async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return respond('bad url', 'text/plain; charset=utf-8', 400)
    }
    const id = decodeURIComponent(url.host)
    if (!SAFE_MOTION_ID.test(id)) return respond('not found', 'text/plain; charset=utf-8', 404)
    const entry = await getMotion(id)
    if (!entry) return respond('not found', 'text/plain; charset=utf-8', 404)
    // Reserved path: the runtime script, the same one the render injects.
    if (url.pathname === MOTION_RUNTIME_PATH) {
      return respond(MOTION_RUNTIME, 'text/javascript; charset=utf-8')
    }
    // Reserved path: the three.js the app ships (the import map points here).
    if (url.pathname === MOTION_THREE_PREFIX + MOTION_THREE_HELPER_PATH) {
      return respond(MOTION_THREE_HELPER, 'text/javascript; charset=utf-8')
    }
    if (url.pathname.startsWith(MOTION_THREE_PREFIX)) {
      const root = findThreeRoot(app.getAppPath())
      const three = root ? resolveThreeFile(root, url.pathname) : null
      const text = three ? await fsp.readFile(three, 'utf8').catch(() => null) : null
      if (text === null) return respond('not found', 'text/plain; charset=utf-8', 404)
      return respond(text, 'text/javascript; charset=utf-8')
    }
    const file = resolveMotionFile(entry.folder, url.pathname)
    if (!file) return respond('not found', 'text/plain; charset=utf-8', 404)
    const ext = path.extname(file).toLowerCase()
    const type = CONTENT_TYPES[ext] ?? 'application/octet-stream'
    // The HTML does not come out as it is: the runtime enters the <head>, so the body is no longer
    // the file and the range does not apply.
    if (ext === '.html' || ext === '.htm') {
      const html = await fsp.readFile(file, 'utf8').catch(() => null)
      if (html === null) return respond('file moved or deleted', 'text/plain; charset=utf-8', 404)
      // The props of this page: props.json defaults + the overrides the render put in the URL.
      const props = await propsForPage(entry.folder, url.searchParams.get(PROPS_QUERY)).catch(() => null)
      return respond(injectMotionRuntime(html, MOTION_SCHEME, id, props), type)
    }
    const size = await fsp
      .stat(file)
      .then((stat) => (stat.isFile() ? stat.size : null))
      .catch(() => null)
    if (size === null) return respond('file moved or deleted', 'text/plain; charset=utf-8', 404)
    const stream = (start: number, end: number) =>
      Readable.toWeb(fs.createReadStream(file, { start, end })) as unknown as ReadableStream
    // Only media loses the `no-store` (see `respondMedia`): for everything else it
    // keeps being what makes the live reload show the edit.
    const send = MEDIA_EXTENSIONS.has(ext) ? respondMedia : respond
    // Range (the same response video/store.ts gives to <video>): it is through here that
    // Chromium REPOSITIONS the piece's narration in the preview. Without this response the
    // resource is treated as non-seekable — the sound plays at the right minute, but
    // pausing in the middle and coming back restarts the file from zero.
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '')
    if (range) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2] || 0))
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
      if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || start > end) {
        return respond(null, 'text/plain; charset=utf-8', 416, { 'Content-Range': `bytes */${size}` })
      }
      return send(stream(start, end), type, 206, {
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`,
      })
    }
    return send(size > 0 ? stream(0, size - 1) : new Uint8Array(0), type, 200, {
      'Content-Length': String(size),
    })
  })
}

// -------------------------------------------------------------- render (IPC)
export interface MotionRenderRequest {
  /**
   * Intended output: `mp4` (H.264), `mov-alpha` (ProRes 4444 with alpha) or
   * `webm-alpha` (VP9 with alpha). The old names (`mov`, `webm`) are still
   * accepted. Frozen contract with the panel tab (see src/lib/ipc.ts).
   */
  format?: MotionFormatInput
  /** Output path relative to the working folder (default: render.<ext>). */
  output?: string
  /**
   * ABSOLUTE destination chosen by the PERSON in the native dialog — the render of the
   * panel tab.
   *
   * Unlike `output`, it does not go through resolveSafePath: it was chosen by the
   * owner of the machine, in a system dialog, and the write may legitimately
   * fall outside the project folders. `output` keeps being the
   * AGENT's path, and that is why it stays bound to the authorized roots.
   */
  saveAs?: string
  /** Redundant with the `-alpha` formats, but it still holds for the old ones. */
  transparent?: boolean
  /** Parallel tracks; 1 = sequential (deterministic). */
  bands?: number
  width?: number
  height?: number
  fps?: number
  duration?: number
  /** File weight (encoder CRF/preset); without it, the usual `balanced`. */
  quality?: MotionQuality
  /** Also write the track alone, in WAV, next to the video. */
  separateAudio?: boolean
}

export interface MotionRenderResult {
  id: string
  /** Absolute path of the rendered file. */
  path: string
  width: number
  height: number
  fps: number
  duration: number
  frames: number
  /** WAV of the track, when the render asked for separate audio and the piece has sound. */
  audioPath?: string
}

/**
 * The NAME of the piece's video file, already with the extension of the requested format.
 *
 * It is the COMPOSITION's name — the same word the person reads in the tab and on the
 * gallery card. A fixed `render.mp4` made the video be born anonymous: either it was renamed by
 * hand, or later nobody knew which composition it belonged to. The FOLDER does not live here: the
 * main's save dialog (export-dialog) starts in the last folder the person
 * used, and not inside the piece's internal storage.
 * `null` when the composition is no longer registered.
 */
export async function motionOutputName(
  id: string,
  format?: MotionFormatInput,
): Promise<string | null> {
  const entry = await getMotion(id)
  if (!entry) return null
  const base = path.basename(entry.folder).replace(/[\\/:*?"<>|]/g, '-').trim() || 'render'
  return `${base}${motionFormatExt(normalizeMotionFormat(format, false))}`
}

/**
 * Renders a REGISTERED composition (what the `motion:render` IPC calls). The
 * panel sends only the id; even so the entry file is revalidated with
 * resolveSafePath (the same check as the tool) against the root that registered it, otherwise
 * a tampered registry on disk would become a render of arbitrary HTML.
 *
 * It does not touch the inside of the render: it only passes the options on and the
 * progress callback.
 */
export async function renderRegisteredMotion(
  id: string,
  req: MotionRenderRequest = {},
  onProgress?: (frame: number, total: number) => void,
): Promise<MotionRenderResult> {
  const entry = await getMotion(id)
  if (!entry) throw new Error(`unknown motion composition: ${id}`)
  // The composition folder is the allowed root; the working folder that
  // registered it comes in as an extra folder in case the composition came from
  // an attached folder (the same list of roots the tool used).
  const ctx: ToolContext = {
    sessionId: entry.sessionId ?? '',
    directory: entry.folder,
    extraDirectories: entry.root ? [entry.root] : [],
    abort: new AbortController().signal,
  }
  const file = resolveSafePath(ctx, entry.entry)
  if (!isInside(entry.folder, file)) {
    throw new Error(`motion entry ${file} escaped its composition folder`)
  }
  // The format is the ONLY encoder decision (alpha comes from the name: `-alpha`).
  const format = normalizeMotionFormat(req.format, Boolean(req.transparent))
  const alpha = isAlphaFormat(format)
  if (req.transparent && !alpha) {
    throw new Error('transparent render needs format "mov-alpha" (ProRes 4444) or "webm-alpha" (VP9 with alpha)')
  }
  const output = req.saveAs
    ? path.resolve(req.saveAs)
    : req.output
      ? resolveSafePath(ctx, req.output)
      : path.join(entry.folder, `render${motionFormatExt(format)}`)
  await fsp.mkdir(path.dirname(output), { recursive: true })
  const result = await renderMotion({
    // It is already registered: the render does not register it again nor release it at the end.
    id,
    file,
    output,
    format,
    transparent: alpha,
    bands: req.bands,
    width: req.width,
    height: req.height,
    fps: req.fps,
    duration: req.duration,
    quality: req.quality,
    separateAudio: req.separateAudio,
    onProgress,
  })
  return {
    id,
    path: output,
    width: result.width,
    height: result.height,
    fps: result.fps,
    duration: result.duration,
    frames: result.frames,
    ...(result.audioPath ? { audioPath: result.audioPath } : {}),
  }
}
