import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pipeline, Project, Task } from '@shared/pipeline'

// In-memory repository: the engine reads and writes through here.
const db = vi.hoisted(() => ({
  pipelines: [] as Pipeline[],
  projects: [] as Project[],
  tasks: [] as Task[],
}))

vi.mock('./repo', () => ({
  listPipelines: async () => db.pipelines,
  listProjects: async () => db.projects,
  listTasks: async () => db.tasks,
  modifyTasks: async () => undefined,
  updateTask: async (_pipelineId: string, taskId: string, patch: (t: Task) => Task) => {
    const i = db.tasks.findIndex((t) => t.id === taskId)
    if (i < 0) return null
    db.tasks[i] = patch(db.tasks[i])
    return db.tasks[i]
  },
}))
const runPhase = vi.hoisted(() => vi.fn())
vi.mock('./runner', () => ({ runPhase }))
vi.mock('../snapshot', () => ({ capture: vi.fn(async () => undefined), diff: vi.fn() }))
vi.mock('../broadcast', () => ({ broadcastPipelineEvent: vi.fn() }))
vi.mock('../memory/service', () => ({ loadPromptContext: vi.fn(), search: vi.fn() }))
vi.mock('../catalog', () => ({ getProvider: vi.fn() }))
vi.mock('../providers', () => ({ resolveModel: vi.fn() }))

const { returnTask, resumeTask } = await import('./engine')

const phase = (id: string, order: number) => ({
  id,
  name: id,
  description: '',
  prompt: '',
  providerId: 'p',
  modelId: 'm',
  thinkingLevel: 0,
  tools: [],
  order,
})

function completed(extra: Partial<Task> = {}): Task {
  return {
    id: 't1',
    pipelineId: 'pipe_1',
    title: 'T',
    description: 'd',
    status: 'completed',
    currentPhase: 1,
    dependsOn: [],
    notes: [],
    createdAt: '',
    completedAt: '2026-10-07T00:00:00.000Z',
    workTimeMs: 10,
    tokens: 5,
    cost: 0.1,
    finalCommitHash: 'abc123',
    commitError: 'failed before',
    ...extra,
  }
}

/** Lets the fire-and-forget execution finish. */
const waitForRun = () => new Promise((r) => setTimeout(r, 20))

beforeEach(() => {
  db.projects = [{ id: 'proj_1', name: 'P', folders: ['/repo'], createdAt: '', pipelines: ['pipe_1'] }]
  db.pipelines = [
    {
      id: 'pipe_1',
      projectId: 'proj_1',
      name: 'P',
      phases: [phase('dev', 0), phase('val', 1)],
      operationMode: 'manual',
      pushAtEnd: false,
      commitAtEnd: false,
      commandPolicy: { blocked: [], controlled: [] },
      createdAt: '',
    },
  ]
  db.tasks = [completed()]
  runPhase.mockReset()
  runPhase.mockResolvedValue({ text: 'ok', note: 'done', controlledCommands: [], tokens: 1, cost: 0 })
})

describe('returnTask', () => {
  it('opens round 2, runs the pipeline again and tags the notes with the round', async () => {
    await returnTask('pipe_1', 't1', '  Got the shipping wrong  ', 0)
    await waitForRun()

    const t = db.tasks[0]
    expect(t.round).toBe(2)
    expect(t.returns).toEqual([{ round: 2, text: 'Got the shipping wrong', startPhase: 0, createdAt: expect.any(String) }])
    expect(t.status).toBe('completed')
    expect(runPhase).toHaveBeenCalledTimes(2)
    expect(t.notes.map((a) => [a.phaseId, a.round])).toEqual([
      ['dev', 2],
      ['val', 2],
    ])
    // The previous round's failures go away; its final commit goes to the history
    expect(t.commitError).toBeUndefined()
    expect(t.previousCommits).toEqual(['abc123'])
  })

  it('restarts at the chosen phase without recording the previous ones as skipped', async () => {
    await returnTask('pipe_1', 't1', 'just revalidate', 1)
    await waitForRun()

    const t = db.tasks[0]
    expect(runPhase).toHaveBeenCalledTimes(1)
    expect(runPhase.mock.calls[0][0].phaseIndex).toBe(1)
    expect(t.notes.map((a) => a.phaseId)).toEqual(['val'])
    expect(t.returns?.[0].startPhase).toBe(1)
  })

  it('refuses a task that is not completed', async () => {
    db.tasks = [completed({ status: 'paused' })]
    await expect(returnTask('pipe_1', 't1', 'x')).rejects.toThrow()
    expect(db.tasks[0].round).toBeUndefined()
  })

  it('refuses an empty comment', async () => {
    await expect(returnTask('pipe_1', 't1', '   ')).rejects.toThrow()
    expect(db.tasks[0].status).toBe('completed')
  })

  it('clamps the start phase to the phases that exist', async () => {
    await returnTask('pipe_1', 't1', 'x', 99)
    await waitForRun()
    expect(db.tasks[0].returns?.[0].startPhase).toBe(1)
  })
})

describe('resumeTask with an instruction', () => {
  it('records the instruction on the phase where the task stopped and runs that phase with it', async () => {
    db.tasks = [completed({ status: 'paused', pauseReason: 'error', error: 'npm test failed', currentPhase: 1, round: 2 })]
    await resumeTask('pipe_1', 't1', '  use npm run test:unit  ')
    await waitForRun()

    const t = db.tasks[0]
    expect(t.instructions).toEqual([
      { text: 'use npm run test:unit', round: 2, phaseId: 'val', phaseName: 'val', createdAt: expect.any(String) },
    ])
    expect(runPhase).toHaveBeenCalledTimes(1)
    expect(runPhase.mock.calls[0][0].task.instructions).toHaveLength(1)
    // Does not open a new round
    expect(t.round).toBe(2)
    expect(t.status).toBe('completed')
  })

  it('refuses an instruction on a task that is not paused', async () => {
    await expect(resumeTask('pipe_1', 't1', 'x')).rejects.toThrow()
    expect(db.tasks[0].instructions).toBeUndefined()
  })

  it('without an instruction it behaves as before', async () => {
    db.tasks = [completed({ status: 'paused', pauseReason: 'manual', currentPhase: 0 })]
    await resumeTask('pipe_1', 't1')
    await waitForRun()
    expect(db.tasks[0].instructions).toBeUndefined()
    expect(runPhase).toHaveBeenCalledTimes(2)
  })
})
