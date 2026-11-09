import { strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { FRAGMENT_PACKAGE_LIMITS, FRAGMENT_PACKAGE_TYPES, FRAGMENT_PACKAGE_VERSION } from '@shared/fragment-package'
import { createHash } from 'node:crypto'
import { packFragment, packagePathProblem, unpackFragment, type PackInput } from './package-codec'

const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const html = strToU8('<h1>hi</h1>')

const input = (extra: Partial<PackInput> = {}): PackInput => ({
  name: 'Budget',
  kind: 'screen',
  icon: 'wallet',
  requests: ['ai'],
  files: [{ path: 'index.html', data: html }],
  ...extra,
})

/** A hand-built archive: `manifest` is what the file claims, `entries` is what it holds. */
function forge(entries: Record<string, Uint8Array>, manifest?: Record<string, unknown>): Uint8Array {
  const files = Object.entries(entries)
    .filter(([n]) => n.startsWith('src/'))
    .map(([n, d]) => ({ path: n.slice(4), bytes: d.byteLength, sha256: sha(d) }))
  const m = { format: 'orbitfrag', version: 1, name: 'X', kind: 'screen', icon: 'app-window', requests: [], files, ...manifest }
  return zipSync({ 'manifest.json': strToU8(JSON.stringify(m)), ...entries })
}

const code = (bytes: Uint8Array) => {
  const r = unpackFragment(bytes)
  return r.ok ? 'ok' : r.code
}

describe('round trip', () => {
  it('packs and unpacks a fragment with its files, hashes and requests', () => {
    const css = strToU8('body{}')
    const bytes = packFragment(input({ files: [{ path: 'index.html', data: html }, { path: 'css/app.css', data: css }], author: 'Ana' }))
    const result = unpackFragment(bytes)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest).toMatchObject({ name: 'Budget', kind: 'screen', icon: 'wallet', requests: ['ai'], author: 'Ana', version: FRAGMENT_PACKAGE_VERSION })
    expect(result.files.map((f) => f.path)).toEqual(['css/app.css', 'index.html'])
    expect(Buffer.from(result.files[1].data).toString()).toBe('<h1>hi</h1>')
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('never packs grants, data or anything beyond manifest + src', () => {
    const names = Object.keys(unzipNames(packFragment(input({ requests: ['ai', 'models'] }))))
    expect(names.sort()).toEqual(['manifest.json', 'src/index.html'])
    const manifest = JSON.parse(Buffer.from(unzipNames(packFragment(input()))['manifest.json']).toString())
    expect(manifest).not.toHaveProperty('grants')
    expect(manifest).not.toHaveProperty('sessionId')
  })

  it('serves exactly the extensions the fragment scheme serves', async () => {
    // Kept in sync by hand: SERVED_TYPES lives in the store, which imports electron.
    expect([...FRAGMENT_PACKAGE_TYPES].sort()).toEqual(['css', 'csv', 'html', 'js', 'json', 'md', 'mjs', 'svg', 'txt'])
  })
})

function unzipNames(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(bytes)
}

describe('malicious archives', () => {
  it('refuses something that is not a zip', () => {
    expect(code(strToU8('hello'))).toBe('not_an_archive')
    expect(code(new Uint8Array(0))).toBe('not_an_archive')
  })

  it('refuses path traversal and absolute paths in src', () => {
    expect(code(forge({ 'src/index.html': html, 'src/../evil.js': strToU8('x') }))).toBe('bad_path')
    expect(code(forge({ 'src/index.html': html, 'src/a/../../evil.js': strToU8('x') }))).toBe('bad_path')
    expect(code(forge({ 'src/index.html': html, 'src//etc/passwd.txt': strToU8('x') }))).toBe('bad_path')
    expect(code(forge({ 'src/index.html': html, 'src/a\\b.js': strToU8('x') }))).toBe('bad_path')
    expect(code(forge({ 'src/index.html': html, 'src/C:/x.js': strToU8('x') }))).toBe('bad_path')
  })

  it('refuses entries outside manifest.json and src/', () => {
    expect(code(forge({ 'src/index.html': html, '../escape.txt': strToU8('x') }))).toBe('bad_path')
    expect(code(forge({ 'src/index.html': html, '/abs.txt': strToU8('x') }))).toBe('bad_path')
    expect(code(forge({ 'src/index.html': html, 'data.json': strToU8('{"secret":1}') }))).toBe('forbidden_entry')
    expect(code(forge({ 'src/index.html': html, '.env': strToU8('KEY=1') }))).toBe('forbidden_entry')
    expect(code(forge({ 'src/index.html': html, 'history/old.js': strToU8('x') }))).toBe('forbidden_entry')
  })

  it('refuses hidden files and files the scheme would not serve', () => {
    expect(code(forge({ 'src/index.html': html, 'src/.secret.js': strToU8('x') }))).toBe('bad_path')
    expect(code(forge({ 'src/index.html': html, 'src/.git/config.txt': strToU8('x') }))).toBe('bad_path')
    expect(code(forge({ 'src/index.html': html, 'src/run.exe': strToU8('x') }))).toBe('bad_file_type')
    expect(code(forge({ 'src/index.html': html, 'src/noext': strToU8('x') }))).toBe('bad_file_type')
    expect(code(forge({ 'src/index.html': html, 'src/logo.png': strToU8('x') }))).toBe('bad_file_type')
  })

  it('refuses an oversized file by its declared size, without inflating it', () => {
    const big = new Uint8Array(FRAGMENT_PACKAGE_LIMITS.fileBytes + 1)
    expect(code(forge({ 'src/index.html': html, 'src/big.js': big }))).toBe('file_too_large')
  })

  it('refuses a decompression bomb (many files that are small zipped, huge in total)', () => {
    const chunk = new Uint8Array(FRAGMENT_PACKAGE_LIMITS.fileBytes)
    const entries: Record<string, Uint8Array> = { 'src/index.html': html }
    for (let i = 0; i < 6; i++) entries[`src/part${i}.txt`] = chunk
    const bytes = forge(entries)
    expect(bytes.byteLength).toBeLessThan(FRAGMENT_PACKAGE_LIMITS.archiveBytes)
    expect(code(bytes)).toBe('too_large')
  })

  it('refuses an archive over the size cap', () => {
    expect(code(new Uint8Array(FRAGMENT_PACKAGE_LIMITS.archiveBytes + 1))).toBe('too_large')
  })

  it('refuses too many files', () => {
    const entries: Record<string, Uint8Array> = { 'src/index.html': html }
    for (let i = 0; i < FRAGMENT_PACKAGE_LIMITS.files + 1; i++) entries[`src/f${i}.txt`] = strToU8('x')
    expect(code(forge(entries))).toBe('too_many_files')
  })

  it('refuses a header that lies about the size', () => {
    const real = strToU8('x'.repeat(5000))
    const bytes = forge({ 'src/index.html': html, 'src/lie.txt': real })
    const patched = patchUncompressedSize(bytes, 'src/lie.txt', 12)
    expect(code(patched)).toBe('size_mismatch')
  })

  it('refuses a file whose content does not match its recorded hash', () => {
    const entries = { 'src/index.html': html }
    const bytes = forge(entries, { files: [{ path: 'index.html', bytes: html.byteLength, sha256: 'a'.repeat(64) }] })
    expect(code(bytes)).toBe('hash_mismatch')
    const sized = forge(entries, { files: [{ path: 'index.html', bytes: 3, sha256: sha(html) }] })
    expect(code(sized)).toBe('size_mismatch')
  })

  it('refuses files the manifest does not list, and listed files that are missing', () => {
    const extra = forge({ 'src/index.html': html, 'src/extra.js': strToU8('x') }, {
      files: [{ path: 'index.html', bytes: html.byteLength, sha256: sha(html) }],
    })
    expect(code(extra)).toBe('bad_manifest')
    const missing = forge({ 'src/index.html': html }, {
      files: [
        { path: 'index.html', bytes: html.byteLength, sha256: sha(html) },
        { path: 'gone.js', bytes: 1, sha256: 'b'.repeat(64) },
      ],
    })
    expect(code(missing)).toBe('bad_manifest')
  })

  it('refuses duplicate paths that differ only in case', () => {
    const a = strToU8('a')
    const bytes = forge({ 'src/index.html': html, 'src/A.js': a, 'src/a.js': a })
    expect(code(bytes)).toBe('duplicate_path')
  })

  it('needs an index.html entry', () => {
    expect(code(forge({ 'src/app.js': strToU8('x') }))).toBe('missing_entry')
  })
})

describe('manifest validation', () => {
  const entries = { 'src/index.html': html }

  it('needs a manifest', () => {
    expect(code(zipSync({ 'src/index.html': html }))).toBe('missing_manifest')
  })

  it('refuses broken JSON, a wrong format and a bad schema', () => {
    expect(code(zipSync({ 'manifest.json': strToU8('{nope'), ...entries }))).toBe('bad_manifest')
    expect(code(zipSync({ 'manifest.json': strToU8('[]'), ...entries }))).toBe('bad_manifest')
    expect(code(forge(entries, { format: 'zip' }))).toBe('bad_manifest')
    expect(code(forge(entries, { name: '' }))).toBe('bad_manifest')
    expect(code(forge(entries, { kind: 'desktop' }))).toBe('bad_manifest')
    expect(code(forge(entries, { version: 'one' }))).toBe('bad_manifest')
    expect(code(forge(entries, { version: 0 }))).toBe('bad_manifest')
    expect(code(forge(entries, { files: 'all' }))).toBe('bad_manifest')
  })

  it('refuses a newer format version instead of guessing', () => {
    expect(code(forge(entries, { version: FRAGMENT_PACKAGE_VERSION + 1 }))).toBe('unsupported_version')
  })

  it('refuses a manifest path that escapes src', () => {
    const bytes = forge(entries, { files: [{ path: '../x.js', bytes: 1, sha256: 'c'.repeat(64) }] })
    expect(code(bytes)).toBe('bad_path')
  })

  it('drops unknown capabilities, ignores grants, and clamps and cleans text', () => {
    const bytes = forge(entries, {
      requests: ['ai', 'root', 'models'],
      grants: ['ai', 'models'],
      icon: '../../etc',
      name: `  ${'N'.repeat(300)}\u0000  `,
      author: 'Eve\u0007',
      description: 'd'.repeat(2000),
    })
    const result = unpackFragment(bytes)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.requests).toEqual(['ai', 'models'])
    expect(result.manifest).not.toHaveProperty('grants')
    expect(result.manifest.icon).toBe('app-window')
    expect(result.manifest.name.length).toBe(FRAGMENT_PACKAGE_LIMITS.name)
    expect(result.manifest.author).toBe('Eve')
    expect(result.manifest.description!.length).toBe(FRAGMENT_PACKAGE_LIMITS.description)
  })
})

describe('packagePathProblem', () => {
  it('accepts plain nested paths and rejects the rest', () => {
    expect(packagePathProblem('index.html')).toBeNull()
    expect(packagePathProblem('js/app.mjs')).toBeNull()
    expect(packagePathProblem('')).toBe('bad_path')
    expect(packagePathProblem('a/./b.js')).toBe('bad_path')
    expect(packagePathProblem('a/b.js.')).toBe('bad_path')
    expect(packagePathProblem('a\u0000.js')).toBe('bad_path')
    expect(packagePathProblem('x'.repeat(300) + '.js')).toBe('bad_path')
  })
})

/** Rewrites the uncompressed size of one entry in both its local header and the central directory. */
function patchUncompressedSize(zip: Uint8Array, name: string, size: number): Uint8Array {
  const out = new Uint8Array(zip)
  const view = new DataView(out.buffer)
  const nameBytes = strToU8(name)
  for (let i = 0; i < out.length - 4; i++) {
    const sig = view.getUint32(i, true)
    const nameAt = sig === 0x04034b50 ? i + 30 : sig === 0x02014b50 ? i + 46 : -1
    if (nameAt < 0) continue
    const len = view.getUint16(i + (sig === 0x04034b50 ? 26 : 28), true)
    if (len !== nameBytes.length || !nameBytes.every((b, k) => out[nameAt + k] === b)) continue
    view.setUint32(i + (sig === 0x04034b50 ? 22 : 24), size, true)
  }
  return out
}
