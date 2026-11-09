import { describe, expect, it, vi } from 'vitest'
import type { OrchestrationPlan, OrchestrationSettings, OrchestrationTask } from '@shared/chat'
import { executePlan, MAX_PARALLEL, type ReviewActions, type ReviewRequest } from './execution'

function task(id: string, extra: Partial<OrchestrationTask> = {}): OrchestrationTask {
  return { id, title: id.toUpperCase(), prompt: `do ${id}`, options: {}, status: 'idle', ...extra }
}

function plan(tasks: OrchestrationTask[]): OrchestrationPlan {
  return { id: 'plan_1', tasks, status: 'running' }
}

const config = (c: Partial<OrchestrationSettings> = {}): OrchestrationSettings => ({
  behavior: 'supervise',
  adjustmentsPerWorker: 2,
  approveSingleTask: false,
  autoApprove: false,
  worktrees: false,
  ...c,
})

/** Fake worker that finishes when the test says so (or right away). */
function workers() {
  const calls: Array<{ id: string; text: string }> = []
  const runWorker = vi.fn(async (t: OrchestrationTask, text: string) => {
    calls.push({ id: t.id, text })
    await new Promise((r) => setTimeout(r, 1))
    return { text: `result of ${t.id} (${calls.filter((c) => c.id === t.id).length})` }
  })
  return { calls, runWorker }
}

const base = (p: OrchestrationPlan, extra: Partial<Parameters<typeof executePlan>[0]> = {}) => ({
  plan: p,
  config: config(),
  signal: new AbortController().signal,
  persist: async () => {},
  ...extra,
})

describe('executePlan', () => {
  it('orchestrate only: runs everything, accepts with no review', async () => {
    const p = plan([task('a'), task('b')])
    const w = workers()
    const review = vi.fn()
    await executePlan({ ...base(p), config: config({ behavior: 'orchestrate' }), runWorker: w.runWorker, review })
    expect(review).not.toHaveBeenCalled()
    expect(p.tasks.map((t) => t.phase)).toEqual(['accepted', 'accepted'])
  })

  it('a fixed team (a routine) cannot get workers from the reviewer, and the plan keeps its size', async () => {
    const p = plan([task('a')])
    const w = workers()
    const answers: string[] = []
    const review = async (request: ReviewRequest, actions: ReviewActions) => {
      if (request.type === 'worker') answers.push(actions.createWorker({ title: 'Extra', prompt: 'more' }))
    }
    await executePlan({ ...base(p), runWorker: w.runWorker, review, fixedTeam: true })
    expect(answers[0]).toMatch(/team is fixed/)
    expect(p.tasks).toHaveLength(1)
  })

  it('reviews each worker when it finishes and accepts when the reviewer does not decide', async () => {
    const p = plan([task('a'), task('b')])
    const w = workers()
    const reviewed: string[] = []
    const review = vi.fn(async (request: ReviewRequest) => {
      if (request.type === 'worker') reviewed.push(request.task.id)
    })
    await executePlan({ ...base(p), runWorker: w.runWorker, review })
    expect(reviewed.sort()).toEqual(['a', 'b'])
    expect(p.tasks.every((t) => t.phase === 'accepted')).toBe(true)
    // the integration ran once and, with no actions, ended
    expect(review.mock.calls.filter(([r]) => (r as ReviewRequest).type === 'integration')).toHaveLength(1)
  })

  it('an adjustment request runs the same worker again and respects the per-worker cap', async () => {
    const p = plan([task('a')])
    const w = workers()
    const answers: string[] = []
    const review = async (request: ReviewRequest, actions: ReviewActions) => {
      if (request.type === 'worker') answers.push(actions.requestAdjustment('a', 'fix the test'))
    }
    await executePlan({ ...base(p), config: config({ adjustmentsPerWorker: 2 }), runWorker: w.runWorker, review })

    expect(w.calls.map((c) => c.text)).toEqual(['do a', '[Adjustment requested by the orchestrator]\nfix the test', '[Adjustment requested by the orchestrator]\nfix the test'])
    expect(answers[2]).toContain('No budget left')
    expect(p.tasks[0].revisions).toBe(2)
    expect(p.tasks[0].phase).toBe('accepted')
    expect(p.review?.adjustmentsUsed).toBe(2)
  })

  it('a dependent only starts after its dependency is accepted, and receives its summary', async () => {
    const p = plan([task('api'), task('tests', { dependsOn: ['api'] })])
    const w = workers()
    await executePlan({ ...base(p), runWorker: w.runWorker, review: async () => {} })
    expect(w.calls.map((c) => c.id)).toEqual(['api', 'tests'])
    expect(w.calls[1].text).toContain('result of api (1)')
  })

  it('a dependency that failed takes down whoever depends on it', async () => {
    const p = plan([task('api'), task('tests', { dependsOn: ['api'] })])
    const w = workers()
    const review = async (request: ReviewRequest, actions: ReviewActions) => {
      if (request.type === 'worker' && request.task.id === 'api') actions.markFailed('api', 'broke')
    }
    await executePlan({ ...base(p), runWorker: w.runWorker, review })
    expect(p.tasks[1].phase).toBe('failed')
    expect(p.tasks[1].reviewNote).toContain('API')
    expect(w.calls.map((c) => c.id)).toEqual(['api'])
  })

  it('at most MAX_PARALLEL workers at the same time', async () => {
    const p = plan(Array.from({ length: 7 }, (_, i) => task(`t${i}`)))
    let active = 0
    let peak = 0
    const runWorker = async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
      return { text: 'ok' }
    }
    await executePlan({ ...base(p), config: config({ behavior: 'orchestrate' }), runWorker })
    expect(peak).toBe(MAX_PARALLEL)
    expect(p.tasks.every((t) => t.phase === 'accepted')).toBe(true)
  })

  it('a review in progress does not hold the queue: the freed slot starts the next task', async () => {
    const p = plan(Array.from({ length: MAX_PARALLEL + 2 }, (_, i) => task(`t${i}`)))
    // t0 ends first and its slot goes to t4 before its review; t5 only gets a slot
    // when another worker ends DURING that review.
    const last = `t${MAX_PARALLEL + 1}`
    let lastStarted!: () => void
    const lastStart = new Promise<void>((r) => (lastStarted = r))
    const runWorker = async (t: OrchestrationTask) => {
      if (t.id === last) lastStarted()
      await new Promise((r) => setTimeout(r, t.id === 't0' ? 1 : 20))
      return { text: 'ok' }
    }
    const order: string[] = []
    const review = async (request: ReviewRequest) => {
      if (request.type !== 'worker') return
      // The first review only ends once t5 started — with the review inside the
      // scheduler loop nothing is scheduled while it is open, and this never resolves.
      if (request.task.id === 't0') await lastStart
      order.push(request.task.id)
    }
    await executePlan({ ...base(p), runWorker, review })
    expect(order[0]).toBe('t0')
    expect(p.tasks.every((t) => t.phase === 'accepted')).toBe(true)
  })

  it('the integration may create an extra worker, which runs and is reviewed', async () => {
    const p = plan([task('a')])
    const w = workers()
    let created = false
    const review = async (request: ReviewRequest, actions: ReviewActions) => {
      if (request.type === 'integration' && !created) {
        created = true
        actions.createWorker({ title: 'Integration tests', prompt: 'test everything', dependsOn: ['A'] })
      }
    }
    await executePlan({ ...base(p), runWorker: w.runWorker, review, newId: () => 'extra_1' })
    const extra = p.tasks.find((t) => t.id === 'extra_1')
    expect(extra).toMatchObject({ extra: true, phase: 'accepted', dependsOn: ['a'] })
    expect(w.calls.map((c) => c.id)).toEqual(['a', 'extra_1'])
  })

  it('a worker error with no decision becomes a failure; a reviewer that is down does not stall', async () => {
    const p = plan([task('a'), task('b')])
    const runWorker = async (t: OrchestrationTask) => (t.id === 'a' ? { text: '', error: 'timeout' } : { text: 'ok' })
    const review = async () => {
      throw new Error('model unavailable')
    }
    await executePlan({ ...base(p), runWorker, review })
    expect(p.tasks.map((t) => t.phase)).toEqual(['failed', 'accepted'])
    // status follows the step (the mobile app only reads status)
    expect(p.tasks.map((t) => t.status)).toEqual(['error', 'idle'])
  })

  it('a task queued or under review does not look done to whoever reads only status', async () => {
    const p = plan([task('api'), task('tests', { dependsOn: ['api'] })])
    const seen: string[] = []
    const review = async (request: ReviewRequest) => {
      if (request.type === 'worker' && request.task.id === 'api') seen.push(`api:${request.task.status} tests:${p.tasks[1].status}`)
    }
    await executePlan({ ...base(p), runWorker: workers().runWorker, review })
    expect(seen).toEqual(['api:streaming tests:submitted'])
  })

  it('resuming keeps the accepted tasks and runs only the rest', async () => {
    const p = plan([
      task('done', { phase: 'accepted', status: 'idle' }),
      task('running', { phase: 'running', status: 'streaming' }),
      task('queued', { phase: 'queued', status: 'submitted' }),
    ])
    p.review = { adjustmentsUsed: 1, maxAdjustments: 6, activity: 'Reviewing: DONE' }
    const w = workers()
    await executePlan({ ...base(p), keepAccepted: true, runWorker: w.runWorker, review: async () => {} })

    // the accepted one was not run again and kept its phase
    expect(w.calls.map((c) => c.id)).toEqual(['running', 'queued'])
    expect(p.tasks.map((t) => t.phase)).toEqual(['accepted', 'accepted', 'accepted'])
    // the budget already spent stays spent; "Reviewing: X" of the dead run is gone
    expect(p.review?.adjustmentsUsed).toBe(1)
    expect(p.review?.activity).toBeUndefined()
  })

  it('a plan that starts now puts everything back in the queue', async () => {
    const p = plan([task('done', { phase: 'accepted', status: 'idle' })])
    const w = workers()
    await executePlan({ ...base(p), runWorker: w.runWorker, review: async () => {} })
    expect(w.calls.map((c) => c.id)).toEqual(['done'])
  })

  it('prepareTask runs once per task and its notices go into the prompt', async () => {
    const p = plan([task('a')])
    const w = workers()
    const prepareTask = vi.fn(async () => ['branch X did not merge'])
    const review = async (request: ReviewRequest, actions: ReviewActions) => {
      if (request.type === 'worker' && (request.task.revisions ?? 0) === 0) actions.requestAdjustment('a', 'more')
    }
    await executePlan({ ...base(p), runWorker: w.runWorker, review, prepareTask })
    expect(prepareTask).toHaveBeenCalledTimes(1)
    expect(w.calls[0].text).toContain('branch X did not merge')
  })
})
