import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const userData = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => userData.dir } }))
vi.mock('../shell-env', () => ({ userShellEnv: () => process.env }))
vi.mock('../app-settings', () => ({ getAppSettings: () => ({ worktrees: { local: 'default', folder: null } }) }))

const { folderDiff, turnDiffs } = await import('./diff')

describe('turnDiffs', () => {
  it('builds the patch of the captured turns and warns about nothing', () => {
    const r = turnDiffs([
      { files: ['a.ts'], patch: 'patch-a', verified: 'changed' },
      { verified: 'unchanged' },
    ])
    expect(r.unavailable).toBeUndefined()
    expect(r.patch).toContain('- a.ts')
    expect(r.patch).toContain('patch-a')
  })

  it('a failed initial capture becomes a notice with the reason — never an "empty diff"', () => {
    const r = turnDiffs([{ failed: true, captureError: 'index.lock: File exists' }])
    expect(r.patch).toBe('')
    expect(r.unavailable).toContain('UNAVAILABLE')
    expect(r.unavailable).toContain('index.lock: File exists')
    expect(r.unavailable).toContain('does NOT mean')
  })

  it("a failed final capture (verified 'unknown') also becomes a notice", () => {
    const r = turnDiffs([{ verified: 'unknown' }])
    expect(r.patch).toBe('')
    expect(r.unavailable).toContain('UNAVAILABLE')
  })

  it('mixed: the patch of the captured turns goes along with the notice', () => {
    const r = turnDiffs([
      { files: ['a.ts'], patch: 'patch-a', verified: 'changed' },
      { failed: true, captureError: 'lock' },
    ])
    expect(r.patch).toContain('patch-a')
    expect(r.unavailable).toContain('only the turns that were captured')
  })

  it('with no snapshot recorded, the channel is empty — and that is said', () => {
    const r = turnDiffs([])
    expect(r.patch).toBe('')
    expect(r.unavailable).toContain('UNAVAILABLE')
  })
})

describe('folderDiff', () => {
  let tmp: string
  let repo: string

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim()

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-orch-diff-')))
    userData.dir = path.join(tmp, 'userData')
    repo = path.join(tmp, 'repo')
    fs.mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'core.autocrlf', 'false')
    fs.writeFileSync(path.join(repo, 'a.txt'), 'line 1\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'init')
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('shows what changed in the folder — including staged changes (the worker runs git add)', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'changed\n')
    git(repo, 'add', 'a.txt')
    const d = await folderDiff(repo)
    expect(d).toContain('a.txt')
    expect(d).toContain('shared')
    expect(d).toContain('changed')
  })

  it('a clean folder returns nothing', async () => {
    expect(await folderDiff(repo)).toBe('')
  })

  it('a folder that is not a repository returns nothing (and does not throw)', async () => {
    const loose = path.join(tmp, 'loose')
    fs.mkdirSync(loose)
    expect(await folderDiff(loose)).toBe('')
  })
})
