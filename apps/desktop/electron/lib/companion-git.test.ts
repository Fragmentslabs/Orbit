import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// git/index.ts registers IPC handlers on import; only its functions matter here.
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('./github-repo', () => ({ createRemoteRepo: vi.fn() }))

import {
  MAX_PATCH_CHARS,
  capPatch,
  gitCommitDiffForPhone,
  gitCommitForPhone,
  gitCreateBranch,
  gitDiffForPhone,
  gitInfoForPhone,
  gitInitForPhone,
  gitLogForPhone,
  gitStatusForPhone,
  gitSyncForPhone,
  isValidBranchName,
  isValidHash,
} from './companion-git'

const base = path.join(os.tmpdir(), `orbit-companion-git-${Date.now()}`)
const git = (...args: string[]) => execFileSync('git', args, { cwd: base, stdio: 'pipe' })

beforeAll(async () => {
  await fsp.mkdir(base, { recursive: true })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 't')
  await fsp.writeFile(path.join(base, 'a.txt'), 'one\ntwo\n')
  await fsp.writeFile(path.join(base, 'gone.txt'), 'x\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  await fsp.writeFile(path.join(base, 'a.txt'), 'one\ntwo\nthree\n')
  await fsp.rm(path.join(base, 'gone.txt'))
  await fsp.writeFile(path.join(base, 'new.txt'), 'n1\nn2\n')
})

afterAll(async () => {
  await fsp.rm(base, { recursive: true, force: true })
})

describe('isValidBranchName', () => {
  it('accepts normal names and rejects what git or the shell would misread', () => {
    expect(isValidBranchName('feat/mobile-diff')).toBe(true)
    for (const bad of ['', '-x', 'a b', 'a..b', 'a~1', '/a', 'a/', 'a.lock', 'x/.y', '@', 'a@{1}', 'a//b'])
      expect(isValidBranchName(bad)).toBe(false)
  })
})

describe('capPatch', () => {
  it('keeps a small patch and cuts a huge one at a line boundary', () => {
    expect(capPatch('abc')).toEqual({ patch: 'abc' })
    const big = ('x'.repeat(99) + '\n').repeat(MAX_PATCH_CHARS / 50)
    const res = capPatch(big)
    expect(res.truncated).toBe(true)
    expect(res.patch.length).toBeLessThanOrEqual(MAX_PATCH_CHARS)
    expect(res.patch.endsWith('x')).toBe(true)
  })
})

describe('git for the phone', () => {
  it('lists changed files with their +/- counts and the branch', async () => {
    const res = await gitStatusForPhone(base)
    expect(res.branch).toBe('main')
    const byPath = Object.fromEntries(res.files.map((f) => [f.path, f]))
    expect(byPath['a.txt']).toMatchObject({ status: 'modified', added: 1, deleted: 0 })
    expect(byPath['gone.txt']).toMatchObject({ status: 'deleted', added: 0, deleted: 1 })
    expect(byPath['new.txt']).toMatchObject({ status: 'untracked', added: 2, deleted: 0 })
  })

  it('returns the patch of one file, of an untracked file and of the whole tree', async () => {
    expect((await gitDiffForPhone(base, 'a.txt')).patch).toContain('+three')
    expect((await gitDiffForPhone(base, 'new.txt')).patch).toContain('+n1')
    const all = (await gitDiffForPhone(base)).patch
    expect(all).toContain('diff --git a/a.txt')
    expect(all).toContain('diff --git a/new.txt')
  })

  it('refuses an invalid branch name and creates a branch carrying the changes along', async () => {
    await expect(gitCreateBranch(base, '--force')).rejects.toThrow('Invalid branch name')
    await gitCreateBranch(base, 'feature/x')
    const res = await gitStatusForPhone(base)
    expect(res.branch).toBe('feature/x')
    expect(res.files.length).toBe(3)
    await expect(gitCreateBranch(base, 'feature/x')).rejects.toThrow()
  })
})

describe('commits, info and sync for the phone', () => {
  it('only takes a hash git itself would print', () => {
    expect(isValidHash('a1b2c3d')).toBe(true)
    for (const bad of ['', '--all', 'HEAD', 'abc', 'a1b2c3d..HEAD', 'a1b2 c3d']) expect(isValidHash(bad)).toBe(false)
  })

  it('refuses an empty message, commits everything and lists the commit with its files', async () => {
    await expect(gitCommitForPhone(base, '   ')).rejects.toThrow('empty')
    await gitCommitForPhone(base, 'second commit')
    expect((await gitStatusForPhone(base)).files).toEqual([])
    const log = await gitLogForPhone(base)
    expect(log.hasMore).toBe(false)
    expect(log.commits.map((c) => c.message)).toEqual(['second commit', 'init'])
    expect(log.commits[0].files.map((f) => f.path).sort()).toEqual(['a.txt', 'gone.txt', 'new.txt'])
    expect(log.commits[0].pushed).toBe(false)
  })

  it('shows what one commit changed in one file and refuses a non-hash', async () => {
    const [head] = (await gitLogForPhone(base)).commits
    expect((await gitCommitDiffForPhone(base, head.hash, 'a.txt')).patch).toContain('+three')
    await expect(gitCommitDiffForPhone(base, '--all', 'a.txt')).rejects.toThrow('Invalid commit')
  })

  it('reports the branch state and a push without a remote as a result, not a throw', async () => {
    const info = await gitInfoForPhone(base)
    expect(info).toMatchObject({ isRepo: true, current: 'feature/x', hasRemote: false, dirty: false, upstream: null })
    const plain = await fsp.mkdtemp(path.join(os.tmpdir(), 'orbit-no-git-'))
    try {
      expect(await gitInfoForPhone(plain)).toMatchObject({ isRepo: false, current: null, hasRemote: false })
    } finally {
      await fsp.rm(plain, { recursive: true, force: true })
    }
    const res = await gitSyncForPhone(base, 'push')
    expect(res).toMatchObject({ ok: false, kind: 'noRemote' })
  })
})

describe('git init for the phone', () => {
  it('turns a plain folder into a repository and leaves an existing one alone', async () => {
    const plain = await fsp.mkdtemp(path.join(os.tmpdir(), 'orbit-init-'))
    try {
      expect((await gitInfoForPhone(plain)).isRepo).toBe(false)
      await gitInitForPhone(plain)
      // A repository just started: no commits is an empty history, and what is on disk is a change.
      await fsp.writeFile(path.join(plain, 'a.txt'), 'x\ny\n')
      expect(await gitLogForPhone(plain)).toEqual({ commits: [], hasMore: false })
      expect((await gitStatusForPhone(plain)).files).toMatchObject([{ path: 'a.txt', status: 'untracked', added: 2 }])
      expect((await gitDiffForPhone(plain)).patch).toContain('+x')
      await fsp.rm(path.join(plain, 'a.txt'))
      expect(await gitInfoForPhone(plain)).toMatchObject({ isRepo: true, hasRemote: false, dirty: false })
      await gitInitForPhone(plain)
      await expect(gitInitForPhone(path.join(plain, 'missing'))).rejects.toThrow()
    } finally {
      await fsp.rm(plain, { recursive: true, force: true })
    }
  })
})
