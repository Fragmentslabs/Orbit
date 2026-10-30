import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const userData = vi.hoisted(() => ({ dir: '' }))
const config = vi.hoisted(() => ({
  worktrees: { local: 'default' as 'default' | 'project' | 'custom', folder: null as string | null },
}))
vi.mock('electron', () => ({ app: { getPath: () => userData.dir } }))
vi.mock('../app-settings', () => ({ getAppSettings: () => config }))
vi.mock('../shell-env', () => ({ userShellEnv: () => process.env }))
vi.mock('../snapshot', () => ({ discardSnapshots: vi.fn(async () => {}) }))

const { findExtras, branchName, cleanOrphans, createWorktree, removeWorktree, slug } = await import('./worktree')

let tmp: string
let repo: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function writeFile(root: string, relative: string, content = 'x') {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

beforeEach(() => {
  config.worktrees = { local: 'default', folder: null }
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-wt-')))
  userData.dir = path.join(tmp, 'userData')
  repo = path.join(tmp, 'repo')
  fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 't@t')
  git(repo, 'config', 'user.name', 't')
  writeFile(repo, '.gitignore', 'node_modules/\n.env*\n!.env.example\n')
  writeFile(repo, 'package.json', '{}')
  writeFile(repo, 'apps/web/package.json', '{}')
  writeFile(repo, '.env.example', 'EXEMPLO=1')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
  // Ignored files: they have to be carried into the worktree separately
  writeFile(repo, 'node_modules/lib/index.js', 'raiz')
  writeFile(repo, 'node_modules/lib/node_modules/sub/index.js', 'aninhado')
  writeFile(repo, 'apps/web/node_modules/react/index.js', 'web')
  writeFile(repo, '.env', 'SEGREDO=1')
  writeFile(repo, 'apps/web/.env.local', 'WEB=1')
})

afterEach(() => {
  try {
    git(repo, 'worktree', 'prune')
  } catch {
    // the repo may not exist anymore
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

const task = { id: 'task_abc123XYZ', title: 'Calculate shipping (v2)!', worktree: undefined }

describe('names', () => {
  it('slug strips accents and symbols', () => {
    expect(slug('Action: Calculate Shipping (v2)!')).toBe('action-calculate-shipping-v2')
    expect(slug('!!!')).toBe('task')
  })
  it('branch is readable and unique through the id', () => {
    expect(branchName(task)).toBe('pipeline/calculate-shipping-v2-123xyz')
  })
})

describe('findExtras', () => {
  it('finds the workspace node_modules without descending into them, plus the .env files', async () => {
    const { modules, envs } = await findExtras(repo)
    // path.join: the service returns relative paths with the system separator,
    // so the expectation cannot hardcode '/'.
    expect(modules.sort()).toEqual([path.join('apps/web', 'node_modules'), 'node_modules'])
    expect(envs.sort()).toEqual(['.env', '.env.example', path.join('apps/web', '.env.local')])
  })
})

describe('createWorktree', () => {
  it('creates the branch from the base and carries .env and node_modules over', async () => {
    const wt = await createWorktree({ mainFolder: repo, projectId: 'proj_1', task })

    expect(wt.path).toBe(path.join(userData.dir, 'orbit-data', 'worktrees', 'proj_1', task.id))
    expect(wt.folder).toBe(wt.path)
    expect(wt.branch).toBe('pipeline/calculate-shipping-v2-123xyz')
    expect(wt.base).toBe('main')
    expect(git(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(wt.branch)
    expect(fs.readFileSync(path.join(wt.path, '.env'), 'utf8')).toBe('SEGREDO=1')
    expect(fs.readFileSync(path.join(wt.path, 'apps/web/.env.local'), 'utf8')).toBe('WEB=1')
    expect(fs.readFileSync(path.join(wt.path, 'apps/web/node_modules/react/index.js'), 'utf8')).toBe('web')
    expect(fs.readFileSync(path.join(wt.path, 'node_modules/lib/node_modules/sub/index.js'), 'utf8')).toBe('aninhado')
    if (process.platform === 'darwin') expect(wt.dependencies).toBe('cloned')

    // Cloned (or linked): touching the worktree must not change the main one when cloned
    if (wt.dependencies === 'cloned') {
      fs.writeFileSync(path.join(wt.path, 'node_modules/lib/index.js'), 'mudou')
      expect(fs.readFileSync(path.join(repo, 'node_modules/lib/index.js'), 'utf8')).toBe('raiz')
    }
  })

  it('main folder inside a subfolder of the repository: the working folder is the same subfolder in the worktree', async () => {
    const wt = await createWorktree({ mainFolder: path.join(repo, 'apps/web'), projectId: 'proj_1', task })
    expect(wt.folder).toBe(path.join(wt.path, 'apps/web'))
  })

  it('starts from the requested base (branch of a dependency)', async () => {
    git(repo, 'branch', 'pipeline/dependencia')
    const wt = await createWorktree({ mainFolder: repo, projectId: 'proj_1', task, base: 'pipeline/dependencia' })
    expect(wt.base).toBe('pipeline/dependencia')
  })

  it('recreates it on the same branch when the folder is gone, with the committed work', async () => {
    const wt = await createWorktree({ mainFolder: repo, projectId: 'proj_1', task })
    writeFile(wt.path, 'done.txt', 'work')
    git(wt.path, 'add', 'done.txt')
    git(wt.path, 'commit', '-qm', 'work')
    fs.rmSync(wt.path, { recursive: true, force: true })

    const recreated = await createWorktree({ mainFolder: repo, projectId: 'proj_1', task: { ...task, worktree: wt } })
    expect(recreated.branch).toBe(wt.branch)
    expect(fs.readFileSync(path.join(recreated.path, 'done.txt'), 'utf8')).toBe('work')
  })

  it('refuses a folder that is not a git repository', async () => {
    const loose = path.join(tmp, 'solta')
    fs.mkdirSync(loose)
    await expect(createWorktree({ mainFolder: loose, projectId: 'p', task })).rejects.toThrow(
      /not a git repository/,
    )
  })

  it('refuses a repository without commits', async () => {
    const empty = path.join(tmp, 'empty')
    fs.mkdirSync(empty)
    git(empty, 'init', '-q')
    await expect(createWorktree({ mainFolder: empty, projectId: 'p', task })).rejects.toThrow(/no commit yet/)
  })
})

describe('removeWorktree and cleanOrphans', () => {
  it('removes the folder and keeps the branch, unless asked to delete it', async () => {
    const wt = await createWorktree({ mainFolder: repo, projectId: 'proj_1', task })
    await removeWorktree(repo, wt)
    expect(fs.existsSync(wt.path)).toBe(false)
    expect(git(repo, 'branch', '--list', wt.branch)).toContain(wt.branch)
    // The main node_modules must not go with it (linked case)
    expect(fs.existsSync(path.join(repo, 'node_modules/lib/index.js'))).toBe(true)

    const other = await createWorktree({ mainFolder: repo, projectId: 'proj_1', task: { ...task, id: 'task_other000' } })
    await removeWorktree(repo, other, { deleteBranch: true })
    expect(git(repo, 'branch', '--list', other.branch)).toBe('')
  })

  it('deletes worktrees of tasks that no longer exist and keeps the live ones', async () => {
    const alive = await createWorktree({ mainFolder: repo, projectId: 'proj_1', task })
    const orphan = await createWorktree({ mainFolder: repo, projectId: 'proj_1', task: { ...task, id: 'task_orphan0000' } })

    await cleanOrphans([{ id: 'proj_1', folders: [repo] }], new Map([['proj_1', new Set([task.id])]]))

    expect(fs.existsSync(alive.path)).toBe(true)
    expect(fs.existsSync(orphan.path)).toBe(false)
    expect(git(repo, 'worktree', 'list')).not.toContain('task_orphan0000')
  })

  it('does not touch the chat worktrees, which live under the same root', async () => {
    const chatWorktree = path.join(userData.dir, 'orbit-data', 'worktrees', 'chats', 'repo-abc123', 'login')
    fs.mkdirSync(chatWorktree, { recursive: true })
    fs.writeFileSync(path.join(chatWorktree, 'work.txt'), 'not committed')

    await cleanOrphans([{ id: 'proj_1', folders: [repo] }], new Map())

    expect(fs.readFileSync(path.join(chatWorktree, 'work.txt'), 'utf8')).toBe('not committed')
  })

  it('inside the project: creates in .orbit/worktrees/pipeline and sweeps the orphans from there', async () => {
    config.worktrees = { local: 'project', folder: null }
    const alive = await createWorktree({ mainFolder: repo, projectId: 'proj_1', task })
    const orphan = await createWorktree({ mainFolder: repo, projectId: 'proj_1', task: { ...task, id: 'task_orphan0000' } })
    expect(alive.path).toBe(path.join(repo, '.orbit', 'worktrees', 'pipeline', task.id))

    await cleanOrphans([{ id: 'proj_1', folders: [repo] }], new Map([['proj_1', new Set([task.id])]]))
    expect(fs.existsSync(alive.path)).toBe(true)
    expect(fs.existsSync(orphan.path)).toBe(false)
  })

  it('custom folder: creates there and sweeps the orphans from there too', async () => {
    const custom = path.join(tmp, 'chosen-folder')
    config.worktrees = { local: 'custom', folder: custom }
    const orphan = await createWorktree({ mainFolder: repo, projectId: 'proj_1', task })
    expect(orphan.path).toBe(path.join(custom, 'proj_1', task.id))

    await cleanOrphans([{ id: 'proj_1', folders: [repo] }], new Map())
    expect(fs.existsSync(orphan.path)).toBe(false)
  })

  it('a worktree without a task but with uncommitted changes is not deleted', async () => {
    const orphan = await createWorktree({ mainFolder: repo, projectId: 'proj_1', task: { ...task, id: 'task_dirty0000' } })
    fs.writeFileSync(path.join(orphan.path, 'work.txt'), 'not committed')

    await cleanOrphans([{ id: 'proj_1', folders: [repo] }], new Map())

    expect(fs.readFileSync(path.join(orphan.path, 'work.txt'), 'utf8')).toBe('not committed')
  })
})
