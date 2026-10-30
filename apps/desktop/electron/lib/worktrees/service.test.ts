import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const userData = vi.hoisted(() => ({ dir: '' }))
const processes = vi.hoisted(() => ({ list: [] as Array<{ pid: number; cwd: string; status: string }>, killed: [] as number[] }))
const config = vi.hoisted(() => ({ worktrees: { local: 'default' as 'default' | 'project' | 'custom', folder: null as string | null } }))
vi.mock('electron', () => ({ app: { getPath: () => userData.dir } }))
vi.mock('../app-settings', () => ({ getAppSettings: () => config }))
vi.mock('../shell-env', () => ({ userShellEnv: () => process.env }))
vi.mock('../snapshot', () => ({ descartarSnapshots: vi.fn(async () => {}) }))
vi.mock('../process-manager', () => ({
  listProcesses: () => processes.list,
  killProcess: vi.fn(async (pid: number) => {
    processes.killed.push(pid)
    return true
  }),
}))

const { createChatWorktree, readPorcelain, listWorktrees, removeChatWorktree, validateWorktreesFolder } = await import('./service')
const { clearMainCache } = await import('./main')

let tmp: string
let repo: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim()
}

function write(root: string, relative: string, content = 'x') {
  const target = path.join(root, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

beforeEach(() => {
  clearMainCache()
  config.worktrees = { local: 'default', folder: null }
  processes.list = []
  processes.killed = []
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-wt-chat-')))
  userData.dir = path.join(tmp, 'userData')
  repo = path.join(tmp, 'My Project')
  fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  write(repo, '.gitignore', 'node_modules/\n.env\n')
  write(repo, 'apps/web/index.ts')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
  write(repo, '.env', 'SECRET=1')
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('readPorcelain', () => {
  it('reads branch, detached, bare and prunable', () => {
    const blocks = readPorcelain(
      [
        'worktree /r',
        'HEAD aaa',
        'branch refs/heads/main',
        '',
        'worktree /w1',
        'HEAD bbb',
        'detached',
        '',
        'worktree /w2',
        'HEAD ccc',
        'branch refs/heads/orbit/x',
        'prunable gitdir file points to non-existent location',
        '',
      ].join('\n'),
    )
    expect(blocks.map((b) => [b.path, b.branch, b.prunable])).toEqual([
      ['/r', 'main', false],
      ['/w1', undefined, false],
      ['/w2', 'orbit/x', true],
    ])
  })
})

describe('create and list', () => {
  it('creates on the orbit/<name> branch, with a suffix when the name already exists, and brings .env along', async () => {
    const a = await createChatWorktree({ folder: repo, name: 'Refactor Login' })
    const b = await createChatWorktree({ folder: repo, name: 'Refactor Login' })

    expect(a.branch).toBe('orbit/refactor-login')
    expect(b.branch).toBe('orbit/refactor-login-2')
    expect(a.base).toBe('main')
    expect(a.path.startsWith(path.join(userData.dir, 'orbit-data', 'worktrees', 'chats', 'my-project-'))).toBe(true)
    expect(fs.readFileSync(path.join(a.path, '.env'), 'utf8')).toBe('SECRET=1')
    expect(git(a.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('orbit/refactor-login')
  })

  it('a chat in a subfolder stays in the same subfolder of the worktree', async () => {
    const created = await createChatWorktree({ folder: path.join(repo, 'apps/web'), name: 'x' })
    expect(created.folder).toBe(path.join(created.path, 'apps/web'))
  })

  it('lists the main one first, with origin, state and the equivalent folder in each one', async () => {
    const chat = await createChatWorktree({ folder: repo, name: 'chat' })
    write(chat.path, 'new.txt')
    git(chat.path, 'add', 'new.txt')
    git(chat.path, 'commit', '-qm', 'new')
    write(chat.path, 'dirty.txt')

    const external = path.join(tmp, 'external')
    git(repo, 'worktree', 'add', '-q', '-b', 'handmade', external)
    const pipelineWorktree = path.join(userData.dir, 'orbit-data', 'worktrees', 'proj_1', 'task_1')
    git(repo, 'worktree', 'add', '-q', '-b', 'pipeline/t', pipelineWorktree)

    const list = await listWorktrees(path.join(chat.path, 'apps/web'))
    expect(list).not.toBeNull()
    expect(list!.repo).toBe(repo)
    expect(list!.current).toBe(chat.path)
    const byOrigin = Object.fromEntries(list!.worktrees.map((w) => [w.origin, w]))
    expect(list!.worktrees[0].primary).toBe(true)
    expect(byOrigin.main.folder).toBe(path.join(repo, 'apps/web'))
    expect(byOrigin.chat.changes).toBe(1)
    expect(byOrigin.chat.ahead).toBe(1)
    expect(byOrigin.external.branch).toBe('handmade')
    expect(byOrigin.pipeline.path).toBe(pipelineWorktree)
  })

  it('a folder outside a git repository has no worktrees', async () => {
    const loose = path.join(tmp, 'loose')
    fs.mkdirSync(loose)
    expect(await listWorktrees(loose)).toBeNull()
  })
})

describe('remove', () => {
  it('deletes the folder, stops processes inside it and keeps the branch', async () => {
    const created = await createChatWorktree({ folder: repo, name: 'bye' })
    processes.list = [
      { pid: 11, cwd: path.join(created.path, 'apps/web'), status: 'running' },
      { pid: 22, cwd: repo, status: 'running' },
    ]
    await removeChatWorktree({ folder: repo, path: created.path })

    expect(fs.existsSync(created.path)).toBe(false)
    expect(processes.killed).toEqual([11])
    expect(git(repo, 'branch', '--list', 'orbit/bye')).toContain('orbit/bye')
    expect(git(repo, 'worktree', 'list')).not.toContain('bye')
  })

  it('deletes the branch when asked', async () => {
    const created = await createChatWorktree({ folder: repo, name: 'bye' })
    await removeChatWorktree({ folder: repo, path: created.path, deleteBranch: true })
    expect(git(repo, 'branch', '--list', 'orbit/bye')).toBe('')
  })

  it('refuses the main one and the pipeline ones', async () => {
    await expect(removeChatWorktree({ folder: repo, path: repo })).rejects.toThrow(/main repository/)
    const pipelineWorktree = path.join(userData.dir, 'orbit-data', 'worktrees', 'proj_1', 'task_1')
    git(repo, 'worktree', 'add', '-q', '-b', 'pipeline/t', pipelineWorktree)
    await expect(removeChatWorktree({ folder: repo, path: pipelineWorktree })).rejects.toThrow(/pipeline/)
    expect(fs.existsSync(pipelineWorktree)).toBe(true)
  })

  it('removes a worktree whose folder was already deleted by hand', async () => {
    const created = await createChatWorktree({ folder: repo, name: 'gone' })
    fs.rmSync(created.path, { recursive: true, force: true })
    const before = await listWorktrees(repo)
    expect(before!.worktrees.find((w) => w.path === created.path)?.available).toBe(false)

    await removeChatWorktree({ folder: repo, path: created.path })
    expect(git(repo, 'worktree', 'list')).not.toContain('gone')
  })
})

describe('equivalent folder', () => {
  it('falls back to the worktree root when the chat subfolder does not exist in it', async () => {
    const created = await createChatWorktree({ folder: repo, name: 'other' })
    write(repo, 'only-in-main/a.txt')
    const list = await listWorktrees(path.join(repo, 'only-in-main'))
    expect(list!.worktrees.find((w) => w.path === created.path)?.folder).toBe(created.path)
  })
})

describe('worktrees location (preference)', () => {
  it('inside the project: .orbit/worktrees, outside the main one git', async () => {
    config.worktrees = { local: 'project', folder: null }
    const a = await createChatWorktree({ folder: repo, name: 'inside' })
    await createChatWorktree({ folder: repo, name: 'other' })

    expect(a.path).toBe(path.join(repo, '.orbit', 'worktrees', 'inside'))
    // The main one does not see the worktrees as new files
    expect(git(repo, 'status', '--porcelain')).toBe('')
    const exclude = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude.match(/^\/\.orbit\/$/gm)).toHaveLength(1)
    // Does not copy other worktrees' dependencies into the worktree
    expect(fs.existsSync(path.join(a.path, '.orbit'))).toBe(false)

    const list = await listWorktrees(repo)
    expect(list!.worktrees.filter((w) => w.origin === 'chat')).toHaveLength(2)
  })

  it('chosen folder: chats/<repo>/<name> inside it', async () => {
    const chosen = path.join(tmp, 'my-worktrees')
    config.worktrees = { local: 'custom', folder: chosen }
    const created = await createChatWorktree({ folder: repo, name: 'outside' })
    expect(created.path.startsWith(path.join(chosen, 'chats', 'my-project-'))).toBe(true)
  })

  it('recognizes by the branch: pipeline/ inside the project is the pipeline; orbit/ outside Orbit is a chat', async () => {
    const pipelineWorktree = path.join(repo, '.orbit', 'worktrees', 'pipeline', 'task_1')
    git(repo, 'worktree', 'add', '-q', '-b', 'pipeline/t', pipelineWorktree)
    const legacyWorktree = path.join(repo, '.orbit', 'worktrees', 'esteira', 'task_2')
    git(repo, 'worktree', 'add', '-q', '-b', 'esteira/legacy', legacyWorktree)
    const loose = path.join(tmp, 'loose')
    git(repo, 'worktree', 'add', '-q', '-b', 'orbit/old', loose)

    const list = await listWorktrees(repo)
    const origin = (c: string) => list!.worktrees.find((w) => w.path === c)?.origin
    expect(origin(pipelineWorktree)).toBe('pipeline')
    expect(origin(legacyWorktree)).toBe('pipeline')
    expect(origin(loose)).toBe('chat')
  })

  it('checks the chosen folder', async () => {
    expect((await validateWorktreesFolder(path.join(repo, 'apps'))).insideRepository).toBe(true)
    const outside = path.join(tmp, 'outside')
    fs.mkdirSync(outside)
    expect(await validateWorktreesFolder(outside)).toMatchObject({ exists: true, insideRepository: false })
    expect((await validateWorktreesFolder(path.join(tmp, 'does-not-exist'))).exists).toBe(false)
  })
})

describe('updated remote base', () => {
  it('starts from origin/main after a fetch, without unpushed local commits and without upstream', async () => {
    const remote = path.join(tmp, 'remote.git')
    git(tmp, 'init', '-q', '--bare', '-b', 'main', remote)
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '-q', 'origin', 'main')
    git(repo, 'remote', 'set-head', 'origin', 'main')
    // Someone pushed a commit to the remote…
    const otherCopy = path.join(tmp, 'other')
    git(tmp, 'clone', '-q', remote, otherCopy)
    write(otherCopy, 'from-remote.txt')
    git(otherCopy, 'add', '-A')
    git(otherCopy, 'commit', '-qm', 'remote')
    git(otherCopy, 'push', '-q', 'origin', 'main')
    // …and here there is a local commit that was not pushed.
    write(repo, 'local-only.txt')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'local')

    const list = await listWorktrees(repo)
    expect(list!.defaultRemote).toBe('origin/main')
    const created = await createChatWorktree({ folder: repo, name: 'fresh', base: '@remote' })

    expect(created.base).toBe('origin/main')
    expect(fs.existsSync(path.join(created.path, 'from-remote.txt'))).toBe(true)
    expect(fs.existsSync(path.join(created.path, 'local-only.txt'))).toBe(false)
    expect(() => git(created.path, 'rev-parse', '--abbrev-ref', '@{u}')).toThrow()
  })

  it('with no remote, it explains instead of creating', async () => {
    await expect(createChatWorktree({ folder: repo, name: 'x', base: '@remote' })).rejects.toThrow(/remote/)
  })
})
