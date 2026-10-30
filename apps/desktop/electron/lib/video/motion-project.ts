import fsp from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { getMotion, registerMotion } from './motion-store'
import { piecesDir, pieceSlug } from '../tools/piece-paths'

/**
 * The PROJECT of a composition: the whole folder in a `.zip`, and back.
 *
 * A motion piece is a folder of the app — the HTML, the media that came in, the
 * fonts, the `audio.json`. It does not leave there by itself: the render delivers the VIDEO,
 * never the piece. Without this, taking a composition from one conversation to another (or
 * saving it before cleaning the disk) meant copying files by hand.
 *
 * The `.zip` carries an `orbit.json` manifest at the root — it is what makes a renamed
 * file still be recognized as a piece, and not as any zip.
 * On the way back, nothing is overwritten: the imported piece is born with a new id in a new
 * folder, and the same zip can be imported as many times as wanted, each time as
 * an independent piece.
 */

export const MOTION_PROJECT_MANIFEST = 'orbit.json'

/** Format version. A zip of a future version is refused with the reason. */
export const MOTION_PROJECT_VERSION = 1

/**
 * Zip ceiling: above this the import through the chat gets expensive (the file travels
 * as an attachment) and it is more honest to refuse than to drag the conversation for minutes.
 */
export const MAX_PROJECT_ZIP_BYTES = 256 * 1024 * 1024
/** Ceiling on what comes out of the zip (protection against a decompression bomb). */
export const MAX_PROJECT_BYTES = 1024 * 1024 * 1024
/** Deliberately useless ceiling: no piece has that many files. */
export const MAX_PROJECT_FILES = 400

export interface MotionProjectManifest {
  kind: 'orbit-motion-project'
  version: number
  name: string
  createdAt: number
  entry: string
  /** The format declared in the composition, for whoever wants to know before opening. */
  format: { width?: number; height?: number; fps?: number; durationInFrames?: number } | null
  /** The files the zip carries, relative to its root (the manifest included). */
  files: string[]
}

/** Extensions that travel compressed; media is already compressed and goes stored. */
const TEXT_EXTENSIONS = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.svg', '.txt', '.srt', '.vtt'])
const MAX_DEPTH = 4

/** `<meta name="orbit-motion" content="width=…,fps=…,duration=…">` → format. */
export function motionFormatOf(html: string): MotionProjectManifest['format'] {
  const tag = /<meta\s+name=["']orbit-motion["']\s+content=["']([^"']*)["']/i.exec(html)
  if (!tag) return null
  const spec: { width?: number; height?: number; fps?: number; durationInFrames?: number } = {}
  for (const pair of tag[1].split(/[,;]/)) {
    const [key, raw] = pair.split('=').map((value) => value.trim())
    const num = Number(raw)
    if (!Number.isFinite(num) || num <= 0) continue
    if (key === 'width' || key === 'height' || key === 'fps') spec[key] = num
    if (key === 'duration') spec.durationInFrames = Math.round(num * (spec.fps ?? 30))
  }
  return Object.keys(spec).length ? spec : null
}

/** Relative name inside the folder, with `/`, without escaping it. */
function relativeName(root: string, target: string): string | null {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.split(path.sep).join('/')
}

/** The piece folder's files (all of them — the zip carries the whole piece). */
async function listProjectFiles(
  root: string,
  dir = root,
  depth = 0,
  out: string[] = [],
): Promise<string[]> {
  if (depth > MAX_DEPTH || out.length >= MAX_PROJECT_FILES) return out
  let items: Dirent[]
  try {
    items = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const item of items) {
    if (out.length >= MAX_PROJECT_FILES) break
    // `.motion-*` is the editor's temporary file, `.DS_Store` is Finder's: none of it
    // is the piece.
    if (item.name.startsWith('.')) continue
    const abs = path.join(dir, item.name)
    if (item.isDirectory()) {
      await listProjectFiles(root, abs, depth + 1, out)
      continue
    }
    if (!item.isFile()) continue
    // Always relative to the piece's ROOT (`fonts/inter.woff2`), subfolders
    // included — it is this path the zip stores and the import recreates.
    const rel = relativeName(root, abs)
    if (rel) out.push(rel)
  }
  return out
}

/**
 * Builds the composition's `.zip`: the whole folder + `orbit.json` at the root.
 *
 * The manifest is written RIGHT NOW (never whatever is on disk), so the name and the
 * format always match the piece being exported.
 */
export async function exportMotionProject(id: string): Promise<{ buffer: Buffer; name: string; files: number }> {
  const entry = await getMotion(id)
  if (!entry) throw new Error('this composition is no longer registered — open it again before saving the project')
  const folder = entry.folder
  const stats = await fsp.stat(folder).catch(() => null)
  if (!stats?.isDirectory()) throw new Error(`the composition folder is gone: ${folder}`)

  const names = await listProjectFiles(folder)
  if (!names.length) throw new Error('the composition folder is empty')
  const archive: Record<string, [Uint8Array, { level: 0 | 6 }]> = {}
  for (const name of names) {
    const abs = path.join(folder, name)
    const data = await fsp.readFile(abs).catch(() => null)
    if (!data) continue
    const level = TEXT_EXTENSIONS.has(path.extname(name).toLowerCase()) ? 6 : 0
    archive[name] = [new Uint8Array(data), { level }]
  }
  const entryName = relativeName(folder, entry.entry) ?? 'index.html'
  if (!archive[entryName]) throw new Error(`the composition entry is missing: ${entryName}`)
  const html = await fsp.readFile(entry.entry, 'utf8').catch(() => '')
  const manifest: MotionProjectManifest = {
    kind: 'orbit-motion-project',
    version: MOTION_PROJECT_VERSION,
    name: path.basename(folder),
    createdAt: Date.now(),
    entry: entryName,
    format: motionFormatOf(html),
    files: [MOTION_PROJECT_MANIFEST, ...Object.keys(archive).sort()],
  }
  archive[MOTION_PROJECT_MANIFEST] = [strToU8(JSON.stringify(manifest, null, 2)), { level: 6 }]
  const buffer = Buffer.from(zipSync(archive, { level: 6 }))
  return { buffer, name: `${manifest.name}.zip`, files: manifest.files.length }
}

/** What the zip declares, without decompressing any media at all. */
interface ZipScan {
  /** Name of each file entry (directory entries excluded). */
  names: string[]
  /** Declared sum of the decompressed content. */
  bytes: number
}

/**
 * Reads the zip's DIRECTORY (names and declared sizes), without inflating the content.
 *
 * It is what allows refusing a decompression bomb before it happens: the
 * original size comes in the header and fflate's `filter` decides entry by
 * entry, before the inflate.
 */
function scanZip(data: Uint8Array): ZipScan {
  const names: string[] = []
  let bytes = 0
  unzipSync(data, {
    filter: (file) => {
      if (!file.name.endsWith('/')) {
        names.push(file.name)
        bytes += file.originalSize ?? 0
      }
      return false
    },
  })
  return { names, bytes }
}

/** Is it a zip? (signature, like the skills import.) */
export function isZip(buffer: Buffer | Uint8Array): boolean {
  return buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b
}

/**
 * The manifest of a piece zip, or `null` when the file is not a motion
 * project. It is the question the chat asks of every `.zip` attachment before deciding what
 * to do with it — a regular zip follows the usual attachment path.
 */
export function readMotionProject(buffer: Buffer): MotionProjectManifest | null {
  if (!isZip(buffer)) return null
  const data = new Uint8Array(buffer)
  let scan: ZipScan
  try {
    scan = scanZip(data)
  } catch {
    return null
  }
  const manifestName = scan.names
    .filter((name) => {
      const clean = name.replace(/\\/g, '/')
      return clean.split('/').pop()?.toLowerCase() === MOTION_PROJECT_MANIFEST
    })
    .sort((a, b) => a.split('/').length - b.split('/').length)[0]
  if (!manifestName) return null
  let raw: string
  try {
    const entries = unzipSync(data, { filter: (file) => file.name === manifestName })
    raw = strFromU8(entries[manifestName])
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<MotionProjectManifest>
    if (parsed.kind !== 'orbit-motion-project') return null
    if (typeof parsed.version !== 'number' || parsed.version > MOTION_PROJECT_VERSION) return null
    if (typeof parsed.entry !== 'string' || !parsed.entry.trim()) return null
    return {
      kind: 'orbit-motion-project',
      version: parsed.version,
      name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : 'motion',
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
      entry: parsed.entry,
      format: parsed.format ?? null,
      files: Array.isArray(parsed.files) ? parsed.files.filter((f): f is string => typeof f === 'string') : [],
    }
  } catch {
    return null
  }
}

/**
 * SAFE relative path of a zip entry. Returns `null` for what
 * would try to escape the folder (absolute, `..`, empty name) or is not a file of the
 * piece (system junk, the manifest itself).
 */
export function safeZipEntry(rootPrefix: string, name: string): string | null {
  const clean = name.replace(/\\/g, '/')
  if (!clean.startsWith(rootPrefix)) return null
  const rel = clean.slice(rootPrefix.length)
  if (!rel || rel.endsWith('/')) return null
  if (rel.startsWith('/') || path.isAbsolute(rel)) return null
  const segments = rel.split('/')
  if (segments.some((part) => !part || part === '.' || part === '..')) return null
  const base = segments[segments.length - 1]
  if (base.startsWith('.') || segments[0] === '__MACOSX') return null
  if (segments.length === 1 && base.toLowerCase() === MOTION_PROJECT_MANIFEST) return null
  if (segments.length > MAX_DEPTH + 1) return null
  return rel
}

/** First free folder with that name (`intro`, `intro-2`, `intro-3`…). */
async function uniqueFolder(root: string, name: string): Promise<string> {
  for (let attempt = 1; attempt < 200; attempt++) {
    const folder = path.join(root, attempt === 1 ? name : `${name}-${attempt}`)
    const exists = await fsp.stat(folder).then(() => true).catch(() => false)
    if (!exists) return folder
  }
  throw new Error('too many compositions with this name — rename the project before importing')
}

export interface ImportedMotionProject {
  id: string
  /** Name of the piece (the folder) — it is how the tools call it in the conversation. */
  name: string
  folder: string
  entry: string
  files: number
  bytes: number
  /** How many files declared in the zip did not come in (system junk). */
  skipped: number
}

/**
 * Recreates the piece from the zip, in a NEW folder of this conversation.
 *
 * Nothing is overwritten: the name gets a suffix when it already exists (`intro-2`) and the id
 * is born from the new folder, so importing the same zip twice gives two
 * independent pieces — which is what one expects from "import".
 */
export async function importMotionProject(
  buffer: Buffer,
  opts: { sessionId: string },
): Promise<ImportedMotionProject> {
  if (buffer.byteLength > MAX_PROJECT_ZIP_BYTES) {
    throw new Error(
      `the .zip is too large to import through the chat (${Math.round(buffer.byteLength / 1024 / 1024)} MB; the limit is ${MAX_PROJECT_ZIP_BYTES / 1024 / 1024} MB)`,
    )
  }
  const manifest = readMotionProject(buffer)
  if (!manifest) throw new Error(`the .zip is not a motion project (no ${MOTION_PROJECT_MANIFEST} at the root)`)
  const data = new Uint8Array(buffer)
  const scan = scanZip(data)
  // Before inflating ANYTHING: the header already states the decompressed size,
  // and it is here that a decompression bomb is refused.
  if (scan.bytes > MAX_PROJECT_BYTES) throw new Error('the project is larger than the import limit')
  if (scan.names.length > MAX_PROJECT_FILES) throw new Error('the project has more files than a composition can have')
  const manifestName = scan.names
    .filter((name) => name.replace(/\\/g, '/').split('/').pop()?.toLowerCase() === MOTION_PROJECT_MANIFEST)
    .sort((a, b) => a.split('/').length - b.split('/').length)[0]
  const rootPrefix = manifestName.includes('/') ? manifestName.slice(0, manifestName.lastIndexOf('/') + 1) : ''

  const wanted: string[] = []
  let bytes = 0
  for (const name of scan.names) {
    const rel = safeZipEntry(rootPrefix, name)
    if (!rel) continue
    wanted.push(name)
  }
  if (!wanted.length) throw new Error('the .zip has no files for the composition')

  const root = piecesDir('motion', opts.sessionId)
  const folder = await uniqueFolder(root, pieceSlug(manifest.name, 'motion'))
  // `entry` comes from the manifest: it only counts if it is a file the zip really carries.
  const entryRel = manifest.entry.replace(/\\/g, '/').replace(/^\.\//, '')
  const available = wanted.map((name) => name.slice(rootPrefix.length).replace(/\\/g, '/'))
  const entryName = available.includes(entryRel) ? entryRel : available.find((name) => /\.html?$/i.test(name))
  if (!entryName) throw new Error('the project has no HTML entry — it is not a motion composition')

  const entries = unzipSync(data, {
    filter: (file) => wanted.includes(file.name),
  })
  await fsp.mkdir(folder, { recursive: true })
  let files = 0
  try {
    for (const name of wanted) {
      const rel = safeZipEntry(rootPrefix, name)
      if (!rel) continue
      const target = path.resolve(folder, ...rel.split('/'))
      const inside = relativeName(folder, target)
      if (!inside) continue
      const content = entries[name]
      if (!content) continue
      bytes += content.byteLength
      if (bytes > MAX_PROJECT_BYTES) throw new Error('the project is larger than the import limit')
      await fsp.mkdir(path.dirname(target), { recursive: true })
      await fsp.writeFile(target, content)
      files++
    }
    const registered = await registerMotion(folder, path.join(folder, ...entryName.split('/')), {
      root,
      sessionId: opts.sessionId,
    })
    return {
      id: registered.id,
      name: path.basename(folder),
      folder,
      entry: path.join(folder, ...entryName.split('/')),
      files,
      bytes,
      skipped: scan.names.length - wanted.length,
    }
  } catch (err) {
    // An import that failed halfway cannot leave half a piece taking up the folder
    // nor a registry entry pointing at it.
    await fsp.rm(folder, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}
