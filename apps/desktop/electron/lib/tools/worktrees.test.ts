import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeList } from '@shared/worktrees'

const state = vi.hoisted(() => ({
  session: { id: 's1', directory: '/repo' } as Record<string, unknown>,
  events: [] as unknown[],
  list: null as WorktreeList | null,
}))

vi.mock('../storage', () => ({
  readJson: async () => state.session,
  writeJson: async (_k: string, value: Record<string, unknown>) => {
    state.session = value
  },
}))
vi.mock('../broadcast', () => ({ broadcastChatEvent: (e: unknown) => state.events.push(e) }))
const service = vi.hoisted(() => ({
  listWorktrees: vi.fn(async () => state.list),
  createChatWorktree: vi.fn(async () => ({
    path: '/wt/new',
    folder: '/wt/new/apps/web',
    branch: 'orbit/new',
    base: 'main',
    dependencies: 'cloned',
  })),
  removeChatWorktree: vi.fn(async () => {}),
}))
vi.mock('../worktrees/service', () => service)

const { createWorktreeTools } = await import('./worktrees')
const { assess } = await import('../permission/rules')

const ctx = { sessionId: 's1', directory: '/repo/apps/web', extraDirectories: [], abort: new AbortController().signal }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (name: string, args: unknown) => (createWorktreeTools(ctx)[name] as any).execute(args, {}) as Promise<string>

const w = (worktreePath: string, extra: Partial<WorktreeList['worktrees'][number]> = {}) => ({
  path: worktreePath,
  folder: `${worktreePath}/apps/web`,
  name: worktreePath.split('/').pop()!,
  branch: 'main',
  head: 'abc1234',
  primary: false,
  origin: 'chat' as const,
  available: true,
  locked: false,
  changes: 0,
  ahead: 0,
  ...extra,
})

beforeEach(() => {
  state.session = { id: 's1', directory: '/repo/apps/web' }
  state.events = []
  state.list = {
    repo: '/repo',
    current: '/repo',
    worktrees: [w('/repo', { primary: true, origin: 'main' }), w('/wt/login', { branch: 'orbit/login' })],
  }
  service.removeChatWorktree.mockClear()
})

describe('worktree tools', () => {
  it('worktree_create switches the session folder (same subfolder) and tells the UI', async () => {
    const output = await run('worktree_create', { name: 'new' })
    expect(state.session.directory).toBe('/wt/new/apps/web')
    expect(state.events).toHaveLength(1)
    expect(output).toContain('NEXT message')
  })

  it('worktree_create with switchChat=false does not touch the session', async () => {
    await run('worktree_create', { name: 'new', switchChat: false })
    expect(state.session.directory).toBe('/repo/apps/web')
    expect(state.events).toHaveLength(0)
  })

  it('worktree_switch finds it by the branch name without the prefix and goes back to the main one', async () => {
    await run('worktree_switch', { target: 'login' })
    expect(state.session.directory).toBe('/wt/login/apps/web')
    state.list!.current = '/wt/login'
    await run('worktree_switch', { target: 'main' })
    expect(state.session.directory).toBe('/repo/apps/web')
  })

  it('worktree_remove refuses the worktree the chat is in', async () => {
    state.list!.current = '/wt/login'
    const output = await run('worktree_remove', { target: 'login' })
    expect(output).toContain('Switch to another one first')
    expect(service.removeChatWorktree).not.toHaveBeenCalled()
  })

  it('worktree_remove removes another worktree', async () => {
    await run('worktree_remove', { target: 'orbit/login', deleteBranch: true })
    expect(service.removeChatWorktree).toHaveBeenCalledWith({ folder: '/repo/apps/web', path: '/wt/login', deleteBranch: true })
  })
})

describe('approval', () => {
  it('list, create and switch do not ask permission; remove always asks', () => {
    expect(assess('worktree_list', {}, '/repo')).toBeNull()
    expect(assess('worktree_create', { name: 'x' }, '/repo')).toBeNull()
    expect(assess('worktree_switch', { target: 'x' }, '/repo')).toBeNull()
    const remove = assess('worktree_remove', { target: 'login' }, '/repo')
    expect(remove?.alwaysAsk).toBe(true)
    expect(remove?.ruleId).toBe('worktree:remove')
  })
})
