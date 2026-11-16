import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  FilesError,
  cleanRelative,
  decodeWorkspaceId,
  encodeWorkspaceId,
  listDirectory,
  pickRoot,
  readFileEntry,
  resolveInRoot,
  resolveWorkspaceFile,
  searchFileNames,
  writeFileEntry,
} from './companion-files'

let root: string
let outside: string

beforeEach(async () => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-files-')))
  root = path.join(base, 'project')
  outside = path.join(base, 'outside')
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.mkdir(path.join(root, '.git'), { recursive: true })
  await fs.mkdir(outside)
  await fs.writeFile(path.join(root, 'src', 'app.ts'), 'export const a = 1\n')
  await fs.writeFile(path.join(root, 'README.md'), '# hi\n')
  await fs.writeFile(path.join(root, '.git', 'config'), 'x')
  await fs.writeFile(path.join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0, 0]))
  await fs.writeFile(path.join(root, 'blob.bin'), Buffer.from([1, 2, 0, 3]))
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret')
})

afterEach(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true })
})

const sign = (rel: string) => `signed:${rel}`

describe('cleanRelative', () => {
  it('normalizes separators and drops empty/dot segments', () => {
    expect(cleanRelative('/a//b/./c\\d')).toBe('a/b/c/d')
    expect(cleanRelative(undefined)).toBe('')
  })
})

describe('pickRoot', () => {
  it('defaults to the main folder and accepts only session folders', () => {
    expect(pickRoot([root, outside], undefined)).toBe(root)
    expect(pickRoot([root, outside], outside)).toBe(outside)
    expect(() => pickRoot([root], '/etc')).toThrow(FilesError)
    expect(() => pickRoot([], undefined)).toThrow(FilesError)
  })
})

describe('resolveInRoot', () => {
  it('rejects ../ escapes', async () => {
    await expect(resolveInRoot(root, '../outside/secret.txt')).rejects.toBeInstanceOf(FilesError)
  })

  it('rejects a symlink that leaves the root', async () => {
    await fs.symlink(outside, path.join(root, 'link'))
    await expect(resolveInRoot(root, 'link/secret.txt')).rejects.toBeInstanceOf(FilesError)
    await expect(readFileEntry(root, 'link/secret.txt', sign)).rejects.toBeInstanceOf(FilesError)
  })

  it('accepts a path that does not exist yet inside the root', async () => {
    expect(await resolveInRoot(root, 'src/new.ts')).toBe(path.join(root, 'src', 'new.ts'))
  })
})

describe('listDirectory', () => {
  it('lists folders first, shows dotfiles, paths are relative', async () => {
    const out = await listDirectory(root, [root], '')
    const names = out.entries.map((e) => e.name)
    expect(names.slice(0, 2)).toEqual(['.git', 'src'])
    expect(names).toContain('README.md')
    const sub = await listDirectory(root, [root], 'src')
    expect(sub.entries[0]).toMatchObject({ name: 'app.ts', path: 'src/app.ts', isDirectory: false })
  })

  it('404s on a missing folder and 403s on traversal', async () => {
    await expect(listDirectory(root, [root], 'nope')).rejects.toMatchObject({ status: 404 })
    await expect(listDirectory(root, [root], '..')).rejects.toMatchObject({ status: 403 })
  })
})

describe('readFileEntry', () => {
  it('returns text inline with the mtime', async () => {
    const out = await readFileEntry(root, 'src/app.ts', sign)
    expect(out).toMatchObject({ kind: 'text', content: 'export const a = 1\n' })
    expect(out.mtimeMs).toBeGreaterThan(0)
  })

  it('signs images and detects binaries', async () => {
    expect(await readFileEntry(root, 'logo.png', sign)).toMatchObject({
      kind: 'image',
      url: 'signed:logo.png',
      mime: 'image/png',
    })
    expect(await readFileEntry(root, 'blob.bin', sign)).toMatchObject({ kind: 'binary' })
  })

  it('flags files over the ceiling without reading them', async () => {
    await fs.writeFile(path.join(root, 'big.txt'), 'x'.repeat(2 * 1024 * 1024 + 1))
    const out = await readFileEntry(root, 'big.txt', sign)
    expect(out.kind).toBe('too-large')
    expect(out.content).toBeUndefined()
  })
})

describe('writeFileEntry', () => {
  it('writes and returns the new mtime', async () => {
    const before = await readFileEntry(root, 'README.md', sign)
    const saved: string[] = []
    const out = await writeFileEntry(root, 'README.md', '# changed\n', before.mtimeMs, (f) => saved.push(f))
    expect(out.ok).toBe(true)
    expect(await fs.readFile(path.join(root, 'README.md'), 'utf8')).toBe('# changed\n')
    expect(saved).toEqual([path.join(root, 'README.md')])
  })

  it('refuses a stale write and returns what is on disk', async () => {
    const before = await readFileEntry(root, 'README.md', sign)
    await fs.writeFile(path.join(root, 'README.md'), 'desktop edit\n')
    const later = new Date(before.mtimeMs + 5000)
    await fs.utimes(path.join(root, 'README.md'), later, later)
    const out = await writeFileEntry(root, 'README.md', 'phone edit\n', before.mtimeMs)
    expect(out).toMatchObject({ ok: false, reason: 'stale', content: 'desktop edit\n' })
    expect(await fs.readFile(path.join(root, 'README.md'), 'utf8')).toBe('desktop edit\n')
  })

  it('refuses .git, binaries, traversal, missing files and oversize content', async () => {
    expect(await writeFileEntry(root, '.git/config', 'x', undefined)).toMatchObject({ reason: 'git-internal' })
    expect(await writeFileEntry(root, 'blob.bin', 'x', undefined)).toMatchObject({ reason: 'binary' })
    expect(await writeFileEntry(root, '../outside/secret.txt', 'x', undefined)).toMatchObject({ reason: 'outside-root' })
    expect(await writeFileEntry(root, 'src/missing.ts', 'x', undefined)).toMatchObject({ reason: 'not-a-file' })
    expect(await writeFileEntry(root, 'src', 'x', undefined)).toMatchObject({ reason: 'not-a-file' })
    expect(
      await writeFileEntry(root, 'README.md', 'x'.repeat(2 * 1024 * 1024 + 1), undefined),
    ).toMatchObject({ reason: 'too-large' })
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('secret')
  })
})

describe('searchFileNames', () => {
  it('finds by name and skips ignored folders', async () => {
    await fs.mkdir(path.join(root, 'node_modules', 'x'), { recursive: true })
    await fs.writeFile(path.join(root, 'node_modules', 'x', 'app.js'), '')
    const out = await searchFileNames(root, 'app')
    expect(out.hits.map((h) => h.path)).toEqual(['src/app.ts'])
  })
})

describe('workspace ids', () => {
  it('round-trips and resolves only existing files inside the root', async () => {
    const id = encodeWorkspaceId(root, 'logo.png')
    expect(decodeWorkspaceId(id)).toEqual({ root, rel: 'logo.png' })
    expect(await resolveWorkspaceFile(id)).toBe(path.join(root, 'logo.png'))
    expect(await resolveWorkspaceFile(encodeWorkspaceId(root, '../outside/secret.txt'))).toBeNull()
    expect(await resolveWorkspaceFile(encodeWorkspaceId(root, 'src'))).toBeNull()
    expect(await resolveWorkspaceFile('not-base64-json')).toBeNull()
  })
})
