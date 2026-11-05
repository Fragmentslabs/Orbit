import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Delivery, Pipeline, Project, Task, TaskWorktree } from '@shared/pipeline'

/**
 * The merge queue against REAL temporary git repositories: the git steps are the
 * thing most likely to be subtly wrong, so nothing about git is mocked. Only the
 * model (runPhase), the project checks and the data store are replaced.
 */

const userData = vi.hoisted(() => ({ dir: '' }))
const db = vi.hoisted(() => ({
  pipelines: [] as Pipeline[],
  projects: [] as Project[],
  tasks: [] as Task[],
  deliveries: [] as Delivery[],
}))
const fake = vi.hoisted(() => ({
  runPhase: vi.fn(),
  discoverChecks: vi.fn(async () => [] as unknown[]),
  runCheck: vi.fn(async () => ({ ok: true, output: '' })),
}))

vi.mock('electron', () => ({ app: { getPath: () => userData.dir } }))
vi.mock('../app-settings', () => ({ getAppSettings: () => ({ worktrees: { local: 'default', folder: null } }) }))
vi.mock('../shell-env', () => ({ userShellEnv: () => process.env }))
vi.mock('../snapshot', () => ({ discardSnapshots: vi.fn(async () => {}) }))
vi.mock('../broadcast', () => ({ broadcastPipelineEvent: vi.fn() }))
vi.mock('./runner', () => ({ runPhase: fake.runPhase }))
vi.mock('../orchestration/checks', () => ({ discoverChecks: fake.discoverChecks, runCheck: fake.runCheck }))
vi.mock('./media-cleanup', () => ({ mediaUrlsIn: () => [], deleteMediaUrls: vi.fn(async () => 0) }))
vi.mock('./commit', () => ({ tryCommit: vi.fn(async () => ({ hash: 'abc', tokens: 0, cost: 0 })) }))
vi.mock('./repo', () => ({
  listPipelines: async () => db.pipelines,
  listProjects: async () => db.projects,
  listTasks: async () => db.tasks,
  modifyTasks: async (_p: string, fn: (tasks: Task[]) => unknown) => fn(db.tasks),
  updateTask: async (_p: string, taskId: string, patch: (t: Task) => Task) => {
    const i = db.tasks.findIndex((t) => t.id === taskId)
    if (i < 0) return null
    db.tasks[i] = patch(db.tasks[i])
    return db.tasks[i]
  },
  patchPipeline: async (id: string, fn: (p: Pipeline) => Pipeline) => {
    const i = db.pipelines.findIndex((p) => p.id === id)
    if (i < 0) return null
    db.pipelines[i] = fn(db.pipelines[i])
    return db.pipelines[i]
  },
  addDelivery: async (pipelineId: string, data: Omit<Delivery, 'id' | 'number' | 'createdAt' | 'pipelineId'>) => {
    const delivery: Delivery = { ...data, id: `deliv_${db.deliveries.length + 1}`, pipelineId, number: db.deliveries.length + 1, createdAt: '' }
    db.deliveries.push(delivery)
    return delivery
  },
  listDeliveries: async () => db.deliveries,
  removeDelivery: async (_p: string, id: string) => {
    db.deliveries = db.deliveries.filter((d) => d.id !== id)
    return db.deliveries
  },
}))

const { createWorktree } = await import('./worktree')
const {
  archivedTaskDiff,
  deleteDelivery,
  drained,
  enqueueIntegration,
  ensureIntegration,
  integrationStatus,
  mergeIntegration,
  queuedState,
  recoverIntegrations,
  tuning,
} = await import('./integration')

let tmp: string
let repo: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function write(root: string, relative: string, content: string) {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

const read = (root: string, relative: string) => fs.readFileSync(path.join(root, relative), 'utf8')

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  number: Number(id.replace(/\D/g, '')) || 1,
  pipelineId: 'pipe_1',
  title: `Task ${id}`,
  description: '',
  status: 'completed',
  currentPhase: 0,
  dependsOn: [],
  notes: [],
  createdAt: '',
  workTimeMs: 0,
  tokens: 0,
  cost: 0,
  ...extra,
})

/**
 * Plays what the engine does for a task: its own worktree from the integration
 * branch, the edits committed, the task completed and queued. `enqueue: false`
 * leaves it queued without starting the step (to line several up first).
 */
async function prepareTask(id: string, edits: Record<string, string>): Promise<TaskWorktree> {
  const integration = await ensureIntegration('pipe_1')
  const created = await createWorktree({
    mainFolder: repo,
    projectId: 'proj_1',
    task: { id, title: `Task ${id}`, worktree: undefined },
    base: integration.branch,
  })
  for (const [file, content] of Object.entries(edits)) write(created.path, file, content)
  git(created.path, 'add', '-A')
  git(created.path, 'commit', '-qm', `work of ${id}`)
  db.tasks.push(task(id, { worktree: created, integration: queuedState(), finalCommitHash: git(created.path, 'rev-parse', '--short', 'HEAD') }))
  return created
}

const byId = (id: string) => db.tasks.find((t) => t.id === id)!
const integrationOf = () => db.pipelines[0].integration!

beforeEach(() => {
  tuning.waitMs = 20
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-int-')))
  userData.dir = path.join(tmp, 'userData')
  repo = path.join(tmp, 'repo')
  fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 't@t')
  git(repo, 'config', 'user.name', 't')
  write(repo, 'a.txt', 'one\ntwo\nthree\n')
  write(repo, 'b.txt', 'bee\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')

  db.projects = [{ id: 'proj_1', name: 'P', folders: [repo], createdAt: '', pipelines: ['pipe_1'] }]
  db.pipelines = [
    {
      id: 'pipe_1',
      projectId: 'proj_1',
      name: 'Board',
      phases: [],
      model: { providerId: 'p', modelId: 'm' },
      operationMode: 'manual',
      commitAtEnd: true,
      worktreePerTask: true,
      commandPolicy: { blocked: [], controlled: [] },
      createdAt: '',
    },
  ]
  db.tasks = []
  db.deliveries = []
  fake.runPhase.mockReset()
  fake.runPhase.mockResolvedValue({ text: '', note: 'ok', controlledCommands: [], tokens: 10, cost: 0.01 })
  fake.discoverChecks.mockReset()
  fake.discoverChecks.mockResolvedValue([])
  fake.runCheck.mockReset()
  fake.runCheck.mockResolvedValue({ ok: true, output: '' })
})

afterEach(async () => {
  await drained('pipe_1')
  try {
    git(repo, 'worktree', 'prune')
  } catch {
    // the repo may be gone
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the merge queue', () => {
  it('merges tasks that touch different files without calling the model', async () => {
    await prepareTask('t1', { 'a.txt': 'ONE\ntwo\nthree\n' })
    await prepareTask('t2', { 'b.txt': 'BEE\n' })
    await enqueueIntegration('pipe_1', 't1')
    await enqueueIntegration('pipe_1', 't2')

    expect(byId('t1').integration?.state).toBe('integrated')
    expect(byId('t2').integration?.state).toBe('integrated')
    expect(fake.runPhase).not.toHaveBeenCalled()
    const wt = integrationOf()
    expect(read(wt.path, 'a.txt')).toBe('ONE\ntwo\nthree\n')
    expect(read(wt.path, 'b.txt')).toBe('BEE\n')
    // each task is a merge commit of its own
    expect(git(wt.path, 'log', '--merges', '--format=%s')).toContain('#1 Task t1')
    expect(git(wt.path, 'log', '--merges', '--format=%s')).toContain('#2 Task t2')
    // the task folder is gone, its branch stays until delivery
    expect(fs.existsSync(byId('t1').worktree!.path)).toBe(false)
    expect(git(repo, 'branch', '--list', byId('t1').worktree!.branch)).not.toBe('')
    // the main checkout was never touched
    expect(git(repo, 'status', '--porcelain')).toBe('')
    expect(git(repo, 'rev-parse', 'main')).toBe(git(repo, 'rev-parse', 'HEAD'))
  })

  it('resolves a conflict in the task worktree with the pipeline model and merges', async () => {
    const w1 = await prepareTask('t1', { 'a.txt': 'one\nTWO-from-t1\nthree\n' })
    const w2 = await prepareTask('t2', { 'a.txt': 'one\nTWO-from-t2\nthree\n' })
    void w1
    fake.runPhase.mockImplementation(async (ctx: { folders: string[]; task: { description: string } }) => {
      expect(ctx.task.description).toContain('a.txt')
      write(ctx.folders[0], 'a.txt', 'one\nTWO-from-t1 and TWO-from-t2\nthree\n')
      return { text: '', note: 'merged both', controlledCommands: [], tokens: 100, cost: 0.5 }
    })
    await enqueueIntegration('pipe_1', 't1')
    await enqueueIntegration('pipe_1', 't2')

    expect(byId('t2').integration?.state).toBe('integrated')
    expect(fake.runPhase).toHaveBeenCalledTimes(1)
    // the conflict was resolved in the TASK worktree, then merged cleanly
    expect(fake.runPhase.mock.calls[0][0].folders[0]).toBe(w2.folder)
    expect(read(integrationOf().path, 'a.txt')).toBe('one\nTWO-from-t1 and TWO-from-t2\nthree\n')
    expect(byId('t2').cost).toBeCloseTo(0.5)
    expect(git(integrationOf().path, 'status', '--porcelain')).toBe('')
  })

  it('pauses the model after three attempts, leaving the integration untouched', async () => {
    await prepareTask('t1', { 'a.txt': 'one\nTWO-from-t1\nthree\n' })
    const w2 = await prepareTask('t2', { 'a.txt': 'one\nTWO-from-t2\nthree\n' })
    await enqueueIntegration('pipe_1', 't1')
    const before = git(integrationOf().path, 'rev-parse', 'HEAD')
    // the "model" edits the file but leaves the markers in
    fake.runPhase.mockImplementation(async () => ({ text: '', note: 'tried', controlledCommands: [], tokens: 1, cost: 0 }))
    await enqueueIntegration('pipe_1', 't2')

    expect(byId('t2').integration?.state).toBe('failed')
    expect(byId('t2').integration?.detail).toContain('a.txt')
    expect(fake.runPhase).toHaveBeenCalledTimes(3)
    expect(git(integrationOf().path, 'rev-parse', 'HEAD')).toBe(before)
    // no merge left half-done anywhere
    expect(fs.existsSync(path.join(git(w2.path, 'rev-parse', '--git-dir'), 'MERGE_HEAD'))).toBe(false)
    expect(git(w2.path, 'status', '--porcelain')).toBe('')
  })

  it('a check that fails after the merge goes back to the model, then passes', async () => {
    await prepareTask('t1', { 'a.txt': 'ONE\ntwo\nthree\n' })
    await prepareTask('t2', { 'b.txt': 'BEE\n' })
    await enqueueIntegration('pipe_1', 't1')
    fake.discoverChecks.mockResolvedValue([{ name: 'typecheck', command: 'x', args: [], folder: '.' }])
    let fixed = false
    fake.runCheck.mockImplementation(async () => (fixed ? { ok: true, output: '' } : { ok: false, output: 'TS2304: cannot find name' }))
    fake.runPhase.mockImplementation(async (ctx: { folders: string[]; task: { description: string } }) => {
      expect(ctx.task.description).toContain('TS2304')
      write(ctx.folders[0], 'b.txt', 'BEE fixed\n')
      fixed = true
      return { text: '', note: 'fixed', controlledCommands: [], tokens: 1, cost: 0 }
    })
    await enqueueIntegration('pipe_1', 't2')

    expect(byId('t2').integration?.state).toBe('integrated')
    expect(fake.runPhase).toHaveBeenCalledTimes(1)
    expect(read(integrationOf().path, 'b.txt')).toBe('BEE fixed\n')
  })

  it('does not run checks when the integration brought nothing new', async () => {
    fake.discoverChecks.mockResolvedValue([{ name: 'typecheck', command: 'x', args: [], folder: '.' }])
    await prepareTask('t1', { 'a.txt': 'ONE\ntwo\nthree\n' })
    await enqueueIntegration('pipe_1', 't1')

    expect(fake.runCheck).not.toHaveBeenCalled()
    expect(byId('t1').integration?.state).toBe('integrated')
  })

  it('waits while the person has uncommitted edits in a file the task changed, then goes on', async () => {
    await prepareTask('t1', { 'a.txt': 'ONE\ntwo\nthree\n' })
    const wt = integrationOf()
    write(wt.path, 'a.txt', 'my own edit\n')
    const running = enqueueIntegration('pipe_1', 't1')
    await vi.waitFor(() => expect(byId('t1').integration?.waitingFor).toEqual(['a.txt']))
    expect(byId('t1').integration?.state).toBe('queued')

    git(wt.path, 'checkout', '--', 'a.txt')
    await running
    expect(byId('t1').integration?.state).toBe('integrated')
  })

  it('edits in other files do not make the queue wait', async () => {
    await prepareTask('t1', { 'a.txt': 'ONE\ntwo\nthree\n' })
    write(integrationOf().path, 'notes.txt', 'mine')
    await enqueueIntegration('pipe_1', 't1')

    expect(byId('t1').integration?.state).toBe('integrated')
    expect(read(integrationOf().path, 'notes.txt')).toBe('mine')
  })

  it('a task worktree left with uncommitted changes fails with a clear reason', async () => {
    const w = await prepareTask('t1', { 'a.txt': 'ONE\ntwo\nthree\n' })
    write(w.path, 'loose.txt', 'x')
    await enqueueIntegration('pipe_1', 't1')

    expect(byId('t1').integration?.state).toBe('failed')
    expect(byId('t1').integration?.detail).toContain('loose.txt')
  })

  it('recovers a step that died halfway: aborts the merge and queues the task again', async () => {
    const w = await prepareTask('t1', { 'a.txt': 'one\nTWO-from-t1\nthree\n' })
    await prepareTask('t2', { 'a.txt': 'one\nTWO-from-t2\nthree\n' })
    await enqueueIntegration('pipe_1', 't2')
    // t1 conflicts; leave the merge open as a crash would
    try {
      git(w.path, 'merge', '--no-edit', integrationOf().branch)
    } catch {
      // expected conflict
    }
    db.tasks[0] = { ...byId('t1'), integration: { state: 'integrating', updatedAt: '' } }
    fake.runPhase.mockImplementation(async (ctx: { folders: string[] }) => {
      write(ctx.folders[0], 'a.txt', 'one\nboth\nthree\n')
      return { text: '', note: 'ok', controlledCommands: [], tokens: 1, cost: 0 }
    })
    await recoverIntegrations('pipe_1')
    await vi.waitFor(() => expect(byId('t1').integration?.state).toBe('integrated'), { timeout: 20_000, interval: 50 })
    expect(read(integrationOf().path, 'a.txt')).toBe('one\nboth\nthree\n')
  })
})

describe('Merge (delivery)', () => {
  it('fast-forwards the destination, archives the delivered tasks and deletes their branches', async () => {
    await prepareTask('t1', { 'a.txt': 'ONE\ntwo\nthree\n' })
    await prepareTask('t2', { 'b.txt': 'BEE\n' })
    const branch = byId('t1').worktree!.branch
    await enqueueIntegration('pipe_1', 't1')
    await enqueueIntegration('pipe_1', 't2')

    const outcome = await mergeIntegration('pipe_1', 'main')
    expect(outcome.status).toBe('delivered')
    // main is the integration, exactly (a fast-forward: no new commit)
    expect(git(repo, 'rev-parse', 'main')).toBe(git(integrationOf().path, 'rev-parse', 'HEAD'))
    // the checkout of main was updated too
    expect(read(repo, 'a.txt')).toBe('ONE\ntwo\nthree\n')
    expect(git(repo, 'status', '--porcelain')).toBe('')
    expect(byId('t1').deliveryId).toBeTruthy()
    expect(byId('t1').archivedAt).toBeTruthy()
    expect(git(repo, 'branch', '--list', branch)).toBe('')
    expect(db.deliveries).toHaveLength(1)
    expect(db.deliveries[0]).toMatchObject({ destination: 'main', taskNumbers: [1, 2] })
    // the integration keeps going from where it is
    expect(git(repo, 'branch', '--list', integrationOf().branch)).not.toBe('')
  })

  it('refuses with the file list when the integration has uncommitted changes', async () => {
    await prepareTask('t1', { 'a.txt': 'ONE\ntwo\nthree\n' })
    await enqueueIntegration('pipe_1', 't1')
    write(integrationOf().path, 'loose.txt', 'x')

    const outcome = await mergeIntegration('pipe_1', 'main')
    expect(outcome).toEqual({ status: 'dirty', files: ['loose.txt'] })
    expect(git(repo, 'rev-parse', 'main')).not.toBe(git(integrationOf().path, 'rev-parse', 'HEAD'))
    expect(db.deliveries).toHaveLength(0)
  })

  it('brings the destination in first when it moved on, then fast-forwards', async () => {
    await prepareTask('t1', { 'a.txt': 'ONE\ntwo\nthree\n' })
    await enqueueIntegration('pipe_1', 't1')
    // someone commits on main meanwhile
    write(repo, 'c.txt', 'from main\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'main moved')

    const outcome = await mergeIntegration('pipe_1', 'main')
    expect(outcome.status).toBe('delivered')
    expect(read(repo, 'c.txt')).toBe('from main\n')
    expect(read(repo, 'a.txt')).toBe('ONE\ntwo\nthree\n')
    expect(git(repo, 'rev-parse', 'main')).toBe(git(integrationOf().path, 'rev-parse', 'HEAD'))
  })

  it('moves only the ref when the destination is not checked out anywhere', async () => {
    await prepareTask('t1', { 'a.txt': 'ONE\ntwo\nthree\n' })
    await enqueueIntegration('pipe_1', 't1')
    git(repo, 'branch', 'release')

    const outcome = await mergeIntegration('pipe_1', 'release')
    expect(outcome.status).toBe('delivered')
    expect(git(repo, 'rev-parse', 'release')).toBe(git(integrationOf().path, 'rev-parse', 'HEAD'))
    // the checkout on main is untouched
    expect(read(repo, 'a.txt')).toBe('one\ntwo\nthree\n')
  })

  it('is blocked, with the files, when the destination checkout has uncommitted edits in the way', async () => {
    await prepareTask('t1', { 'a.txt': 'ONE\ntwo\nthree\n' })
    await enqueueIntegration('pipe_1', 't1')
    write(repo, 'a.txt', 'my local edit\n')

    const outcome = await mergeIntegration('pipe_1', 'main')
    expect(outcome).toMatchObject({ status: 'blocked', files: ['a.txt'] })
    expect(read(repo, 'a.txt')).toBe('my local edit\n')
    expect(db.deliveries).toHaveLength(0)
    expect(byId('t1').deliveryId).toBeUndefined()
  })

  it('leaves tasks that did not reach the integration on the board', async () => {
    await prepareTask('t1', { 'a.txt': 'ONE\ntwo\nthree\n' })
    await enqueueIntegration('pipe_1', 't1')
    db.tasks.push(task('t9', { integration: { state: 'failed', detail: 'x', updatedAt: '' } }))

    await mergeIntegration('pipe_1', 'main')
    expect(byId('t1').deliveryId).toBeTruthy()
    expect(byId('t9').deliveryId).toBeUndefined()
  })

  it('reads an archived task\'s diff from git by its merge commit', async () => {
    await prepareTask('t1', { 'a.txt': 'ONE\ntwo\nthree\n' })
    db.tasks[0].diff = { start: 's', files: ['a.txt'], patch: 'old patch' }
    await enqueueIntegration('pipe_1', 't1')
    await mergeIntegration('pipe_1', 'main')

    expect(byId('t1').diff?.patch).toBe('')
    const diff = await archivedTaskDiff('pipe_1', byId('t1'))
    expect(diff?.files).toEqual(['a.txt'])
    expect(diff?.patch).toContain('+ONE')
  })

  it('deleting a delivery removes its tasks and record, and leaves git alone', async () => {
    await prepareTask('t1', { 'a.txt': 'ONE\ntwo\nthree\n' })
    await enqueueIntegration('pipe_1', 't1')
    await mergeIntegration('pipe_1', 'main')
    const head = git(repo, 'rev-parse', 'main')

    await deleteDelivery('pipe_1', db.deliveries[0].id)
    expect(db.tasks).toHaveLength(0)
    expect(db.deliveries).toHaveLength(0)
    expect(git(repo, 'rev-parse', 'main')).toBe(head)
  })

  it('reports the integration status', async () => {
    await prepareTask('t1', { 'a.txt': 'ONE\ntwo\nthree\n' })
    await enqueueIntegration('pipe_1', 't1')
    write(integrationOf().path, 'loose.txt', 'x')

    expect(await integrationStatus('pipe_1')).toMatchObject({ base: 'main', ahead: 2, dirty: ['loose.txt'], queued: 0 })
  })
})
