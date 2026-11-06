import fsp from 'node:fs/promises'
import path from 'node:path'
import type { RemoteFileContent, RemoteFileEntry, RemoteFileTree } from '@shared/peers'

/**
 * Read-only access, for a paired desktop with the "see files" grant, to the
 * project folders of ONE chat.
 *
 * The roots come from the session stored on this machine — never from the request:
 * the other side only names a session, a root index and a relative path. Every
 * path is resolved through `realpath` and must stay inside the root's realpath,
 * so neither `..` nor a symlink pointing outside gets anywhere.
 *
 * Secrets are hidden and refused even inside the project: `.env*`, keys and
 * certificates, SSH/cloud credential folders and the `.git` internals.
 */

const DENIED_SEGMENTS = new Set(['.git', '.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker'])
const DENIED_FILES = [
  /^\.env(\..*)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks|kdbx|ovpn)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.(npmrc|netrc|pypirc|pgpass)$/i,
  /^credentials(\..*)?$/i,
  /^secrets?(\..*)?$/i,
]

const MAX_ENTRIES = 1000
const MAX_TEXT_BYTES = 1024 * 1024
const MAX_BINARY_BYTES = 8 * 1024 * 1024

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
}

export class FsAccessError extends Error {
  constructor(public readonly code: 'invalid_path' | 'denied' | 'not_found' | 'not_a_file' | 'not_a_dir') {
    super(code)
  }
}

export function isDeniedName(name: string): boolean {
  if (DENIED_SEGMENTS.has(name.toLowerCase())) return true
  return DENIED_FILES.some((re) => re.test(name))
}

/** `a/b/c` from whatever came in; throws on absolute paths, `..`, NUL and denied segments. */
export function cleanRelative(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') return ''
  if (typeof raw !== 'string' || raw.includes('\0') || raw.length > 4096) throw new FsAccessError('invalid_path')
  const unified = raw.replace(/\\/g, '/')
  if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified)) throw new FsAccessError('invalid_path')
  const segments = unified.split('/').filter((s) => s !== '' && s !== '.')
  if (segments.some((s) => s === '..')) throw new FsAccessError('invalid_path')
  if (segments.some(isDeniedName)) throw new FsAccessError('denied')
  return segments.join('/')
}

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

async function resolveInside(roots: string[], rootIndex: unknown, rel: unknown): Promise<{ root: string; target: string; rel: string; index: number }> {
  const index = typeof rootIndex === 'number' && Number.isInteger(rootIndex) ? rootIndex : 0
  const rawRoot = roots[index]
  if (!rawRoot) throw new FsAccessError('not_found')
  const clean = cleanRelative(rel)
  let root: string
  try {
    root = await fsp.realpath(rawRoot)
  } catch {
    throw new FsAccessError('not_found')
  }
  let target: string
  try {
    target = await fsp.realpath(path.join(root, ...clean.split('/').filter(Boolean)))
  } catch {
    throw new FsAccessError('not_found')
  }
  if (!inside(root, target)) throw new FsAccessError('denied')
  // A symlink inside the project pointing at a secret inside the project is still a secret.
  const realRel = path.relative(root, target).split(path.sep).filter(Boolean)
  if (realRel.some(isDeniedName)) throw new FsAccessError('denied')
  return { root, target, rel: realRel.join('/'), index }
}

export async function listDirectory(roots: string[], rootIndex: unknown, rel: unknown): Promise<RemoteFileTree> {
  const { target, rel: cleanRel, index } = await resolveInside(roots, rootIndex, rel)
  const stat = await fsp.stat(target)
  if (!stat.isDirectory()) throw new FsAccessError('not_a_dir')
  const dirents = await fsp.readdir(target, { withFileTypes: true })
  const entries: RemoteFileEntry[] = []
  for (const d of dirents) {
    if (isDeniedName(d.name)) continue
    if (!d.isDirectory() && !d.isFile() && !d.isSymbolicLink()) continue
    const childRel = cleanRel ? `${cleanRel}/${d.name}` : d.name
    let dir = d.isDirectory()
    let size: number | undefined
    if (d.isSymbolicLink() || d.isFile()) {
      const s = await fsp.stat(path.join(target, d.name)).catch(() => null)
      if (!s) continue
      dir = s.isDirectory()
      size = s.isFile() ? s.size : undefined
    }
    entries.push({ name: d.name, path: childRel, dir, ...(size !== undefined ? { size } : {}) })
    if (entries.length >= MAX_ENTRIES) break
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
  return {
    roots: roots.map((r, i) => ({ index: i, name: path.basename(r) || r })),
    root: index,
    path: cleanRel,
    entries,
  }
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

export async function readProjectFile(roots: string[], rootIndex: unknown, rel: unknown): Promise<RemoteFileContent> {
  const { target, rel: cleanRel, index } = await resolveInside(roots, rootIndex, rel)
  const stat = await fsp.stat(target)
  if (!stat.isFile()) throw new FsAccessError('not_a_file')
  const mime = MIME[path.extname(target).toLowerCase()]
  const handle = await fsp.open(target, 'r')
  try {
    if (mime) {
      const length = Math.min(stat.size, MAX_BINARY_BYTES)
      const buf = Buffer.alloc(length)
      await handle.read(buf, 0, length, 0)
      return { root: index, path: cleanRel, size: stat.size, mime, encoding: 'base64', content: buf.toString('base64'), truncated: stat.size > length }
    }
    const length = Math.min(stat.size, MAX_TEXT_BYTES)
    const buf = Buffer.alloc(length)
    await handle.read(buf, 0, length, 0)
    if (looksBinary(buf)) {
      return { root: index, path: cleanRel, size: stat.size, mime: 'application/octet-stream', encoding: 'base64', content: '', truncated: true }
    }
    return { root: index, path: cleanRel, size: stat.size, mime: 'text/plain', encoding: 'utf8', content: buf.toString('utf8'), truncated: stat.size > length }
  } finally {
    await handle.close()
  }
}
