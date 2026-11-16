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
  gitCreateBranch,
  gitDiffForPhone,
  gitStatusForPhone,
  isValidBranchName,
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
