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
vi.mock('./worktree', () => wt)
vi.mock('../process-manager', () => ({ listProcesses: () => [], killProcess: vi.fn() }))
vi.mock('../snapshot', () => ({ capture: vi.fn(async () => undefined), diff: vi.fn() }))
vi.mock('../broadcast', () => ({ broadcastPipelineEvent: vi.fn() }))
vi.mock('../memory/service', () => ({ loadPromptContext: vi.fn(), search: vi.fn() }))
vi.mock('../catalog', () => ({ getProvider: vi.fn() }))
vi.mock('../providers', () => ({ resolveModel: vi.fn() }))

const { startTask, removeTask } = await import('./engine')

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
      pushAtEnd: false,
      commitAtEnd: false,
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

  it('starts from the dependency branch when there is exactly one with a worktree', async () => {
    db.tasks = [newTask('dep', { status: 'completed', worktree: worktree('dep') }), newTask('t1', { dependsOn: ['dep'] })]
    await startTask('pipe_1', 't1')
    await waitForRun()

    expect(wt.createWorktree.mock.calls[0][0].base).toBe('pipeline/dep')
  })

  it('removing the task removes its worktree', async () => {
    db.tasks = [newTask('t1', { status: 'completed', worktree: worktree('t1') })]
    await removeTask('pipe_1', 't1')

    expect(wt.removeWorktree).toHaveBeenCalledWith('/repo', worktree('t1'))
    expect(db.tasks).toHaveLength(0)
  })
})
