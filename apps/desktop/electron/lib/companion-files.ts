/**
 * File browsing and editing for the phone: the logic behind `/api/files/*`.
 *
 * The phone never names an absolute path. It names a session and a path RELATIVE to one
 * of that session's folders; this module checks both and only then touches the disk.
 * Containment is verified on the REAL path (symlinks resolved), so a link inside the
 * project that points at `/etc` cannot be used to read or write outside it.
 *
 * Pure of Electron and of the HTTP layer on purpose: the handlers in companion-http.ts
 * only parse the body and call these, and the tests run them against a temp folder.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import {
  COMPANION_FILE_MAX_BYTES,
  type FileDirEntry,
  type FilesListResponse,
  type FilesReadResponse,
  type FilesSearchResponse,
  type FilesWriteFailure,
  type FilesWriteResponse,
} from '@shared/companion-files'
import { workspaceIndex, matchNames } from './workspace-search'
import { checkWritePath } from './file-write-guard'

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
}

export class FilesError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404,
  ) {
    super(message)
  }
}

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Normalizes a wire path: '/'-separated, no leading slash, no empty segments. */
export function cleanRelative(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/')
}

/**
 * The root the request names, validated against the session's folders. Absent = the
 * main folder. Compared after `path.resolve`, never by prefix.
 */
export function pickRoot(roots: string[], requested: unknown): string {
  if (roots.length === 0) throw new FilesError('Session has no working folder', 404)
  if (typeof requested !== 'string' || requested === '') return path.resolve(roots[0])
  const wanted = path.resolve(requested)
  const match = roots.map((r) => path.resolve(r)).find((r) => r === wanted)
  if (!match) throw new FilesError('Folder does not belong to the session', 403)
  return match
}

/**
 * Absolute path of `relative` under `root`, or throws. The lexical check catches `..`;
 * the realpath check catches symlinks that leave the root. A path that does not exist
 * yet is checked through its nearest existing parent.
 */
export async function resolveInRoot(root: string, relative: string): Promise<string> {
  const rel = cleanRelative(relative)
  const target = path.resolve(root, rel)
  if (!inside(root, target)) throw new FilesError('Path escapes the folder', 403)

  const realRoot = await fs.realpath(root).catch(() => root)
  let probe = target
  for (;;) {
    try {
      const real = await fs.realpath(probe)
      if (!inside(realRoot, real)) throw new FilesError('Path escapes the folder', 403)
      return target
    } catch (err) {
      if (err instanceof FilesError) throw err
      const parent = path.dirname(probe)
      if (parent === probe) return target
      probe = parent
    }
  }
}

export async function listDirectory(
  root: string,
  roots: string[],
  relative: string,
): Promise<FilesListResponse> {
  const rel = cleanRelative(relative)
  const dir = await resolveInRoot(root, rel)
  let dirents
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    throw new FilesError('Folder not found', 404)
  }
  const entries: FileDirEntry[] = await Promise.all(
    dirents.map(async (d): Promise<FileDirEntry> => {
      const childRel = rel ? `${rel}/${d.name}` : d.name
      // A symlink to a folder shows as a folder, as the desktop tree does.
      let isDirectory = d.isDirectory()
      let size: number | undefined
      let mtimeMs: number | undefined
      try {
        const st = await fs.stat(path.join(dir, d.name))
        isDirectory = st.isDirectory()
        if (!isDirectory) size = st.size
        mtimeMs = st.mtimeMs
      } catch {
        /* dangling link: listed without metadata */
      }
      return { name: d.name, path: childRel, isDirectory, size, mtimeMs }
    }),
  )
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return { ok: true, root, roots: roots.map((r) => path.resolve(r)), path: rel, entries }
}

export function mimeOf(file: string): string | undefined {
  return IMAGE_MIME[path.extname(file).toLowerCase()]
}

/**
 * Reads a file for the viewer. Text comes back inline; an image or a binary comes back
 * as `kind` plus a signed `url` (built by the caller, which knows the host).
 */
export async function readFileEntry(
  root: string,
  relative: string,
  sign: (rel: string) => string,
): Promise<FilesReadResponse> {
  const rel = cleanRelative(relative)
  if (!rel) throw new FilesError('Path required', 400)
  const file = await resolveInRoot(root, rel)
  let st
  try {
    st = await fs.stat(file)
  } catch {
    throw new FilesError('File not found', 404)
  }
  if (!st.isFile()) throw new FilesError('Not a file', 400)

  const base = { ok: true as const, path: rel, size: st.size, mtimeMs: st.mtimeMs }
  const mime = mimeOf(file)
  if (mime) return { ...base, kind: 'image', url: sign(rel), mime }

  if (st.size > COMPANION_FILE_MAX_BYTES) return { ...base, kind: 'too-large', url: sign(rel) }

  const buffer = await fs.readFile(file)
  if (buffer.subarray(0, 8000).includes(0)) return { ...base, kind: 'binary', url: sign(rel) }
  return { ...base, kind: 'text', content: buffer.toString('utf8') }
}

/**
 * Saves a file edited on the phone. Same guards as the desktop panel's `fs:writeFile`
 * (existing text file, never `.git`, never binary, size ceiling) plus the mtime check:
 * if the file changed since the phone opened it (the agent, or the desktop editor), the
 * write is refused and the current content comes back.
 */
export async function writeFileEntry(
  root: string,
  relative: string,
  content: string,
  expectedMtimeMs: number | undefined,
  onSaved?: (file: string) => void,
): Promise<FilesWriteResponse> {
  const rel = cleanRelative(relative)
  if (!rel) throw new FilesError('Path required', 400)
  const fail = (reason: FilesWriteFailure, extra: Record<string, unknown> = {}) =>
    ({ ok: false, reason, ...extra }) as FilesWriteResponse

  let file: string
  try {
    file = await resolveInRoot(root, rel)
  } catch (err) {
    if (err instanceof FilesError) return fail('outside-root')
    throw err
  }
  const verdict = checkWritePath(file, [root])
  if (!verdict.ok) return fail(verdict.reason === 'git-internal' ? 'git-internal' : 'outside-root')

  if (Buffer.byteLength(content, 'utf8') > COMPANION_FILE_MAX_BYTES) return fail('too-large')

  try {
    const st = await fs.stat(file)
    if (!st.isFile()) return fail('not-a-file')

    const handle = await fs.open(file, 'r')
    try {
      const probe = Buffer.alloc(Math.min(8000, st.size))
      if (probe.length > 0) await handle.read(probe, 0, probe.length, 0)
      if (probe.includes(0)) return fail('binary')
    } finally {
      await handle.close()
    }

    if (expectedMtimeMs != null && st.mtimeMs !== expectedMtimeMs) {
      const current = st.size <= COMPANION_FILE_MAX_BYTES ? await fs.readFile(file, 'utf8') : undefined
      return fail('stale', current === undefined ? {} : { content: current, mtimeMs: st.mtimeMs })
    }

    await fs.writeFile(file, content, 'utf8')
    const after = await fs.stat(file)
    onSaved?.(file)
    return { ok: true, mtimeMs: after.mtimeMs, size: after.size }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return fail('not-a-file')
    return fail('failed', { error: (err as Error).message })
  }
}

export async function searchFileNames(root: string, query: string): Promise<FilesSearchResponse> {
  const index = await workspaceIndex(root)
  return { ok: true, hits: matchNames(index.files, query), truncated: index.truncated }
}

// ─── Signed file ids ─────────────────────────────────────────────────────────
// The `workspace` asset scope: the id carries (root, relative path), the token signs the id.

export function encodeWorkspaceId(root: string, relative: string): string {
  return Buffer.from(JSON.stringify({ r: root, p: cleanRelative(relative) }), 'utf8').toString('base64url')
}

export function decodeWorkspaceId(id: string): { root: string; rel: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(id, 'base64url').toString('utf8')) as { r?: unknown; p?: unknown }
    if (typeof parsed.r !== 'string' || typeof parsed.p !== 'string') return null
    return { root: parsed.r, rel: parsed.p }
  } catch {
    return null
  }
}

/** Absolute file behind a workspace id, or null when it is gone or escapes the root. */
export async function resolveWorkspaceFile(id: string): Promise<string | null> {
  const decoded = decodeWorkspaceId(id)
  if (!decoded || !decoded.rel) return null
  try {
    const file = await resolveInRoot(decoded.root, decoded.rel)
    const st = await fs.stat(file)
    return st.isFile() ? file : null
  } catch {
    return null
  }
}
