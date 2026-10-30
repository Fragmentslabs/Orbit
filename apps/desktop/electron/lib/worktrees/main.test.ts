import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../shell-env', () => ({ userShellEnv: () => process.env }))

const { clearMainCache, folderInMainRepository } = await import('./main')

let tmp: string
let repo: string
let worktree: string

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-main-')))
  repo = path.join(tmp, 'repo')
  fs.mkdirSync(path.join(repo, 'apps/web'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'apps/web/index.ts'), '')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A')
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')
  worktree = path.join(tmp, 'outside', 'wt')
  git(repo, 'worktree', 'add', '-q', '-b', 'other', worktree)
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

beforeEach(() => clearMainCache())

describe('folderInMainRepository', () => {
  it('the root of a worktree becomes the root of the main one', async () => {
    expect(await folderInMainRepository(worktree)).toBe(repo)
  })

  it('a worktree subfolder becomes the same subfolder in the main one (monorepo)', async () => {
    expect(await folderInMainRepository(path.join(worktree, 'apps/web'))).toBe(path.join(repo, 'apps/web'))
  })

  it('the main one and its subfolders stay as they are', async () => {
    expect(await folderInMainRepository(repo)).toBe(repo)
    expect(await folderInMainRepository(path.join(repo, 'apps'))).toBe(path.join(repo, 'apps'))
  })

  it('a folder without git or a nonexistent one comes back as it came', async () => {
    const loose = path.join(tmp, 'loose')
    fs.mkdirSync(loose, { recursive: true })
    expect(await folderInMainRepository(loose)).toBe(loose)
    expect(await folderInMainRepository(path.join(tmp, 'does-not-exist'))).toBe(path.join(tmp, 'does-not-exist'))
  })
})
