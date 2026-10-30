import type { OrchestrationPlan, OrchestrationSettings, OrchestrationTask, SendMessageOptions } from '@shared/chat'
import { perfEvent, perfSpan } from '../perf'

/**
 * Execution of an approved plan — the orchestrator that SUPERVISES.
 *
 * Before: every worker in parallel, wait for the last one, and only then a
 * review of at most 2 actions. Now:
 *  - each task leaves the queue once its dependencies were ACCEPTED, up to
 *    MAX_PARALLEL at a time;
 *  - each worker that finishes goes to the review (one at a time — there is a
 *    single orchestrator, and parallel decisions would contradict each other),
 *    while the others keep running;
 *  - the review accepts, asks for an adjustment (the same worker runs again),
 *    marks a failure or creates an extra worker, within the "adjustments per
 *    worker" budget;
 *  - with everything resolved, the integration review looks at the whole set and
 *    may ask for more adjustments (up to 2 passes).
 *
 * Everything that talks to the model, git or the disk comes in through
 * `ExecutionDeps`: the coordination is testable with fake workers and reviewers.
 */

export const MAX_PARALLEL = 4
/** Passes of the integration review (each one may generate adjustments). */
const INTEGRATION_PASSES = 2
/** Cap on tasks in the plan, counting the extras created during review. */
const MAX_TASKS_TOTAL = 12
/** How much of a dependency's result goes into the prompt of whoever depends on it. */
const DEPENDENCY_SUMMARY = 2500

export interface WorkerResult {
  text: string
  error?: string
  tokens?: unknown
}

/** What the reviewer can do. The text answers go back to the model. */
export interface ReviewActions {
  accept(taskId: string, note?: string): Promise<string>
  requestAdjustment(taskId: string, instruction: string): string
  markFailed(taskId: string, reason: string): string
  createWorker(request: { title: string; prompt: string; dependsOn?: string[] }): string
}

export type ReviewRequest =
  | { type: 'worker'; task: OrchestrationTask; result: WorkerResult }
  | { type: 'integration'; results: Map<string, WorkerResult> }

export interface ExecutionDeps {
  plan: OrchestrationPlan
  config: OrchestrationSettings
  signal: AbortSignal
  /** Runs a turn in the task's worker (creating the session, if this is the first time). */
  runWorker(task: OrchestrationTask, text: string): Promise<WorkerResult>
  /** Review by the orchestrator: decides using `actions`. Absent = accepts everything. */
  review?(request: ReviewRequest, actions: ReviewActions): Promise<void>
  /** Before a task's FIRST turn (e.g. creating its worktree). Returns notices for the prompt. */
  prepareTask?(task: OrchestrationTask): Promise<string[] | void>
  /** On accepting (e.g. committing the work in the worktree). */
  onAccept?(task: OrchestrationTask): Promise<void>
  /** Saves the plan and notifies the screen. */
  persist(): Promise<void>
  /** Modes of an extra worker created during review. */
  extraOptions?: SendMessageOptions
  newId?(): string
}

function terminal(t: OrchestrationTask): boolean {
  return t.phase === 'accepted' || t.phase === 'failed'
}

/** Prompt of a task that depends on others: their summary comes along. */
function promptWithDependencies(task: OrchestrationTask, plan: OrchestrationPlan, results: Map<string, WorkerResult>, notices: string[]): string {
  const parts = [task.prompt]
  if (task.files?.length) {
    parts.push(
      '\n\n## Files this task owns\n' +
        task.files.map((a) => `- ${a}`).join('\n') +
        '\nOther workers run at the same time on other files. Work within these; if you really must touch a file outside the list, keep that change minimal and say so in your summary.',
    )
  }
  const deps = (task.dependsOn ?? []).map((id) => plan.tasks.find((t) => t.id === id)).filter((t): t is OrchestrationTask => !!t)
  if (deps.length > 0) {
    parts.push(
      '\n\n## Context from the tasks this one depends on (already done and accepted)\n' +
        deps
          .map((d) => `### ${d.title}\n${(results.get(d.id)?.text ?? '(no summary)').slice(0, DEPENDENCY_SUMMARY)}`)
          .join('\n\n'),
    )
  }
  if (notices.length > 0) parts.push(`\n\n## Notes from the orchestrator\n${notices.map((a) => `- ${a}`).join('\n')}`)
  return parts.join('')
}

export async function executePlan(d: ExecutionDeps): Promise<Map<string, WorkerResult>> {
  const { plan, config } = d
  const supervises = config.behavior !== 'orchestrate' && !!d.review
  const results = new Map<string, WorkerResult>()
  const running = new Map<string, Promise<void>>()
  const reviewQueue: string[] = []
  const pendingAdjustments = new Map<string, string>()
  const prepared = new Set<string>()
  const noticesByTask = new Map<string, string[]>()
  const newId = d.newId ?? (() => `task_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`)

  plan.review = { adjustmentsUsed: 0, maxAdjustments: config.adjustmentsPerWorker * plan.tasks.length }
  // `status` follows the step for whoever reads only it (the mobile app counts
  // "idle" as done): open = submitted/streaming, accepted = idle,
  // failed = error.
  for (const t of plan.tasks) {
    t.phase = 'queued'
    t.status = 'submitted'
  }
  const review = plan.review
  const byId = (id: string) => plan.tasks.find((t) => t.id === id)

  const start = (task: OrchestrationTask, text: string, adjustment: boolean) => {
    task.phase = adjustment ? 'adjustment' : 'running'
    task.status = 'streaming'
    // Concurrency over time is the number that explains an orchestra that ran for
    // hours: MAX_PARALLEL slots, but how many were actually busy?
    perfEvent('scheduler:start', { task: task.title, adjustment, running: running.size, parallel: MAX_PARALLEL })
    const execution = (async () => {
      if (!prepared.has(task.id)) {
        prepared.add(task.id)
        const notices = (await d.prepareTask?.(task)) ?? []
        if (notices.length > 0) noticesByTask.set(task.id, notices)
        if (!adjustment) text = promptWithDependencies(task, plan, results, notices)
      }
      const r = await d.runWorker(task, text)
      results.set(task.id, r)
      if (supervises) {
        // Not ready yet: the review is missing.
        task.phase = 'review'
        reviewQueue.push(task.id)
      } else if (r.error) {
        task.phase = 'failed'
        task.status = 'error'
        task.reviewNote = r.error
      } else {
        task.phase = 'accepted'
        task.status = 'idle'
        await d.onAccept?.(task)
      }
    })()
      .catch((err) => {
        task.phase = 'failed'
        task.status = 'error'
        task.reviewNote = err instanceof Error ? err.message : String(err)
      })
      .finally(() => {
        running.delete(task.id)
      })
    running.set(task.id, execution)
  }

  const actions: ReviewActions = {
    async accept(taskId, note) {
      const t = byId(taskId)
      if (!t) return `Task ${taskId} does not exist.`
      t.phase = 'accepted'
      t.status = 'idle'
      if (note) t.reviewNote = note
      await d.onAccept?.(t)
      return `"${t.title}" accepted.`
    },
    requestAdjustment(taskId, instruction) {
      const t = byId(taskId)
      if (!t) return `Task ${taskId} does not exist.`
      if (running.has(t.id)) return `"${t.title}" is still running — wait for it to finish.`
      if ((t.revisions ?? 0) >= config.adjustmentsPerWorker) {
        return `No budget left for "${t.title}": it already received ${t.revisions ?? 0} adjustment(s), the maximum per worker. Accept it as it is or mark it as failed, explaining what is still pending.`
      }
      if (review.adjustmentsUsed >= review.maxAdjustments) {
        return 'No budget left: the total number of adjustments for this plan is exhausted. Accept or mark it as failed, explaining what is still pending.'
      }
      t.revisions = (t.revisions ?? 0) + 1
      review.adjustmentsUsed++
      t.phase = 'adjustment'
      t.status = 'submitted'
      t.reviewNote = instruction
      pendingAdjustments.set(t.id, instruction)
      return `Adjustment requested from "${t.title}" (${t.revisions}/${config.adjustmentsPerWorker}). It runs again and will be reviewed once more.`
    },
    markFailed(taskId, reason) {
      const t = byId(taskId)
      if (!t) return `Task ${taskId} does not exist.`
      t.phase = 'failed'
      t.status = 'error'
      t.reviewNote = reason
      return `"${t.title}" marked as failed.`
    },
    createWorker({ title, prompt, dependsOn }) {
      if (plan.tasks.length >= MAX_TASKS_TOTAL) return `Limit of ${MAX_TASKS_TOTAL} workers in the plan reached.`
      if (review.adjustmentsUsed >= review.maxAdjustments) return 'No budget left: a new worker counts as an adjustment, and the total is exhausted.'
      const key = title.trim().toLowerCase()
      if (plan.tasks.some((t) => t.title.trim().toLowerCase() === key)) return `A worker named "${title}" already exists — use request_adjustment on it.`
      const deps: string[] = []
      for (const ref of dependsOn ?? []) {
        const dep = plan.tasks.find((t) => t.id === ref || t.title.trim().toLowerCase() === ref.trim().toLowerCase())
        if (!dep) return `"${ref}" is not a task of this plan.`
        deps.push(dep.id)
      }
      review.adjustmentsUsed++
      plan.tasks.push({
        id: newId(),
        title,
        prompt,
        options: { ...d.extraOptions },
        status: 'submitted',
        phase: 'queued',
        extra: true,
        ...(deps.length > 0 ? { dependsOn: deps } : {}),
      })
      return `Worker "${title}" created — it joins the queue${deps.length > 0 ? ' after its dependencies' : ''}.`
    },
  }

  let integrationPasses = 0
  for (;;) {
    if (d.signal.aborted) break

    // A dependency that failed takes down whoever depends on it — waiting is useless.
    for (const t of plan.tasks) {
      if (t.phase !== 'queued') continue
      const failed = (t.dependsOn ?? []).map(byId).find((dep) => dep?.phase === 'failed')
      if (failed) {
        t.phase = 'failed'
        t.status = 'error'
        t.reviewNote = `Never started: it depends on "${failed.title}", which failed.`
      }
    }

    // Adjustments first (the worker already has context), then the ready tasks.
    for (const [id, instruction] of pendingAdjustments) {
      if (running.size >= MAX_PARALLEL) break
      pendingAdjustments.delete(id)
      const t = byId(id)
      if (t) start(t, `[Adjustment requested by the orchestrator]\n${instruction}`, true)
    }
    for (const t of plan.tasks) {
      if (running.size >= MAX_PARALLEL) break
      if (t.phase !== 'queued') continue
      if (!(t.dependsOn ?? []).every((id) => byId(id)?.phase === 'accepted')) continue
      start(t, t.prompt, false)
    }
    await d.persist()

    if (reviewQueue.length > 0 && d.review) {
      const t = byId(reviewQueue.shift()!)
      if (!t) continue
      review.activity = `Reviewing: ${t.title}`
      await d.persist()
      // The review runs INSIDE the scheduler loop: while it is open no queued task
      // leaves the queue, so its duration is dead time for the other slots.
      const reviewPerf = perfSpan('review', { type: 'worker', task: t.title, running: running.size })
      try {
        await d.review({ type: 'worker', task: t, result: results.get(t.id) ?? { text: '' } }, actions)
      } catch (err) {
        // A reviewer that is down cannot stall the plan: the worker's work counts.
        t.reviewNote = `Review unavailable: ${err instanceof Error ? err.message : String(err)}`
      } finally {
        reviewPerf.end({ decision: t.phase })
      }
      // No decision (the model called no action): accept it as it is.
      if (t.phase === 'review') {
        const r = results.get(t.id)
        if (r?.error) {
          t.phase = 'failed'
          t.status = 'error'
          t.reviewNote ??= r.error
        } else {
          await actions.accept(t.id)
        }
      }
      review.activity = undefined
      continue
    }

    if (running.size > 0) {
      await Promise.race(running.values())
      continue
    }
    if (pendingAdjustments.size > 0) continue

    if (plan.tasks.some((t) => t.phase === 'queued')) {
      // Queued with nothing running and no way out: a dependency that will never be accepted.
      for (const t of plan.tasks) {
        if (t.phase !== 'queued') continue
        t.phase = 'failed'
        t.status = 'error'
        t.reviewNote = 'Never started: the tasks it depends on were not accepted.'
      }
      continue
    }

    // Everything resolved: integration review (does the whole meet the request?).
    if (supervises && integrationPasses < INTEGRATION_PASSES && plan.tasks.every(terminal)) {
      integrationPasses++
      const before = review.adjustmentsUsed
      review.activity = 'Integration review'
      await d.persist()
      const integrationPerf = perfSpan('review', { type: 'integration', pass: integrationPasses })
      try {
        await d.review!({ type: 'integration', results }, actions)
      } catch {
        // same thing: without a reviewer, the set stays as it is
      } finally {
        integrationPerf.end({ adjustments: review.adjustmentsUsed })
      }
      review.activity = undefined
      // Nothing new to run: it is over.
      if (review.adjustmentsUsed === before && pendingAdjustments.size === 0) break
      continue
    }
    break
  }

  // Abort: wait for the turns in progress to end (they receive the abort).
  await Promise.allSettled(running.values())
  review.activity = undefined
  await d.persist()
  return results
}
