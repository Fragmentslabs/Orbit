import { describe, expect, it } from 'vitest'
import { normalizeOrchestrationPlan } from '@shared/chat'

/**
 * The plan is serialized inside the session (`orchestrator.persistPlan`) and is
 * read back by the desktop, the companion and the phone's cache. A plan approved
 * by an older build carries the Portuguese field names and phase values, so
 * `normalizeOrchestrationPlan` translates it at the read edge — the same style as
 * `normalizeOrchestrationSettings`. Idempotent: a plan already in the current
 * shape comes back unchanged, and an unusable value falls back to the default.
 */

/** Shape written before the contract was renamed to English. */
const legacyPlan = {
  id: 'plan_1',
  status: 'running',
  config: {
    comportamento: 'rigoroso',
    ajustesPorWorker: 3,
    worktrees: true,
    aprovarTarefaUnica: false,
  },
  revisao: {
    ajustesUsados: 1,
    tetoAjustes: 6,
    atividade: 'Reviewing: Login screen',
    merge: { ok: false, detalhe: '1 of 2 merged', pendente: true },
  },
  usage: { input: 1200, output: 300, cost: 0.042 },
  dismissed: false,
  tasks: [
    {
      id: 'task_1',
      title: 'API',
      prompt: 'Build the payments API',
      options: { research: true, plan: false },
      vision: true,
      workerSessionId: 'ses_1',
      status: 'streaming',
      revisions: 1,
      fase: 'ajuste',
      dependeDe: [],
      arquivos: ['src/api/**', 'src/shared/types.ts'],
      extra: true,
      notaRevisao: 'The webhook signature is not validated',
      worktree: {
        caminho: '/tmp/wt/payments',
        pasta: '/tmp/wt/payments/apps/api',
        branch: 'orchestra/abc123/api',
        base: 'main',
      },
      juntada: true,
    },
    {
      id: 'task_2',
      title: 'Tests',
      prompt: 'Cover the API',
      options: {},
      status: 'idle',
      fase: 'fila',
      dependeDe: ['task_1'],
      arquivos: [],
    },
  ],
}

/** The same plan, in the current shape. */
const currentPlan = {
  id: 'plan_1',
  status: 'running',
  config: {
    behavior: 'rigorous',
    adjustmentsPerWorker: 3,
    worktrees: true,
    approveSingleTask: false,
    autoApprove: false,
  },
  review: {
    adjustmentsUsed: 1,
    maxAdjustments: 6,
    activity: 'Reviewing: Login screen',
    merge: { ok: false, detail: '1 of 2 merged', pending: true },
  },
  usage: { input: 1200, output: 300, cost: 0.042 },
  dismissed: false,
  tasks: [
    {
      id: 'task_1',
      title: 'API',
      prompt: 'Build the payments API',
      options: { research: true, plan: false },
      vision: true,
      workerSessionId: 'ses_1',
      status: 'streaming',
      revisions: 1,
      phase: 'adjustment',
      dependsOn: [],
      files: ['src/api/**', 'src/shared/types.ts'],
      extra: true,
      reviewNote: 'The webhook signature is not validated',
      worktree: {
        path: '/tmp/wt/payments',
        folder: '/tmp/wt/payments/apps/api',
        branch: 'orchestra/abc123/api',
        base: 'main',
      },
      merged: true,
    },
    {
      id: 'task_2',
      title: 'Tests',
      prompt: 'Cover the API',
      options: {},
      status: 'idle',
      phase: 'queued',
      dependsOn: ['task_1'],
      files: [],
    },
  ],
}

describe('normalizeOrchestrationPlan — plan renamed to English', () => {
  it('translates the legacy keys of the plan, the tasks and the review', () => {
    expect(normalizeOrchestrationPlan(legacyPlan)).toEqual(currentPlan)
  })

  it.each([
    ['fila', 'queued'],
    ['rodando', 'running'],
    ['revisao', 'review'],
    ['ajuste', 'adjustment'],
    ['aceita', 'accepted'],
    ['falhou', 'failed'],
  ])('translates the legacy phase %s to %s', (legacy, current) => {
    const plan = normalizeOrchestrationPlan({ id: 'p', tasks: [{ id: 't', fase: legacy }] })
    expect(plan?.tasks[0].phase).toBe(current)
  })

  it('reads the legacy worktree keys as path and folder', () => {
    const plan = normalizeOrchestrationPlan({
      id: 'p',
      tasks: [{ id: 't', worktree: { caminho: '/w', pasta: '/w/app', branch: 'b', base: 'main' } }],
    })
    expect(plan?.tasks[0].worktree).toEqual({ path: '/w', folder: '/w/app', branch: 'b', base: 'main' })
  })

  it('drops a worktree with no path (it could not be used for anything)', () => {
    const plan = normalizeOrchestrationPlan({ id: 'p', tasks: [{ id: 't', worktree: { branch: 'b', base: 'main' } }] })
    expect(plan?.tasks[0].worktree).toBeUndefined()
  })

  it('leaves the current shape untouched (idempotent)', () => {
    expect(normalizeOrchestrationPlan(currentPlan)).toEqual(currentPlan)
  })

  it('running it twice gives the same result as running it once', () => {
    const once = normalizeOrchestrationPlan(legacyPlan)
    expect(normalizeOrchestrationPlan(once)).toEqual(once)
    // And after a storage round-trip, which drops undefined fields.
    expect(normalizeOrchestrationPlan(JSON.parse(JSON.stringify(once)))).toEqual(once)
  })

  it('preserves every other field of the plan and of the tasks', () => {
    const plan = normalizeOrchestrationPlan(currentPlan)!
    expect(plan.usage).toEqual(currentPlan.usage)
    expect(plan.dismissed).toBe(false)
    expect(plan.tasks[0]).toMatchObject({
      id: 'task_1',
      title: 'API',
      prompt: 'Build the payments API',
      options: { research: true, plan: false },
      vision: true,
      workerSessionId: 'ses_1',
      status: 'streaming',
      revisions: 1,
      extra: true,
      merged: true,
    })
  })

  it('prefers the English key when both are present', () => {
    const plan = normalizeOrchestrationPlan({
      id: 'p',
      revisao: { ajustesUsados: 5, tetoAjustes: 9 },
      review: { adjustmentsUsed: 1, maxAdjustments: 2 },
      tasks: [{ id: 't', fase: 'aceita', phase: 'running', dependeDe: ['a'], dependsOn: ['b'] }],
    })
    expect(plan?.review).toMatchObject({ adjustmentsUsed: 1, maxAdjustments: 2 })
    expect(plan?.tasks[0].phase).toBe('running')
    expect(plan?.tasks[0].dependsOn).toEqual(['b'])
  })

  it('falls back to the default for an unknown or missing value', () => {
    const plan = normalizeOrchestrationPlan({ id: 'p', status: 'nonsense', tasks: [{ id: 't', fase: 'on-hold' }] })
    expect(plan?.status).toBe('proposed')
    expect(plan?.tasks[0].phase).toBeUndefined()
    expect(plan?.tasks[0].status).toBe('idle')
  })

  it('returns undefined for something that is not a plan at all', () => {
    expect(normalizeOrchestrationPlan(null)).toBeUndefined()
    expect(normalizeOrchestrationPlan('plan')).toBeUndefined()
    expect(normalizeOrchestrationPlan({ tasks: [] })).toBeUndefined()
  })
})
