import { createHash } from 'node:crypto'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import {
  FRAGMENT_PACKAGE_FORMAT,
  FRAGMENT_PACKAGE_LIMITS as LIMITS,
  FRAGMENT_PACKAGE_TYPES,
  FRAGMENT_PACKAGE_VERSION,
  type FragmentImportErrorCode,
  type FragmentPackageManifest,
} from '@shared/fragment-package'
import { FRAGMENT_CAPABILITIES, FRAGMENT_DEFAULT_ICON, FRAGMENT_ICON_PATTERN, FRAGMENT_KINDS } from '@shared/fragments'

/**
 * The `.orbitfrag` codec: pure bytes in, bytes out, no disk and no Electron, so it can be
 * tested with hostile archives. Everything a file can lie about is checked here before any
 * caller writes a byte: size caps (declared AND real), entry names, extensions, the manifest
 * schema and version, and the SHA-256 of every file.
 *
 * The archive holds `manifest.json` and `src/**` and nothing else. Saved data, history,
 * grants, chats and the provenance record are never packed, and an archive that carries
 * anything else is refused instead of having the extras ignored.
 */

const MANIFEST = 'manifest.json'
const ENTRY = 'index.html'
const SRC = 'src/'
const MAX_PATH_CHARS = 200
const MAX_DEPTH = 8

export interface PackFile {
  path: string
  data: Uint8Array
}

export interface PackInput {
  name: string
  kind: FragmentPackageManifest['kind']
  icon: string
  requests: FragmentPackageManifest['requests']
  author?: string
  description?: string
  files: PackFile[]
}

export type UnpackResult =
  | { ok: true; manifest: FragmentPackageManifest; files: PackFile[]; sha256: string; totalBytes: number }
  | { ok: false; code: FragmentImportErrorCode }

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

const fail = (code: FragmentImportErrorCode): { ok: false; code: FragmentImportErrorCode } => ({ ok: false, code })

const isControl = (ch: string): boolean => {
  const code = ch.codePointAt(0)!
  return code < 32 || code === 127
}

/** Control characters have no place in a name, an author or a description. */
function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return Array.from(value)
    .filter((ch) => {
      const code = ch.codePointAt(0)!
      return code === 10 || (code >= 32 && code !== 127)
    })
    .join('')
    .trim()
    .slice(0, max)
}

/**
 * A path INSIDE `src/`: relative, forward slashes, no `..`, no hidden names, no drive
 * letters or control characters, a served extension. Returns the problem, or null.
 */
export function packagePathProblem(rel: string): 'bad_path' | 'bad_file_type' | null {
  if (typeof rel !== 'string' || !rel || rel.length > MAX_PATH_CHARS) return 'bad_path'
  if (/[\\:]/.test(rel) || rel.startsWith('/') || Array.from(rel).some(isControl)) return 'bad_path'
  const parts = rel.split('/')
  if (parts.length > MAX_DEPTH) return 'bad_path'
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.startsWith('.') || p !== p.trim() || p.endsWith('.'))) return 'bad_path'
  const ext = parts[parts.length - 1].includes('.') ? parts[parts.length - 1].split('.').pop()!.toLowerCase() : ''
  return FRAGMENT_PACKAGE_TYPES.includes(ext) ? null : 'bad_file_type'
}

export function packFragment(input: PackInput): Uint8Array {
  const files = [...input.files].sort((a, b) => a.path.localeCompare(b.path))
  const manifest: FragmentPackageManifest = {
    format: FRAGMENT_PACKAGE_FORMAT,
    version: FRAGMENT_PACKAGE_VERSION,
    name: cleanText(input.name, LIMITS.name),
    kind: input.kind,
    icon: input.icon,
    requests: FRAGMENT_CAPABILITIES.filter((c) => input.requests.includes(c)),
    ...(input.author ? { author: cleanText(input.author, LIMITS.author) } : {}),
    ...(input.description ? { description: cleanText(input.description, LIMITS.description) } : {}),
    files: files.map((f) => ({ path: f.path, bytes: f.data.byteLength, sha256: sha256(f.data) })),
  }
  const entries: Record<string, Uint8Array> = { [MANIFEST]: strToU8(JSON.stringify(manifest, null, 2)) }
  for (const file of files) entries[SRC + file.path] = file.data
  return zipSync(entries, { level: 6 })
}

/** Reads and checks the manifest. Everything not listed here is dropped. */
function parseManifest(bytes: Uint8Array): { ok: true; manifest: FragmentPackageManifest } | { ok: false; code: FragmentImportErrorCode } {
  if (bytes.byteLength > LIMITS.manifestBytes) return fail('bad_manifest')
  let raw: unknown
  try {
    raw = JSON.parse(strFromU8(bytes))
  } catch {
    return fail('bad_manifest')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('bad_manifest')
  const m = raw as Record<string, unknown>
  if (m.format !== FRAGMENT_PACKAGE_FORMAT) return fail('bad_manifest')
  if (typeof m.version !== 'number' || !Number.isInteger(m.version) || m.version < 1) return fail('bad_manifest')
  if (m.version > FRAGMENT_PACKAGE_VERSION) return fail('unsupported_version')

  const name = cleanText(m.name, LIMITS.name)
  const kind = FRAGMENT_KINDS.find((k) => k === m.kind)
  if (!name || !kind || !Array.isArray(m.files) || m.files.length === 0) return fail('bad_manifest')
  if (m.files.length > LIMITS.files) return fail('too_many_files')

  const files: FragmentPackageManifest['files'] = []
  for (const item of m.files) {
    const f = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    if (typeof f.path !== 'string' || typeof f.bytes !== 'number' || !Number.isInteger(f.bytes) || f.bytes < 0) return fail('bad_manifest')
    if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(f.sha256)) return fail('bad_manifest')
    const problem = packagePathProblem(f.path)
    if (problem) return fail(problem)
    files.push({ path: f.path, bytes: f.bytes, sha256: f.sha256.toLowerCase() })
  }
  const lower = new Set(files.map((f) => f.path.toLowerCase()))
  if (lower.size !== files.length) return fail('duplicate_path')

  const icon = typeof m.icon === 'string' && m.icon.length <= 48 && FRAGMENT_ICON_PATTERN.test(m.icon) ? m.icon : FRAGMENT_DEFAULT_ICON
  const requests = FRAGMENT_CAPABILITIES.filter((c) => Array.isArray(m.requests) && m.requests.includes(c))
  const author = cleanText(m.author, LIMITS.author)
  const description = cleanText(m.description, LIMITS.description)
  return {
    ok: true,
    manifest: {
      format: FRAGMENT_PACKAGE_FORMAT,
      version: m.version,
      name,
      kind,
      icon,
      requests,
      ...(author ? { author } : {}),
      ...(description ? { description } : {}),
      files,
    },
  }
}

/**
 * Opens an archive. Declared sizes are checked BEFORE anything is inflated (the `filter`
 * runs on the central directory), real sizes after, so a header that lies about its size
 * either never inflates or is caught by the size check.
 */
export function unpackFragment(bytes: Uint8Array): UnpackResult {
  if (bytes.byteLength > LIMITS.archiveBytes) return fail('too_large')

  let refusal: FragmentImportErrorCode | null = null
  let declaredTotal = 0
  let entries = 0
  let entries_: Record<string, Uint8Array>
  try {
    entries_ = unzipSync(bytes, {
      filter: (file) => {
        if (refusal) return false
        const name = file.name
        if (name.endsWith('/')) {
          // A directory entry is harmless only as `src/...` (or `src/` itself).
          if (name !== SRC && !name.startsWith(SRC)) refusal = 'forbidden_entry'
          return false
        }
        entries += 1
        if (entries > LIMITS.files + 1) refusal = 'too_many_files'
        else if (name === MANIFEST) {
          if (file.originalSize > LIMITS.manifestBytes) refusal = 'bad_manifest'
        } else if (name.startsWith(SRC)) {
          const problem = packagePathProblem(name.slice(SRC.length))
          if (problem) refusal = problem
          else if (file.originalSize > LIMITS.fileBytes) refusal = 'file_too_large'
          else {
            declaredTotal += file.originalSize
            if (declaredTotal > LIMITS.totalBytes) refusal = 'too_large'
          }
        } else {
          // data.json, a dotfile, `../x`, a nested archive…: nothing outside manifest + src.
          refusal = /(^|\/)\.\.(\/|$)/.test(name) || name.startsWith('/') || name.includes('\\') ? 'bad_path' : 'forbidden_entry'
        }
        return !refusal
      },
    })
  } catch {
    return fail('not_an_archive')
  }
  if (refusal) return fail(refusal)

  const manifestBytes = entries_[MANIFEST]
  if (!manifestBytes) return fail('missing_manifest')
  const parsed = parseManifest(manifestBytes)
  if (!parsed.ok) return parsed
  const { manifest } = parsed

  const listed = new Map(manifest.files.map((f) => [f.path, f]))
  const present = Object.keys(entries_).filter((n) => n.startsWith(SRC))
  // The manifest is the complete list: a file it does not name (or names but is missing) is a bad archive.
  if (present.length !== listed.size || present.some((n) => !listed.has(n.slice(SRC.length)))) return fail('bad_manifest')
  if (!listed.has(ENTRY)) return fail('missing_entry')

  const files: PackFile[] = []
  let totalBytes = 0
  for (const name of present) {
    const data = entries_[name]
    const meta = listed.get(name.slice(SRC.length))!
    if (data.byteLength > LIMITS.fileBytes) return fail('file_too_large')
    if (data.byteLength !== meta.bytes) return fail('size_mismatch')
    if (sha256(data) !== meta.sha256) return fail('hash_mismatch')
    totalBytes += data.byteLength
    files.push({ path: meta.path, data })
  }
  if (totalBytes > LIMITS.totalBytes) return fail('too_large')
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { ok: true, manifest, files, sha256: sha256(bytes), totalBytes }
}
