import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pipeline, Project, Task, TaskWorktree } from '@shared/pipeline'

const db = vi.hoisted(() => ({
  pipelines: [] as Pipeline[],
  projects: [] as Project[],
  tasks: [] as Task[],
}))

vi.mock('./repo', () => ({
  listPipelines: async () => db.pipelines,
  listProjects: async () => db.projects,
  listTasks: async () => db.tasks,
  patchPipeline: async () => null,
  allocateTaskNumber: async () => 1,
  modifyTasks: async (_p: string, fn: (tasks: Task[]) => unknown) => fn(db.tasks),
  updateTask: async (_p: string, taskId: string, patch: (t: Task) => Task) => {
    const i = db.tasks.findIndex((t) => t.id === taskId)
    if (i < 0) return null
    db.tasks[i] = patch(db.tasks[i])
    return db.tasks[i]
  },
}))
const runPhase = vi.hoisted(() => vi.fn())
vi.mock('./runner', () => ({ runPhase }))
const wt = vi.hoisted(() => ({
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(async () => {}),
  exists: vi.fn(async () => true),
  cleanOrphans: vi.fn(async () => {}),
}))
vi.mock('./worktree', () => ({ ...wt, integrationFolderId: (id: string) => `integration-${id}` }))
const integ = vi.hoisted(() => ({
  ensureIntegration: vi.fn(),
  enqueueIntegration: vi.fn(async () => {}),
  recoverIntegrations: vi.fn(async () => {}),
  abortIntegrations: vi.fn(),
  onIntegrationSettled: vi.fn(),
  queuedState: () => ({ state: 'queued' as const, updatedAt: '' }),
}))
vi.mock('./integration', () => integ)
const commit = vi.hoisted(() => ({ tryCommit: vi.fn(async () => ({ hash: 'abc1234', tokens: 0, cost: 0 })) }))
vi.mock('./commit', () => commit)
vi.mock('../process-manager', () => ({ listProcesses: () => [], killProcess: vi.fn() }))
vi.mock('../snapshot', () => ({ capture: vi.fn(async () => undefined), diff: vi.fn() }))
vi.mock('../broadcast', () => ({ broadcastPipelineEvent: vi.fn() }))
vi.mock('../memory/service', () => ({ loadPromptContext: vi.fn(), search: vi.fn() }))
vi.mock('../catalog', () => ({ getProvider: vi.fn() }))
vi.mock('../providers', () => ({ resolveModel: vi.fn() }))

const { startTask, removeTask } = await import('./engine')
const { pendingDependencies } = await import('./contract')

const worktree = (id: string): TaskWorktree => ({
  path: `/wt/${id}`,
  folder: `/wt/${id}`,
  branch: `pipeline/${id}`,
  base: 'main',
  dependencies: 'cloned',
  createdAt: '',
})

function newTask(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    pipelineId: 'pipe_1',
    title: id,
    description: '',
    status: 'pending',
    currentPhase: null,
    dependsOn: [],
    notes: [],
    createdAt: '',
    workTimeMs: 0,
    tokens: 0,
    cost: 0,
    ...extra,
  }
}

const waitForRun = () => new Promise((r) => setTimeout(r, 20))

beforeEach(() => {
  db.projects = [{ id: 'proj_1', name: 'P', folders: ['/repo', '/extra'], createdAt: '', pipelines: ['pipe_1'] }]
  db.pipelines = [
    {
      id: 'pipe_1',
      projectId: 'proj_1',
      name: 'E',
      phases: [
        { id: 'dev', name: 'dev', description: '', prompt: '', providerId: 'p', modelId: 'm', thinkingLevel: 0, tools: [], order: 0 },
      ],
      operationMode: 'manual',
      commitAtEnd: true,
      commandPolicy: { blocked: [], controlled: [] },
      worktreePerTask: true,
      createdAt: '',
    },
  ]
  db.tasks = [newTask('t1')]
  runPhase.mockReset()
  runPhase.mockResolvedValue({ text: 'ok', note: 'done', controlledCommands: [], tokens: 0, cost: 0 })
  wt.createWorktree.mockReset()
  wt.createWorktree.mockImplementation(async ({ task }: { task: Task }) => worktree(task.id))
  wt.removeWorktree.mockClear()
  wt.exists.mockReset()
  wt.exists.mockResolvedValue(true)
  integ.ensureIntegration.mockReset()
  integ.ensureIntegration.mockResolvedValue({ ...worktree('integration'), branch: 'pipeline/e-1/integration' })
  integ.enqueueIntegration.mockClear()
  commit.tryCommit.mockClear()
})

describe('per-task worktree in the engine', () => {
  it('creates the worktree on the first run and executes the phases in it (extra folders stay the same)', async () => {
    await startTask('pipe_1', 't1')
    await waitForRun()

    expect(wt.createWorktree).toHaveBeenCalledTimes(1)
    expect(db.tasks[0].worktree?.branch).toBe('pipeline/t1')
    expect(runPhase.mock.calls[0][0].folders).toEqual(['/wt/t1', '/extra'])
    expect(db.tasks[0].status).toBe('completed')
  })

  it('reuses the existing worktree', async () => {
    db.tasks = [newTask('t1', { status: 'paused', currentPhase: 0, worktree: worktree('t1') })]
    await startTask('pipe_1', 't1')
    await waitForRun()

    expect(wt.createWorktree).not.toHaveBeenCalled()
    expect(runPhase.mock.calls[0][0].folders[0]).toBe('/wt/t1')
  })

  it('recreates it when the worktree folder is gone', async () => {
    db.tasks = [newTask('t1', { status: 'paused', currentPhase: 0, worktree: worktree('t1') })]
    wt.exists.mockResolvedValue(false)
    await startTask('pipe_1', 't1')
    await waitForRun()

    expect(wt.createWorktree).toHaveBeenCalledTimes(1)
    expect(wt.createWorktree.mock.calls[0][0].task.worktree.branch).toBe('pipeline/t1')
  })

  it('does not create a worktree for a task that already ran without one (option turned on halfway)', async () => {
    db.tasks = [
      newTask('t1', {
        status: 'paused',
        currentPhase: 0,
        notes: [
          {
            phaseId: 'x',
            phaseName: 'x',
            status: 'ok',
            content: '',
            controlledCommands: [],
            tokens: 0,
            cost: 0,
            startedAt: '',
            completedAt: '',
          },
        ],
      }),
    ]
    await startTask('pipe_1', 't1')
    await waitForRun()

    expect(wt.createWorktree).not.toHaveBeenCalled()
    expect(runPhase.mock.calls[0][0].folders[0]).toBe('/repo')
  })

  it('without the option, runs in the main repository', async () => {
    db.pipelines[0].worktreePerTask = false
    await startTask('pipe_1', 't1')
    await waitForRun()

    expect(wt.createWorktree).not.toHaveBeenCalled()
    expect(runPhase.mock.calls[0][0].folders[0]).toBe('/repo')
  })

  it('a failure to create the worktree pauses the task with the reason, without running a phase', async () => {
    wt.createWorktree.mockRejectedValue(new Error('The main folder is not a git repository: /repo'))
    await startTask('pipe_1', 't1')
    await waitForRun()

    expect(runPhase).not.toHaveBeenCalled()
    expect(db.tasks[0].status).toBe('paused')
    expect(db.tasks[0].pauseReason).toBe('error')
    expect(db.tasks[0].error).toContain('is not a git repository')
  })

  it('starts every task from the integration branch', async () => {
    await startTask('pipe_1', 't1')
    await waitForRun()

    expect(wt.createWorktree.mock.calls[0][0].base).toBe('pipeline/e-1/integration')
  })

  it('a finished task goes to the merge queue, and its dependants wait for the integration', async () => {
    db.tasks = [newTask('t1'), newTask('t2', { dependsOn: ['t1'] })]
    await startTask('pipe_1', 't1')
    await waitForRun()

    expect(db.tasks[0].status).toBe('completed')
    expect(db.tasks[0].integration?.state).toBe('queued')
    expect(db.tasks[0].finalCommitHash).toBe('abc1234')
    expect(integ.enqueueIntegration).toHaveBeenCalledWith('pipe_1', 't1')
    expect(pendingDependencies(db.tasks[1], db.tasks)).toHaveLength(1)

    db.tasks[0] = { ...db.tasks[0], integration: { state: 'integrated', updatedAt: '' } }
    expect(pendingDependencies(db.tasks[1], db.tasks)).toHaveLength(0)
  })

  it('a failed final commit does not queue the task: it is marked failed with the reason', async () => {
    commit.tryCommit.mockResolvedValueOnce({ error: 'nothing to commit', tokens: 0, cost: 0 } as never)
    await startTask('pipe_1', 't1')
    await waitForRun()

    expect(db.tasks[0].integration?.state).toBe('failed')
    expect(db.tasks[0].integration?.detail).toContain('nothing to commit')
    expect(integ.enqueueIntegration).not.toHaveBeenCalled()
  })

  it('with commits off, tasks work in the shared integration worktree and never queue', async () => {
    db.pipelines[0].commitAtEnd = false
    await startTask('pipe_1', 't1')
    await waitForRun()

    expect(wt.createWorktree).not.toHaveBeenCalled()
    expect(db.tasks[0].worktree?.shared).toBe(true)
    expect(commit.tryCommit).not.toHaveBeenCalled()
    expect(db.tasks[0].integration).toBeUndefined()
    expect(integ.enqueueIntegration).not.toHaveBeenCalled()
  })

  it('with commits off, a second task cannot start while one is running', async () => {
    db.pipelines[0].commitAtEnd = false
    db.tasks = [newTask('t1', { status: 'in_progress', currentPhase: 0 }), newTask('t2')]
    await expect(startTask('pipe_1', 't2')).rejects.toThrow(/one at a time/)
  })

  it('removing a task on the shared worktree leaves the integration worktree alone', async () => {
    db.tasks = [newTask('t1', { status: 'completed', worktree: { ...worktree('integration'), shared: true } })]
    await removeTask('pipe_1', 't1')

    expect(wt.removeWorktree).not.toHaveBeenCalled()
  })

  it('a delivered task is history and cannot be removed', async () => {
    db.tasks = [newTask('t1', { status: 'completed', deliveryId: 'deliv_1' })]
    await expect(removeTask('pipe_1', 't1')).rejects.toThrow(/delivery/)
  })

  it('removing the task removes its worktree', async () => {
    db.tasks = [newTask('t1', { status: 'completed', worktree: worktree('t1') })]
    await removeTask('pipe_1', 't1')

    expect(wt.removeWorktree).toHaveBeenCalledWith('/repo', worktree('t1'))
    expect(db.tasks).toHaveLength(0)
  })
})
