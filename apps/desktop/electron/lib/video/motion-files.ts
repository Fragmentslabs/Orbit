import { app } from 'electron'
import fsp from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { motionBundleKey, type MotionBundle, type MotionBundleFile } from '@shared/media'
import { motionPiecesForSession } from './motion-store'

/**
 * The FILES of each composition, the way the chat needs to see them.
 *
 * A motion piece is a FOLDER: the entry HTML, the media that came in through
 * `motion_asset`, the fonts, the material the agent downloaded, the `audio.json` of the
 * tracks. In the chat, every audio or image brought in became a loose
 * player in the message — and what was generated and then replaced stayed there,
 * filling the conversation with material the piece no longer uses (or never used).
 *
 * Here lives what the piece card reads: the FOLDER LISTING (that is the truth — nothing
 * is deleted, the file left out stays on disk) crossed with the
 * ORIGIN record of each file, written at the moment it came in
 * (`motion_asset`). With the origin, the chat recognizes the player of a generated audio
 * as belonging to the piece and folds it into the card instead of showing it loose.
 *
 * "Used" is not a stored label: it is DERIVED — the file is cited in the
 * composition's HTML/CSS/JS or in its `audio.json`. That way the count never goes
 * stale: when the agent swaps the narration in `audio.json`, the old file
 * becomes "discarded" by itself, with nobody having to mark it.
 */

export interface MotionFileRecord {
  /** Relative path inside the piece's folder, always with `/`. */
  name: string
  /** Attachment references the file came from (`aud_…`, `img_…`, `vdo_…`). */
  refs: string[]
  /** Source paths (code mode: a file of the working folder). */
  sources: string[]
  /** When it entered the piece (ms). */
  addedAt: number
}

interface BundleEntry {
  folder: string
  sessionId?: string
  files: MotionFileRecord[]
}

type FileIndex = Record<string, BundleEntry>

const SAFE_MOTION_ID = /^mv_[a-z0-9]+$/
/** Cap on files listed per piece: a composition is a small folder. */
const MAX_FILES = 400
/** How far the listing goes down (a piece uses at most one level of subfolder). */
const MAX_DEPTH = 3
/** A text file larger than this does not enter the citation scan. */
const MAX_SOURCE_BYTES = 2 * 1024 * 1024
/** How many files the citation scan reads, at most. */
const MAX_SOURCE_FILES = 40
/** What the "used" scan reads: what the composition may cite a file in. */
const SOURCE_EXTENSIONS = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.svg', '.srt', '.vtt', '.txt'])
/**
 * Files of the folder that do NOT enter the list: the entry HTML (the piece itself) and
 * the internal manifests. `audio.json` is still READ — but as a source of
 * citations, not as an item of the list.
 */
const INTERNAL_FILES = new Set(['index.html', 'audio.json', 'orbit.json'])

const EXT_KIND: Record<string, MotionBundleFile['kind']> = {
  '.mp3': 'audio',
  '.wav': 'audio',
  '.m4a': 'audio',
  '.aac': 'audio',
  '.ogg': 'audio',
  '.oga': 'audio',
  '.opus': 'audio',
  '.flac': 'audio',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.avif': 'image',
  '.bmp': 'image',
  '.svg': 'image',
  '.mp4': 'video',
  '.mov': 'video',
  '.webm': 'video',
  '.mkv': 'video',
  '.m4v': 'video',
  '.woff': 'font',
  '.woff2': 'font',
  '.ttf': 'font',
  '.otf': 'font',
}

function indexFile(): string {
  return path.join(app.getPath('userData'), 'orbit-data', 'motion-files.json')
}

let index: FileIndex | null = null
let writing: Promise<void> = Promise.resolve()

async function load(fresh = false): Promise<FileIndex> {
  if (index && !fresh) return index
  try {
    const disk = JSON.parse(await fsp.readFile(indexFile(), 'utf8')) as FileIndex
    // Re-read: what is in memory and not yet written cannot vanish.
    index = fresh && index ? { ...disk, ...index } : disk
  } catch {
    index = index ?? {}
  }
  return index
}

function persist(): Promise<void> {
  const snapshot = JSON.stringify(index ?? {}, null, 2)
  writing = writing
    .then(async () => {
      const file = indexFile()
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.writeFile(file, snapshot, 'utf8')
    })
    .catch(() => {
      // The origin index is a convenience of the card: if the disk refuses the write,
      // the piece keeps working — there will just be no card to connect the file to.
    })
  return writing
}

/** Relative name inside the folder, with `/` and without escaping it. */
export function pieceFileName(folder: string, file: string): string | null {
  const rel = path.relative(path.resolve(folder), path.resolve(file))
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.split(path.sep).join('/')
}

/**
 * Records WHERE a file that just entered the piece came from.
 *
 * Called by `motion_asset`, right after the copy — it is what links `narracao.wav`
 * inside the folder to the `aud_…` the chat showed as a player. The same file
 * may receive different origins over its life (the re-recorded narration that
 * landed on the same name for having the same size): both are kept, because
 * both messages are still in the conversation.
 */
export async function recordMotionFile(
  piece: { id: string; folder: string; sessionId?: string },
  file: { name?: string; ref?: string; source?: string },
): Promise<void> {
  if (!SAFE_MOTION_ID.test(piece.id)) return
  const name = file.name ? file.name.split(path.sep).join('/') : ''
  if (!name) return
  const entries = await load()
  const entry = entries[piece.id] ?? { folder: piece.folder, files: [] }
  entry.folder = piece.folder
  if (piece.sessionId) entry.sessionId = piece.sessionId
  const record = entry.files.find((f) => f.name === name) ?? { name, refs: [], sources: [], addedAt: 0 }
  if (file.ref && !record.refs.includes(file.ref)) record.refs.push(file.ref)
  if (file.source && !record.sources.includes(file.source)) record.sources.push(file.source)
  // Re-importing the same file (the same name, the same content) is nothing new:
  // the date only moves when the file really enters for the first time.
  if (!record.addedAt) record.addedAt = Date.now()
  if (!entry.files.some((f) => f.name === name)) entry.files.push(record)
  entries[piece.id] = entry
  await persist()
}

/** The piece left the registry: what we knew of its origins is no longer of use. */
export async function forgetMotionFiles(id: string): Promise<void> {
  const entries = await load()
  if (!entries[id]) return
  delete entries[id]
  await persist()
}

/** A file of the folder, already with what the card's list shows. */
interface ListedFile {
  name: string
  size: number
  mtimeMs: number
}

async function listFolder(root: string, dir = root, depth = 0, out: ListedFile[] = []): Promise<ListedFile[]> {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return out
  let items: Dirent[]
  try {
    items = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const item of items) {
    if (out.length >= MAX_FILES) break
    // A leading dot is a system file (the editor's `.motion-*`, `.DS_Store`).
    if (item.name.startsWith('.')) continue
    const abs = path.join(dir, item.name)
    if (item.isDirectory()) {
      await listFolder(root, abs, depth + 1, out)
      continue
    }
    if (!item.isFile()) continue
    const stat = await fsp.stat(abs).catch(() => null)
    if (!stat || !stat.size) continue
    // The name is ALWAYS relative to the piece's root (`fonts/inter.woff2`), even
    // when the file is in a subfolder.
    const rel = pieceFileName(root, abs)
    if (!rel) continue
    if (depth === 0 && INTERNAL_FILES.has(rel.toLowerCase())) continue
    out.push({ name: rel, size: stat.size, mtimeMs: stat.mtimeMs })
  }
  return out
}

/**
 * All the text that can CITE a file of the piece: the entry HTML, the
 * `audio.json` and the CSS/JS it loads. It is the source of "used".
 */
async function readCompositionSources(folder: string, entry: string | null): Promise<string> {
  const parts: string[] = []
  const seen = new Set<string>()
  const add = async (abs: string): Promise<void> => {
    const key = abs.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    const stat = await fsp.stat(abs).catch(() => null)
    if (!stat?.isFile() || stat.size > MAX_SOURCE_BYTES) return
    try {
      parts.push(await fsp.readFile(abs, 'utf8'))
    } catch {
      // unreadable/binary: left out
    }
  }
  if (entry) await add(entry)
  const walk = async (dir: string, depth: number): Promise<void> => {
    // Cap on files read: a piece cites half a dozen; the rest (a
    // node_modules that fell into the folder) does not change the answer and costs a lot.
    if (depth > 1 || parts.length >= MAX_SOURCE_FILES) return
    let items: Dirent[]
    try {
      items = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      if (item.name.startsWith('.')) continue
      const abs = path.join(dir, item.name)
      if (item.isDirectory()) {
        await walk(abs, depth + 1)
        continue
      }
      if (!item.isFile()) continue
      if (!SOURCE_EXTENSIONS.has(path.extname(item.name).toLowerCase())) continue
      // The exported manifest lists every file — if it entered the
      // scan, every file would look "used".
      if (item.name.toLowerCase() === 'orbit.json') continue
      await add(abs)
    }
  }
  await walk(folder, 0)
  return parts.join('\n')
}

/**
 * The name appears in the text as a FILE, not as a piece of another word
 * (`a.wav` inside `data.wav` does not count). Both the path and the bare name count, and
 * also the percent-encoded form, which is how a name with a space travels in a URL.
 */
export function mentionsFile(text: string, name: string): boolean {
  const base = name.split('/').pop() ?? name
  const needles = new Set<string>()
  for (const candidate of [name, base]) {
    if (!candidate) continue
    needles.add(candidate)
    try {
      const encoded = encodeURI(candidate)
      if (encoded !== candidate) needles.add(encoded)
    } catch {
      // name with a stray %: only the raw form counts
    }
  }
  for (const needle of needles) {
    let from = 0
    for (;;) {
      const at = text.indexOf(needle, from)
      if (at < 0) break
      const before = at === 0 ? '' : text[at - 1]
      const after = text[at + needle.length] ?? ''
      // `./narracao.wav`, `"narracao.wav"`, `src=narracao.wav` pass; `x-narracao.wav`
      // (another file) does not.
      if (!/[A-Za-z0-9_-]/.test(before) && !/[A-Za-z0-9_.-]/.test(after)) return true
      from = at + 1
    }
  }
  return false
}

function kindOf(name: string): MotionBundleFile['kind'] {
  return EXT_KIND[path.extname(name).toLowerCase()] ?? 'file'
}

async function bundleFor(
  id: string,
  folder: string,
  entry: string | null,
  records: MotionFileRecord[],
): Promise<MotionBundle | null> {
  const listed = await listFolder(folder)
  if (!listed.length) return null
  const sources = await readCompositionSources(folder, entry)
  const byName = new Map(records.map((r) => [r.name, r]))
  const files: MotionBundleFile[] = listed.map((file) => {
    const record = byName.get(file.name)
    return {
      name: file.name,
      size: file.size,
      kind: kindOf(file.name),
      used: mentionsFile(sources, file.name),
      addedAt: record?.addedAt || Math.round(file.mtimeMs),
    }
  })
  files.sort((a, b) => b.addedAt - a.addedAt || a.name.localeCompare(b.name))
  const keys = new Set<string>()
  for (const record of records) {
    for (const value of [...record.refs, ...record.sources]) {
      const key = motionBundleKey(value)
      if (key) keys.add(key)
    }
  }
  return {
    motionId: id,
    name: path.basename(folder),
    folder,
    files,
    totalBytes: files.reduce((sum, f) => sum + f.size, 0),
    discarded: files.filter((f) => !f.used).length,
    keys: [...keys],
  }
}

/**
 * The piece cards of a conversation — one per composition that has a file in the
 * folder. The list comes from the UNION of two sources: the registry of what entered through
 * `motion_asset` (which brings the origins) and the registry of the session's compositions
 * (which brings each one's entry). Neither is enough alone: the piece may
 * have files that never went through `motion_asset`, and may have been
 * registered before the first file came in.
 */
export async function listMotionBundles(sessionId: string): Promise<MotionBundle[]> {
  const pieces = new Map<string, { id: string; folder: string; entry: string | null }>()
  const entries = await load(true)
  for (const [id, entry] of Object.entries(entries)) {
    if (entry.sessionId !== sessionId) continue
    pieces.set(id, { id, folder: entry.folder, entry: null })
  }
  for (const piece of await motionPiecesForSession(sessionId)) {
    // The entry comes from the registry: it is what stays out of the list.
    pieces.set(piece.id, { id: piece.id, folder: piece.folder, entry: piece.entry })
  }
  const bundles: MotionBundle[] = []
  for (const piece of pieces.values()) {
    const records = entries[piece.id]?.files ?? []
    const bundle = await bundleFor(piece.id, piece.folder, piece.entry, records)
    if (bundle) bundles.push(bundle)
  }
  return bundles.sort((a, b) => a.name.localeCompare(b.name))
}
