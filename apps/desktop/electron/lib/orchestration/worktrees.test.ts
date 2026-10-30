import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrchestrationTask } from '@shared/chat'

const userData = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => userData.dir } }))
vi.mock('../shell-env', () => ({ userShellEnv: () => process.env }))
vi.mock('../snapshot', () => ({ descartarSnapshots: vi.fn(async () => {}) }))
vi.mock('../app-settings', () => ({ getAppSettings: () => ({ worktrees: { local: 'default', folder: null } }) }))

const { commitWork, createWorkerWorktree, mergeBranches, removeWorkerWorktree, worktreeDiff, worktreeFiles } = await import('./worktrees')

let tmp: string
let repo: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim()
}

const task = (id: string, title: string): OrchestrationTask => ({ id, title, prompt: '', options: {}, status: 'idle' })

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-orch-wt-')))
  userData.dir = path.join(tmp, 'userData')
  repo = path.join(tmp, 'repo')
  fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  // Git on Windows comes with core.autocrlf=true and rewrites files with CRLF
  // on checkout; the tests read the content expecting \n. The repository is
  // temporary, so the setting stays local.
  git(repo, 'config', 'core.autocrlf', 'false')
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'line 1\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
  fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1')
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('worktree per worker', () => {
  it('creates it on branch orchestra/<plan>/<task>, commits without the .env and merges into the chat', async () => {
    const { worktree: wa } = await createWorkerWorktree({ chatFolder: repo, planId: 'plan_abc123', task: task('a', 'Part A'), dependencies: [] })
    expect(wa.branch).toBe('orchestra/abc123/part-a')
    expect(wa.base).toBe('main')
    expect(fs.readFileSync(path.join(wa.path, '.env'), 'utf8')).toBe('SECRET=1')

    fs.writeFileSync(path.join(wa.path, 'b.txt'), 'new\n')
    expect(await worktreeDiff(wa)).toContain('b.txt')
    expect(await commitWork(wa, 'Part A')).toBe(true)
    expect(git(wa.path, 'show', '--stat', '--format=%s', 'HEAD')).not.toContain('.env')

    const r = await mergeBranches(repo, [{ title: 'Part A', worktree: wa }])
    expect(r).toEqual({ merged: ['Part A'] })
    expect(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8')).toBe('new\n')

    await removeWorkerWorktree(wa, true)
    expect(fs.existsSync(wa.path)).toBe(false)
    expect(git(repo, 'branch', '--list', wa.branch)).toBe('')
  })

  it("worker's files: committed, uncommitted and new, relative to the chat subfolder", async () => {
    fs.mkdirSync(path.join(repo, 'app'))
    fs.writeFileSync(path.join(repo, 'app', 'x.ts'), 'x\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'app')
    const { worktree } = await createWorkerWorktree({ chatFolder: path.join(repo, 'app'), planId: 'plan_1', task: task('a', 'A'), dependencies: [] })
    fs.writeFileSync(path.join(worktree.folder, 'x.ts'), 'changed\n')
    await commitWork(worktree, 'A')
    fs.writeFileSync(path.join(worktree.folder, 'new.ts'), 'n\n')
    fs.writeFileSync(path.join(worktree.path, 'a.txt'), 'outside the subfolder\n')
    expect((await worktreeFiles(worktree)).sort()).toEqual(['../a.txt', 'new.ts', 'x.ts'])
  })

  it('a dependent starts from the dependency branch', async () => {
    const { worktree: api } = await createWorkerWorktree({ chatFolder: repo, planId: 'plan_1', task: task('api', 'API'), dependencies: [] })
    fs.writeFileSync(path.join(api.path, 'api.txt'), 'api\n')
    await commitWork(api, 'API')
    const { worktree: tests } = await createWorkerWorktree({ chatFolder: repo, planId: 'plan_1', task: task('t', 'Tests'), dependencies: [api] })
    expect(tests.base).toBe(api.branch)
    expect(fs.existsSync(path.join(tests.path, 'api.txt'))).toBe(true)
  })

  it('a merge conflict undoes that merge and stops, reporting the files', async () => {
    const { worktree: wa } = await createWorkerWorktree({ chatFolder: repo, planId: 'plan_1', task: task('a', 'A'), dependencies: [] })
    const { worktree: wb } = await createWorkerWorktree({ chatFolder: repo, planId: 'plan_1', task: task('b', 'B'), dependencies: [] })
    fs.writeFileSync(path.join(wa.path, 'a.txt'), 'version A\n')
    fs.writeFileSync(path.join(wb.path, 'a.txt'), 'version B\n')
    await commitWork(wa, 'A')
    await commitWork(wb, 'B')

    const r = await mergeBranches(repo, [
      { title: 'A', worktree: wa },
      { title: 'B', worktree: wb },
    ])
    expect(r.merged).toEqual(['A'])
    expect(r.conflict).toEqual({ title: 'B', files: ['a.txt'] })
    // The chat stays clean, with A merged and no half-done merge
    expect(git(repo, 'status', '--porcelain')).toBe('')
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('version A\n')
  })

  it('an uncommitted change in the chat in a file the worker changed: nothing is merged and the file is pointed out', async () => {
    const { worktree: wa } = await createWorkerWorktree({ chatFolder: repo, planId: 'plan_1', task: task('a', 'A'), dependencies: [] })
    fs.writeFileSync(path.join(wa.path, 'a.txt'), "the worker's\n")
    await commitWork(wa, 'A')
    fs.writeFileSync(path.join(repo, 'a.txt'), 'my draft\n')

    const r = await mergeBranches(repo, [{ title: 'A', worktree: wa }])
    expect(r).toEqual({ merged: [], blocked: { files: ['a.txt'] } })
    // The user's draft stays intact
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('my draft\n')
  })

  it('a worktree created by a previous version (legacy prefix stored in the plan) still merges', async () => {
    // No migration on purpose: the branch name and the folder are stored per
    // task in the plan, so any prefix the plan carries keeps working.
    const legacy = path.join(tmp, 'legacy-worktrees', 'part-a')
    fs.mkdirSync(path.dirname(legacy), { recursive: true })
    git(repo, 'worktree', 'add', '--no-track', '-b', 'legacy-orchestra/abc123/part-a', legacy, 'main')
    fs.writeFileSync(path.join(legacy, 'legacy.txt'), 'legacy\n')
    await commitWork({ path: legacy, folder: legacy, branch: 'legacy-orchestra/abc123/part-a', base: 'main' }, 'Legacy')

    const r = await mergeBranches(repo, [
      { title: 'Legacy', worktree: { path: legacy, folder: legacy, branch: 'legacy-orchestra/abc123/part-a', base: 'main' } },
    ])
    expect(r).toEqual({ merged: ['Legacy'] })
    expect(fs.readFileSync(path.join(repo, 'legacy.txt'), 'utf8')).toBe('legacy\n')
    await removeWorkerWorktree({ path: legacy, folder: legacy, branch: 'legacy-orchestra/abc123/part-a', base: 'main' }, true)
    expect(fs.existsSync(legacy)).toBe(false)
  })

  it('an uncommitted change in a file no worker touched does not get in the way', async () => {
    const { worktree: wa } = await createWorkerWorktree({ chatFolder: repo, planId: 'plan_1', task: task('a', 'A'), dependencies: [] })
    fs.writeFileSync(path.join(wa.path, 'new.txt'), 'x\n')
    await commitWork(wa, 'A')
    fs.writeFileSync(path.join(repo, 'a.txt'), 'my draft\n')

    const r = await mergeBranches(repo, [{ title: 'A', worktree: wa }])
    expect(r).toEqual({ merged: ['A'] })
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('my draft\n')
  })
})
