import type {
  CommandPolicy,
  Delivery,
  IntegrationStatus,
  MergeOutcome,
  PhaseConfig,
  Pipeline,
  Task,
  TaskIntegration,
  TaskWorktree,
} from '@shared/pipeline'
import { PIPELINE_INTEGRATION_ATTEMPTS, pipelineFlow, pipelineModel } from '@shared/pipeline'
import { git, repositoryRoot } from '../worktrees/core'
import { discoverChecks, runCheck } from '../orchestration/checks'
import { tryCommit } from './commit'
import { DEFAULT_POLICY } from './templates'
import { runPhase } from './runner'
import {
  abortMerge,
  concludeMerge,
  deleteBranch,
  dirtyFiles,
  fastForward,
  localBranches,
  mergeDiff,
  mergeInProgress,
  mergeRef,
  overlap,
} from './integration-git'
import { addDelivery, listDeliveries, listTasks, modifyTasks, patchPipeline, removeDelivery } from './repo'
import { emit, loadContext, newId, now, persist } from './store'
import { createIntegrationWorktree, createWorktree, exists, removeWorktree } from './worktree'
import { deleteMediaUrls, mediaUrlsIn } from './media-cleanup'

/**
 * The integration branch of a pipeline (flow `merge`).
 *
 * Every finished task commits on its own branch and goes through ONE serial
 * queue per pipeline. A queue step is "update-then-merge":
 *
 *   1. bring the integration branch into the TASK's worktree (conflicts are
 *      resolved there, never in the integration);
 *   2. run the project checks when that brought anything in;
 *   3. merge the task into the integration with `--no-ff` — it cannot conflict,
 *      because the task already contains the integration.
 *
 * The pipeline model is called only when there is something to decide (a
 * conflict, a failing check), a bounded number of times. Nothing here pushes or
 * pulls: the only way work leaves the integration is `mergeIntegration`.
 */

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'))
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })

/** Poll interval while the queue waits on the person's uncommitted edits (tests shorten it). */
export const tuning = { waitMs: 3000 }

/** Aborted on app shutdown: stops the queue's waits and model calls. */
let shutdown = new AbortController()

export function abortIntegrations(): void {
  shutdown.abort()
  shutdown = new AbortController()
  chains.clear()
}

/** Called after a task settles in the queue, so dependants waiting on it can start. */
let afterSettled: (pipelineId: string) => void = () => {}
export function onIntegrationSettled(fn: (pipelineId: string) => void): void {
  afterSettled = fn
}

// ─── Serial chain ────────────────────────────────────────────────────────────

const chains = new Map<string, Promise<unknown>>()

/** Runs `fn` after everything already queued for this pipeline. */
function inChain<T>(pipelineId: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(pipelineId) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  chains.set(
    pipelineId,
    run.catch(() => {}),
  )
  return run
}

/** Resolves when the pipeline's queue is empty. */
export function drained(pipelineId: string): Promise<void> {
  return (chains.get(pipelineId) ?? Promise.resolve()).then(() => {})
}

// ─── The integration worktree ────────────────────────────────────────────────

const creating = new Map<string, Promise<TaskWorktree>>()

/** The pipeline's integration worktree, created (or recreated) on demand. */
export function ensureIntegration(pipelineId: string, signal?: AbortSignal): Promise<TaskWorktree> {
  const pending = creating.get(pipelineId)
  if (pending) return pending
  const run = (async () => {
    const context = await loadContext(pipelineId)
    if (!context) throw new Error(`pipeline not found: ${pipelineId}`)
    const { pipeline, project } = context
    if (pipeline.integration && (await exists(pipeline.integration.path))) return pipeline.integration
    const mainFolder = project.folders[0]
    if (!mainFolder) throw new Error('The project has no main folder.')
    const created = await createIntegrationWorktree({ mainFolder, projectId: project.id, pipeline, signal })
    const updated = await patchPipeline(pipelineId, (p) => ({ ...p, integration: created }))
    if (updated) emit({ type: 'pipeline', pipeline: updated })
    return created
  })().finally(() => creating.delete(pipelineId))
  creating.set(pipelineId, run)
  return run
}

// ─── Model steps (conflicts and failed checks) ───────────────────────────────

/**
 * What the integration agent may not run. The engine does every git command that
 * changes history; the agent only edits files and runs read-only commands and
 * the project's own checks.
 */
export function integrationPolicy(base: CommandPolicy = DEFAULT_POLICY): CommandPolicy {
  return {
    blocked: [
      ...base.blocked,
      'git push',
      'git pull',
      'git fetch',
      'git merge',
      'git rebase',
      'git commit',
      'git checkout',
      'git switch',
      'git reset',
      'git stash',
      'git worktree',
      'git branch',
    ],
    controlled: base.controlled.filter((c) => !c.startsWith('git ')),
  }
}

const INTEGRATION_PROMPT = `You are the integration agent of a task pipeline. Finished tasks are merged into one shared integration branch; you are called only when that merge needs a decision: a merge conflict, or project checks (typecheck, lint, tests) that fail after the merge.

You work inside a single git worktree. The engine runs every git command that changes history (merge, add, commit) — you never do. You only read and edit files, and run read-only commands and the project's own checks.

For a conflict: the listed files contain conflict markers. For each one, read both sides, keep the intent of BOTH changes, remove every marker (<<<<<<<, =======, >>>>>>>) and make the result coherent — callers, imports and types must still line up. Only drop one side when the other clearly supersedes it, and say so in the note.
For failing checks: read the output and find the cause. After a merge it is usually two valid changes that no longer fit together (a renamed symbol, a changed signature, a duplicated import). Fix the code. Never weaken, skip or delete tests to make them pass. If a failure has nothing to do with the merged work, leave it and say so in the note.
Keep the change as small as it can be.`

function integrationPhase(pipeline: Pipeline): PhaseConfig {
  const model = pipelineModel(pipeline)
  if (!model) throw new Error('The pipeline has no model to resolve the integration.')
  return {
    id: 'integration',
    name: 'Integration',
    description: 'Resolves merge conflicts and fixes checks that fail after a merge',
    prompt: INTEGRATION_PROMPT,
    providerId: model.providerId,
    modelId: model.modelId,
    thinkingLevel: 0,
    reasoning: model.reasoning ?? null,
    tools: ['read', 'edit', 'shell'],
    order: 0,
  }
}

class GaveUp extends Error {}

interface Reconcile {
  pipeline: Pipeline
  /** The real task, or a stand-in when the integration itself is being updated */
  task: Task
  /** Worktree root (git runs here) and working folder inside it */
  cwd: string
  folder: string
  /** What to bring in: the integration branch, or a delivery destination */
  ref: string
  signal: AbortSignal
  /** Shared across the conflict and the check fixes: one budget per integration */
  budget: { used: number }
  report: (detail: string) => Promise<unknown>
  account: (tokens: number, cost: number) => Promise<unknown>
}

async function askModel(r: Reconcile, instruction: string): Promise<void> {
  r.budget.used++
  const phase = integrationPhase(r.pipeline)
  const result = await runPhase({
    pipeline: { ...r.pipeline, phases: [phase], commandPolicy: integrationPolicy(r.pipeline.commandPolicy) },
    task: {
      ...r.task,
      description: instruction,
      notes: [],
      returns: undefined,
      instructions: undefined,
      round: 1,
    },
    phase,
    phaseIndex: 0,
    folders: [r.folder],
    attempt: 1,
    abort: r.signal,
  })
  await r.account(result.tokens, result.cost)
  if (r.signal.aborted) throw new Error('aborted')
  // A phase that ended without a note failed on contract, not on the work: the
  // files may still be fixed, so carry on and let the verification decide.
  if (result.error && !result.text) console.error('[pipeline] integration agent error:', result.error)
}

/**
 * Brings `r.ref` into the branch checked out in `r.cwd`, resolving a conflict and
 * fixing failed checks with the pipeline model. Returns whether anything new came
 * in. Throws `GaveUp` (merge aborted, tree back to its state) when the budget runs out.
 */
async function reconcile(r: Reconcile): Promise<{ brought: boolean }> {
  const step = await mergeRef(r.cwd, r.ref, { message: `Merge ${r.ref} into ${r.task.title}`, signal: r.signal })
  if (step.status === 'error') throw new GaveUp(step.message)
  if (step.status === 'up-to-date') return { brought: false }

  if (step.status === 'conflict') {
    const conflicted = step.files
    let problem = ''
    for (;;) {
      if (r.budget.used >= PIPELINE_INTEGRATION_ATTEMPTS) {
        await abortMerge(r.cwd)
        throw new GaveUp(`The pipeline model could not resolve the conflict in ${conflicted.join(', ')}.${problem ? ` ${problem}` : ''}`)
      }
      await r.report(`Resolving conflicts in ${conflicted.slice(0, 3).join(', ')}${conflicted.length > 3 ? '…' : ''}`)
      await askModel(
        r,
        `Merging \`${r.ref}\` produced conflicts in these files:\n${conflicted.map((f) => `- ${f}`).join('\n')}\n\n` +
          `Resolve them. This is the task being integrated: "${r.task.title}".${problem ? `\n\nThe previous attempt did not work: ${problem}` : ''}`,
      )
      try {
        await concludeMerge(r.cwd, conflicted)
        break
      } catch (err) {
        problem = err instanceof Error ? err.message : String(err)
      }
    }
  }

  const root = r.cwd
  const checks = await discoverChecks(r.folder, root)
  for (;;) {
    let failing = ''
    for (const check of checks) {
      await r.report(`Running ${check.name}`)
      const outcome = await runCheck(check, r.signal)
      if (!outcome.ok) {
        failing = `${check.name}:\n${outcome.output}`
        break
      }
    }
    if (!failing) return { brought: true }
    if (r.budget.used >= PIPELINE_INTEGRATION_ATTEMPTS) {
      throw new GaveUp(`Checks still fail after ${r.budget.used} attempt(s).\n${failing.slice(-1500)}`)
    }
    await r.report(`Fixing failed checks (attempt ${r.budget.used + 1} of ${PIPELINE_INTEGRATION_ATTEMPTS})`)
    await askModel(
      r,
      `\`${r.ref}\` was merged into this branch and a check now fails.\n\nFailing check — ${failing}\n\nFix the cause in the code.`,
    )
    const dirty = (await dirtyFiles(root)).filter((f) => !/(^|\/)\.env(\.|$)/.test(f))
    if (dirty.length > 0) {
      await git(root, ['add', '-A', '--', ...dirty])
      await git(root, ['commit', '-m', `fix: adapt "${r.task.title}" to ${r.ref}`])
    }
  }
}

// ─── The queue ───────────────────────────────────────────────────────────────

/** Puts a task that just finished in the queue (its work is committed on its branch). */
export function enqueueIntegration(pipelineId: string, taskId: string): Promise<void> {
  return inChain(pipelineId, () => integrateTask(pipelineId, taskId)).catch((err) => {
    console.error('[pipeline] integration step failed:', err)
  })
}

/** Marks a completed task as waiting its turn. */
export function queuedState(): TaskIntegration {
  return { state: 'queued', updatedAt: now() }
}

/** Retry after a failure, or after the person fixed what was in the way. */
export async function retryIntegration(pipelineId: string, taskId: string): Promise<void> {
  const task = (await listTasks(pipelineId)).find((t) => t.id === taskId)
  if (!task || task.status !== 'completed' || task.deliveryId) return
  if (task.integration?.state === 'integrated' || task.integration?.state === 'integrating') return
  await persist(pipelineId, taskId, (t) => ({ ...t, integration: { ...queuedState(), attempts: 0 } }))
  void enqueueIntegration(pipelineId, taskId)
}

async function integrateTask(pipelineId: string, taskId: string): Promise<void> {
  const context = await loadContext(pipelineId)
  if (!context) return
  const { pipeline, project } = context
  const first = (await listTasks(pipelineId)).find((t) => t.id === taskId)
  if (!first || first.status !== 'completed' || first.deliveryId || first.integration?.state !== 'queued') return
  const signal = shutdown.signal

  const set = (patch: Partial<TaskIntegration>) =>
    persist(pipelineId, taskId, (t) =>
      t.integration ? { ...t, integration: { ...t.integration, ...patch, updatedAt: now() } } : t,
    )
  const budget = { used: 0 }
  const account = (tokens: number, cost: number) =>
    persist(pipelineId, taskId, (t) => ({ ...t, tokens: t.tokens + tokens, cost: t.cost + cost }))

  try {
    await set({ state: 'integrating', detail: undefined, waitingFor: undefined })
    const integration = await ensureIntegration(pipelineId, signal)
    const mainFolder = project.folders[0]
    let worktree = first.worktree
    if (!worktree) throw new GaveUp('The task has no worktree to integrate.')
    if (!(await exists(worktree.path))) {
      worktree = await createWorktree({ mainFolder, projectId: project.id, task: first, signal })
      await persist(pipelineId, taskId, (t) => ({ ...t, worktree }))
    }

    const leftover = await dirtyFiles(worktree.path)
    if (leftover.length > 0) {
      throw new GaveUp(
        `The task's worktree has uncommitted changes (${leftover.slice(0, 5).join(', ')}) — the final commit may have failed. Commit or discard them, then retry.`,
      )
    }

    for (let pass = 0; ; pass++) {
      if (pass >= 3) throw new GaveUp('The integration branch kept changing while this task was being merged.')

      await reconcile({
        pipeline,
        task: first,
        cwd: worktree.path,
        folder: worktree.folder,
        ref: integration.branch,
        signal,
        budget,
        report: (detail) => set({ detail, attempts: budget.used }),
        account,
      })

      // The person's own uncommitted edits in the integration only matter when
      // they touch a file this task changed: then git would refuse, so we wait.
      for (;;) {
        const blocking = await overlap(integration.path, integration.branch, worktree.branch)
        if (blocking.length === 0) break
        await set({ state: 'queued', detail: 'waiting', waitingFor: blocking })
        await sleep(tuning.waitMs, signal)
      }
      await set({ state: 'integrating', detail: undefined, waitingFor: undefined })

      const merged = await mergeRef(integration.path, worktree.branch, {
        noFf: true,
        message: `Merge ${first.number !== undefined ? `#${first.number} ` : ''}${first.title}`,
        signal,
      })
      if (merged.status === 'conflict') {
        // Someone committed in the integration since the update: update again.
        await abortMerge(integration.path)
        continue
      }
      if (merged.status === 'error') throw new GaveUp(merged.message)
      await set({
        state: 'integrated',
        detail: undefined,
        waitingFor: undefined,
        attempts: budget.used,
        mergeHash: merged.status === 'merged' ? merged.hash : undefined,
      })
      break
    }

    // The branch keeps the work until delivery (a return recreates the worktree
    // from it); the folder only takes disk.
    await removeWorktree(mainFolder, worktree, { keepSnapshots: true }).catch((err) =>
      console.error('[pipeline] worktree removal after integration failed:', err),
    )
  } catch (err) {
    if (signal.aborted) {
      // App shutting down: the step restarts from the queue at the next boot.
      await set({ state: 'queued', detail: undefined, waitingFor: undefined })
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    if (!(err instanceof GaveUp)) console.error('[pipeline] integration failed:', err)
    await set({ state: 'failed', detail: message, waitingFor: undefined, attempts: budget.used })
  } finally {
    afterSettled(pipelineId)
  }
}

/**
 * At boot: a task found `integrating` died with the app. Aborts any merge it left
 * in a worktree and puts every unfinished task back in the queue.
 */
export async function recoverIntegrations(pipelineId: string): Promise<void> {
  const context = await loadContext(pipelineId)
  if (!context) return
  const tasks = await listTasks(pipelineId)
  const stale = tasks.filter((t) => t.status === 'completed' && !t.deliveryId && t.integration && t.integration.state !== 'integrated' && t.integration.state !== 'failed')
  if (stale.length === 0) return
  for (const task of stale) {
    if (task.worktree && (await exists(task.worktree.path)) && (await mergeInProgress(task.worktree.path))) {
      await abortMerge(task.worktree.path)
    }
  }
  const integration = context.pipeline.integration
  if (integration && (await exists(integration.path)) && (await mergeInProgress(integration.path))) {
    await abortMerge(integration.path)
  }
  for (const task of stale) {
    await persist(pipelineId, task.id, (t) => (t.integration ? { ...t, integration: queuedState() } : t))
    void enqueueIntegration(pipelineId, task.id)
  }
}

// ─── Status ──────────────────────────────────────────────────────────────────

export async function integrationStatus(pipelineId: string): Promise<IntegrationStatus | null> {
  const context = await loadContext(pipelineId)
  const integration = context?.pipeline.integration
  if (!integration || !(await exists(integration.path))) return null
  const [ahead, dirty, tasks] = await Promise.all([
    git(integration.path, ['rev-list', '--count', `${integration.base}..${integration.branch}`]).catch(() => '0'),
    dirtyFiles(integration.path),
    listTasks(pipelineId),
  ])
  return {
    branch: integration.branch,
    base: integration.base,
    ahead: Number(ahead) || 0,
    dirty,
    queued: tasks.filter((t) => !t.deliveryId && (t.integration?.state === 'queued' || t.integration?.state === 'integrating')).length,
  }
}

/** Local branches a delivery can go to (the pipeline's own are left out). */
export async function destinationBranches(pipelineId: string): Promise<{ branches: string[]; default?: string }> {
  const context = await loadContext(pipelineId)
  if (!context) return { branches: [] }
  const folder = context.project.folders[0]
  if (!folder) return { branches: [] }
  const repo = await repositoryRoot(folder).catch(() => undefined)
  if (!repo) return { branches: [] }
  const integration = context.pipeline.integration
  const all = await localBranches(repo)
  const branches = all.filter((b) => b !== integration?.branch && !b.startsWith('pipeline/') && !b.startsWith('esteira/'))
  const base = integration?.base ?? context.pipeline.branch
  return { branches, default: base && branches.includes(base) ? base : undefined }
}

// ─── Commit of the integration (before a Merge) ──────────────────────────────

/** Tasks whose work sits in the integration, for the commit message and the history. */
function pendingTasks(tasks: Task[]): Task[] {
  return tasks.filter((t) => t.status === 'completed' && !t.deliveryId)
}

/**
 * Commits what is loose in the integration worktree: the model writes the
 * message from the tasks that are waiting to be delivered.
 */
export function commitIntegration(pipelineId: string): Promise<{ ok: boolean; hash?: string; error?: string }> {
  return inChain(pipelineId, async () => {
    const context = await loadContext(pipelineId)
    if (!context) return { ok: false, error: 'Pipeline not found.' }
    const { pipeline } = context
    const integration = await ensureIntegration(pipelineId, shutdown.signal)
    const tasks = pendingTasks(await listTasks(pipelineId))
    const summary = tasks
      .map((t) => `- ${t.number !== undefined ? `#${t.number} ` : ''}${t.title}${t.description.trim() ? `: ${t.description.trim().slice(0, 400)}` : ''}`)
      .join('\n')
    const stand: Task = {
      id: newId('integration_'),
      pipelineId,
      title: pipeline.name,
      description: `Commit the pending changes of the pipeline "${pipeline.name}". They come from these tasks:\n${summary || '(none)'}`,
      status: 'completed',
      currentPhase: null,
      dependsOn: [],
      notes: [],
      createdAt: now(),
      workTimeMs: 0,
      tokens: 0,
      cost: 0,
    }
    const result = await tryCommit(integration.path, pipeline, stand, [integration.folder], shutdown.signal)
    if (result.error) return { ok: false, error: result.error }
    return { ok: true, hash: result.hash }
  })
}

// ─── Merge (delivery) ────────────────────────────────────────────────────────

/** Archives tasks into a delivery: read-only history, their branches deleted. */
async function archive(
  pipelineId: string,
  repo: string | undefined,
  deliveryId: string,
  ids: string[],
): Promise<void> {
  const stamp = now()
  const archived: Task[] = []
  const tasks = await modifyTasks(pipelineId, (all) => {
    for (const t of all) {
      if (!ids.includes(t.id)) continue
      t.deliveryId = deliveryId
      t.archivedAt = stamp
      // The patch is read back from git by the merge hash: keeping it would only
      // bloat the store. Without a hash (shared tree, simple mode) it stays.
      if (t.diff && t.integration?.mergeHash) t.diff = { ...t.diff, patch: '' }
      archived.push(t)
    }
    return all
  })
  emit({ type: 'tasks', pipelineId, tasks })
  if (!repo) return
  for (const t of archived) {
    if (t.worktree && !t.worktree.shared) {
      if (await exists(t.worktree.path)) await removeWorktree(repo, t.worktree).catch(() => {})
      await deleteBranch(repo, t.worktree.branch)
    }
  }
}

function emitDeliveries(pipelineId: string, deliveries: Delivery[]): void {
  emit({ type: 'deliveries', pipelineId, deliveries })
}

/**
 * The Merge button: delivers the integration branch to `destination`.
 *
 * Runs in the pipeline's queue, so it waits for tasks already being merged. It
 * refuses (with the files) when the integration has uncommitted changes, brings
 * the destination in first (same conflict and check handling as a task), then
 * fast-forwards the destination — it never creates a merge commit there.
 */
export function mergeIntegration(pipelineId: string, destination?: string): Promise<MergeOutcome> {
  return inChain(pipelineId, async (): Promise<MergeOutcome> => {
    const context = await loadContext(pipelineId)
    if (!context) return { status: 'failed', message: 'Pipeline not found.' }
    const { pipeline } = context
    if (pipelineFlow(pipeline) === 'simple') return { status: 'failed', message: 'This pipeline has no integration branch.' }
    const signal = shutdown.signal
    try {
      const integration = await ensureIntegration(pipelineId, signal)
      const repo = await repositoryRoot(integration.path)
      const target = destination ?? (await destinationBranches(pipelineId)).default
      if (!target) return { status: 'failed', message: 'Choose the branch to merge into.' }
      if (!(await localBranches(repo)).includes(target)) {
        return { status: 'failed', message: `The branch "${target}" does not exist.` }
      }
      if (target === integration.branch) return { status: 'failed', message: 'The destination is the integration branch itself.' }

      const dirty = await dirtyFiles(integration.path)
      if (dirty.length > 0) return { status: 'dirty', files: dirty }

      const tasks = pendingTasks(await listTasks(pipelineId))
      const stand: Task = {
        id: newId('integration_'),
        pipelineId,
        title: `integration of ${pipeline.name}`,
        description: `Bring "${target}" into the integration branch of the pipeline "${pipeline.name}".`,
        status: 'completed',
        currentPhase: null,
        dependsOn: [],
        notes: [],
        createdAt: now(),
        workTimeMs: 0,
        tokens: 0,
        cost: 0,
      }
      await reconcile({
        pipeline,
        task: stand,
        cwd: integration.path,
        folder: integration.folder,
        ref: target,
        signal,
        budget: { used: 0 },
        report: async () => {},
        account: async () => {},
      })

      const moved = await fastForward(repo, target, integration.branch)
      if (moved.status === 'blocked') return { status: 'blocked', files: moved.files, where: moved.where }
      if (moved.status === 'failed') return { status: 'failed', message: moved.message }

      const delivered = tasks.filter((t) => !t.integration || t.integration.state === 'integrated')
      const delivery = await addDelivery(pipelineId, {
        destination: target,
        mergeHash: moved.hash,
        taskIds: delivered.map((t) => t.id),
        taskNumbers: delivered.map((t) => t.number).filter((n): n is number => n !== undefined),
      })
      await archive(pipelineId, repo, delivery.id, delivered.map((t) => t.id))
      emitDeliveries(pipelineId, await listDeliveries(pipelineId))
      return { status: 'delivered', delivery }
    } catch (err) {
      if (err instanceof GaveUp) return { status: 'failed', message: err.message }
      if (signal.aborted) return { status: 'failed', message: 'Interrupted.' }
      return { status: 'failed', message: err instanceof Error ? err.message : String(err) }
    }
  })
}

/**
 * Simple mode (and tasks that finished before the integration existed): moves
 * the completed tasks to the history without merging anything.
 */
export async function archiveCompleted(pipelineId: string): Promise<Delivery | null> {
  const tasks = (await listTasks(pipelineId)).filter(
    (t) => t.status === 'completed' && !t.deliveryId && t.integration?.state !== 'queued' && t.integration?.state !== 'integrating',
  )
  if (tasks.length === 0) return null
  const delivery = await addDelivery(pipelineId, {
    taskIds: tasks.map((t) => t.id),
    taskNumbers: tasks.map((t) => t.number).filter((n): n is number => n !== undefined),
  })
  await archive(pipelineId, undefined, delivery.id, tasks.map((t) => t.id))
  emitDeliveries(pipelineId, await listDeliveries(pipelineId))
  return delivery
}

/**
 * Deletes a delivery from the history: the record, its archived tasks and the
 * images they stored. Git is untouched. Never called by the engine on its own.
 */
export async function deleteDelivery(pipelineId: string, deliveryId: string): Promise<void> {
  const tasks = await listTasks(pipelineId)
  const gone = tasks.filter((t) => t.deliveryId === deliveryId)
  const urls = new Set<string>()
  for (const t of gone) {
    for (const url of mediaUrlsIn(t.description)) urls.add(url)
    for (const n of t.notes) for (const url of mediaUrlsIn(n.content)) urls.add(url)
  }
  await deleteMediaUrls([...urls])
  const remaining = await modifyTasks(pipelineId, (all) => {
    const kept = all.filter((t) => t.deliveryId !== deliveryId)
    all.splice(0, all.length, ...kept)
    return kept
  })
  emit({ type: 'tasks', pipelineId, tasks: remaining })
  emitDeliveries(pipelineId, await removeDelivery(pipelineId, deliveryId))
}

/** What an archived task contributed, read from git by its merge commit. */
export async function archivedTaskDiff(
  pipelineId: string,
  task: Task,
): Promise<{ files: string[]; patch: string } | null> {
  const hash = task.integration?.mergeHash
  if (!hash) return task.diff ? { files: task.diff.files, patch: task.diff.patch } : null
  const context = await loadContext(pipelineId)
  const folder = context?.project.folders[0]
  if (!folder) return null
  const repo = await repositoryRoot(folder).catch(() => undefined)
  if (!repo) return null
  return mergeDiff(repo, hash).catch(() => (task.diff ? { files: task.diff.files, patch: task.diff.patch } : null))
}

/** Reopen: a NEW pending task that follows up an archived one, from the current integration. */
export function followUpTitle(task: Pick<Task, 'title' | 'number'>): string {
  return `Follow-up${task.number !== undefined ? ` of #${task.number}` : ''}: ${task.title}`
}

