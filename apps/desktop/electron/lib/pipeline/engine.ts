import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { generateText } from 'ai'
import type { NewTaskInput, PhaseNote, Pipeline, PipelineEvent, Project, Task, TaskWorktree } from '@shared/pipeline'
import {
  PIPELINE_COMMIT_PROMPT_DEFAULT,
  PIPELINE_RETRY_DEFAULT,
  notesForRound,
  returnForRound,
  taskRound,
} from '@shared/pipeline'
import type { SendMessageInput } from '@shared/chat'
import { capture, diff } from '../snapshot'
import { userShellEnv } from '../shell-env'
import { createsCycle, pendingDependencies } from './contract'
import { runPhase, type ToolProgress } from './runner'
import { updateTask, listPipelines, listProjects, listTasks, modifyTasks } from './repo'
import { broadcastPipelineEvent } from '../broadcast'
import { loadPromptContext, search as searchMemory } from '../memory/service'
import { getProvider } from '../catalog'
import { resolveModel } from '../providers'
import { withProviderSession } from '../provider-session'
import { buildProviderOptions, interleavedReasoningField, normalizeMessages } from '../reasoning'
import { toTokenUsage } from '../usage'
import { killProcess, listProcesses } from '../process-manager'
import { createWorktree, exists, cleanOrphans, removeWorktree } from './worktree'
import type { Memory } from '@shared/memory'

const execFileAsync = promisify(execFile)

/**
 * State machine and queue of pipeline mode (§5, §6, §9 of the design).
 *
 * Central rule: the pipeline is LINEAR. The engine only advances
 * currentPhase → +1; there is no going back and no automatic skipping. The only
 * entry outside phase 1 is the manual start by drag, and even then the previous
 * phases are recorded as 'skipped' — the history never pretends they ran.
 *
 * Rounds: a completed task can be RETURNED by the user with a comment
 * (returnTask). That opens a new round, which walks the pipeline again on top of
 * the work already done — linear applies within each round.
 */

/** Live runs per task: allows pausing/aborting and prevents running twice. */
const running = new Map<string, AbortController>()
/**
 * In-flight execution promise per task. Without it, pausing and resuming right
 * after falls into a race: the resume arrives before the aborted execution
 * clears `running`, executeTask bails at the initial guard and the task stays
 * 'in_progress' with nobody executing it.
 */
const executions = new Map<string, Promise<void>>()

/** Aborts the task's execution (if any) and waits for it to actually finish. */
async function stopAndWait(taskId: string): Promise<void> {
  running.get(taskId)?.abort()
  const pending = executions.get(taskId)
  if (pending) await pending.catch(() => {})
}
/** Pipelines with the automatic queue enabled. */
const activeQueues = new Set<string>()
/** Pause requested by the user: the task stops when the current phase ends. */
const pauseRequested = new Set<string>()

function now(): string {
  return new Date().toISOString()
}

function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Single funnel of the pipeline events: windows (renderer) + companions (mobile
 * app) — the mobile app mirrors the whole board through this channel.
 */
export function emit(event: PipelineEvent): void {
  broadcastPipelineEvent(event)
}

async function loadContext(pipelineId: string): Promise<{ pipeline: Pipeline; project: Project } | null> {
  const pipeline = (await listPipelines()).find((p) => p.id === pipelineId)
  if (!pipeline) return null
  const project = (await listProjects()).find((p) => p.id === pipeline.projectId)
  if (!project) return null
  return { pipeline, project }
}

async function persist(pipelineId: string, taskId: string, patch: (t: Task) => Task): Promise<Task | null> {
  const task = await updateTask(pipelineId, taskId, patch)
  if (task) emit({ type: 'task', pipelineId, task })
  return task
}

// ─── Dependencies ────────────────────────────────────────────────────────────

export { createsCycle, pendingDependencies } from './contract'

// ─── Task worktree ───────────────────────────────────────────────────────────

/**
 * Worktree the task will run in, or undefined for the main repository.
 *
 * It is only born on the FIRST execution (round 1, no phase executed yet):
 * turning the option on with the task halfway through would change the working
 * folder and hide what the previous phases did. If it already exists it is
 * reused; if the folder is gone (deleted by hand), it is recreated on the same
 * branch — the committed work comes back.
 */
async function ensureWorktree(
  pipelineId: string,
  pipeline: Pipeline,
  project: Project,
  taskId: string,
  signal: AbortSignal,
): Promise<TaskWorktree | undefined> {
  const tasks = await listTasks(pipelineId)
  const task = tasks.find((t) => t.id === taskId)
  if (!task) return undefined
  if (task.worktree) {
    if (await exists(task.worktree.path)) return task.worktree
  } else {
    const firstRun = taskRound(task) === 1 && task.notes.every((n) => n.status === 'skipped')
    if (!pipeline.worktreePerTask || !firstRun) return undefined
  }
  const mainFolder = project.folders[0]
  if (!mainFolder) throw new Error('The project has no main folder.')

  emit({
    type: 'phase-progress',
    pipelineId,
    taskId,
    phaseIndex: task.currentPhase ?? 0,
    text: task.worktree ? 'Recriando o worktree da task…\n\n' : 'Preparando o worktree da task…\n\n',
  })
  const created = await createWorktree({
    mainFolder,
    projectId: project.id,
    task,
    base: task.worktree ? undefined : branchFromDependencies(task, tasks),
    signal,
  })
  await persist(pipelineId, taskId, (t) => ({ ...t, worktree: created }))
  return created
}

/**
 * A task that depends on ONE task with a worktree starts from its branch: the
 * dependency's work was not merged into the base yet, and without this the
 * dependent task would start without it. With several, there is no single branch
 * — start from the base.
 */
function branchFromDependencies(task: Task, tasks: Task[]): string | undefined {
  const withBranch = task.dependsOn
    .map((id) => tasks.find((t) => t.id === id)?.worktree)
    .filter((w): w is TaskWorktree => !!w)
  return withBranch.length === 1 ? withBranch[0].branch : undefined
}

/**
 * Removes the worktree of a task that is going away (task, pipeline or project
 * removed): stops the execution, kills the background processes it left running
 * in there and deletes the folder. The branch stays — the committed work remains
 * reachable in the repository.
 */
async function discardTaskWorktree(task: Task, mainFolder: string | undefined): Promise<void> {
  running.get(task.id)?.abort()
  await stopAndWait(task.id)
  if (!task.worktree) return
  for (const process of listProcesses(`pipeline_${task.id}`)) {
    if (process.status === 'running') await killProcess(process.pid).catch(() => false)
  }
  await removeWorktree(mainFolder, task.worktree).catch((err) =>
    console.error('[pipeline] worktree removal failed:', err),
  )
}

/** Removes the worktrees of every task of a pipeline (before deleting it). */
export async function discardPipelineWorktrees(pipelineId: string): Promise<void> {
  const context = await loadContext(pipelineId)
  for (const task of await listTasks(pipelineId)) {
    await discardTaskWorktree(task, context?.project.folders[0])
  }
}

// ─── Execution of one task ───────────────────────────────────────────────────

/**
 * Runs the task from the current phase to the last one, or until it pauses or
 * fails. Each phase is attempted up to retryCount times; once exhausted, the
 * task pauses with reason 'error' and waits for human intervention (§9).
 */
async function executeTask(pipelineId: string, taskId: string, resumingInterrupted = false): Promise<void> {
  if (running.has(taskId)) return
  const execution = runTask(pipelineId, taskId, resumingInterrupted)
  executions.set(taskId, execution)
  try {
    await execution
  } finally {
    if (executions.get(taskId) === execution) executions.delete(taskId)
  }
}

async function runTask(pipelineId: string, taskId: string, resumingInterrupted: boolean): Promise<void> {
  const context = await loadContext(pipelineId)
  if (!context) return
  const { pipeline, project } = context

  const controller = new AbortController()
  running.set(taskId, controller)
  const runStart = Date.now()

  // Task worktree (pipeline with worktreePerTask): created before the first phase
  // and reused on resumes and returns. Failing here pauses the task with the
  // reason — running in the main repository would break the isolation.
  let worktree: TaskWorktree | undefined
  try {
    worktree = await ensureWorktree(pipelineId, pipeline, project, taskId, controller.signal)
  } catch (err) {
    running.delete(taskId)
    if (!controller.signal.aborted) {
      const reason = err instanceof Error ? err.message : String(err)
      console.error('[pipeline] task worktree failed:', err)
      await persist(pipelineId, taskId, (t) =>
        t.status === 'in_progress'
          ? {
              ...t,
              status: 'paused',
              pauseReason: 'error',
              error: `Could not prepare the task worktree: ${reason}`,
            }
          : t,
      )
    }
    if (activeQueues.has(pipelineId)) void advanceQueue(pipelineId)
    return
  }
  const root = worktree?.folder || pipeline.worktree || project.folders[0]
  // The main folder becomes the worktree's; the extra ones stay shared.
  const folders = worktree ? [worktree.folder, ...project.folders.slice(1)] : project.folders

  /**
   * Filesystem snapshot before the first phase of this execution. The task's
   * diff is measured against it — the same mechanism as the chat's per-message
   * diff, and it does not depend on the agent reporting what it touched.
   */
  const baseDiff = await (async () => {
    const existing = (await listTasks(pipelineId)).find((t) => t.id === taskId)?.diff?.start
    if (existing) return existing // resume: keeps the task's original base
    try {
      return root ? await capture(root) : undefined
    } catch (err) {
      console.error('[pipeline] initial snapshot failed:', err)
      return undefined
    }
  })()

  /** Recomputes the task's accumulated diff against the initial snapshot. */
  const measureDiff = async (): Promise<Task['diff'] | undefined> => {
    if (!baseDiff || !root) return undefined
    try {
      const end = await capture(root)
      if (end === baseDiff) return { start: baseDiff, files: [], patch: '' }
      const changes = await diff(root, baseDiff, end)
      return { start: baseDiff, files: changes.files, patch: changes.patch }
    } catch (err) {
      console.error('[pipeline] task diff failed:', err)
      return undefined
    }
  }

  try {
    for (;;) {
      const tasks = await listTasks(pipelineId)
      const task = tasks.find((t) => t.id === taskId)
      if (!task || task.status !== 'in_progress' || task.currentPhase == null) break
      if (controller.signal.aborted) break

      const index = task.currentPhase
      const phase = pipeline.phases[index]
      if (!phase) {
        // Phases removed from the pipeline after the task started: complete
        // instead of leaving the task stuck pointing at a phase that no longer
        // exists.
        await complete(pipelineId, taskId, runStart)
        break
      }

      const startedAt = now()
      // Live feed of the phase: text, thinking and tools go to the UI through
      // the same channel as the state events (the modal shows the execution).
      const progress = (phaseIndex: number) => ({
        onText: (text: string) => emit({ type: 'phase-progress', pipelineId, taskId, phaseIndex, text }),
        onThinking: (text: string) => emit({ type: 'phase-thinking', pipelineId, taskId, phaseIndex, text }),
        onTool: (t: ToolProgress) =>
          emit({
            type: 'phase-tool',
            pipelineId,
            taskId,
            phaseIndex,
            toolCallId: t.toolCallId,
            tool: t.tool,
            state: t.state,
            summary: t.summary,
            detail: t.detail,
          }),
      })
      let result = await runPhase({
        pipeline,
        task,
        phase,
        phaseIndex: index,
        folders,
        attempt: 1,
        // Only on the phase where the interruption happened: the one that has no
        // note yet in this round.
        interruptedBefore:
          resumingInterrupted && !notesForRound(task, taskRound(task)).some((n) => n.phaseId === phase.id),
        abort: controller.signal,
        ...progress(index),
      })

      // Retry: each attempt receives the previous error so it attacks the cause.
      for (let attempt = 2; result.error && attempt <= PIPELINE_RETRY_DEFAULT; attempt++) {
        if (controller.signal.aborted) break
        result = await runPhase({
          pipeline,
          task,
          phase,
          phaseIndex: index,
          folders,
          attempt,
          previousError: result.error,
          abort: controller.signal,
          ...progress(index),
        })
      }

      if (controller.signal.aborted) break

      const note: PhaseNote = {
        phaseId: phase.id,
        phaseName: phase.name,
        status: result.error ? 'error' : 'ok',
        content: result.note ?? (result.text.slice(0, 4000) || '(no annotation)'),
        controlledCommands: result.controlledCommands,
        commitHash: result.commitHash,
        tokens: result.tokens,
        cost: result.cost,
        startedAt,
        completedAt: now(),
        round: taskRound(task),
      }

      if (result.error) {
        const currentDiff = await measureDiff()
        await persist(pipelineId, taskId, (t) => ({
          ...t,
          status: 'paused',
          pauseReason: 'error',
          error: result.error,
          diff: currentDiff ?? t.diff,
          notes: [...t.notes, note],
          tokens: t.tokens + result.tokens,
          cost: t.cost + result.cost,
          workTimeMs: t.workTimeMs + (Date.now() - runStart),
        }))
        break
      }

      const lastPhase = index >= pipeline.phases.length - 1
      // Deterministic final commit + push (D10): the phases after development
      // cannot commit, so the commit here captures the task's complete work —
      // including the validation adjustments — instead of leaving it loose in the
      // working tree. Push implies commit: there is no delivering a branch without
      // the final state committed.
      const wantsFinalCommit = lastPhase && (pipeline.commitAtEnd !== false || pipeline.pushAtEnd)
      const commit = wantsFinalCommit
        ? await tryCommit(root, pipeline, task, folders, controller.signal)
        : undefined
      const pushError =
        lastPhase && pipeline.pushAtEnd
          ? commit?.error
            ? 'The final commit failed; the push was cancelled so as not to upload incomplete work.'
            : await tryPush(root, controller.signal)
          : undefined
      const currentDiff = await measureDiff()
      // The pause landed AFTER the model finished (during commit/push/diff): the
      // phase does not count as completed yet — resuming runs it again from
      // scratch, like any interrupted phase. Without this check, the persist below
      // overwrote the pause with 'completed' on the last phase (race between
      // pauseTask and the completion write).
      if (controller.signal.aborted) break
      const updated = await persist(pipelineId, taskId, (t) => ({
        ...t,
        diff: currentDiff ?? t.diff,
        notes: [...t.notes, note],
        tokens: t.tokens + result.tokens + (commit?.tokens ?? 0),
        cost: t.cost + result.cost + (commit?.cost ?? 0),
        commitError: commit?.error,
        finalCommitHash: commit?.hash,
        pushError,
        currentPhase: lastPhase ? t.currentPhase : index + 1,
        // Extra guard: if the pause won this write, do not complete.
        status: lastPhase && t.status === 'in_progress' ? 'completed' : t.status,
        completedAt: lastPhase && t.status === 'in_progress' ? now() : t.completedAt,
        workTimeMs: lastPhase ? t.workTimeMs + (Date.now() - runStart) : t.workTimeMs,
      }))
      if (lastPhase || !updated) break

      // SOFT stop — today only turning the automatic queue off goes through here
      // (§6.2): the task finishes the current phase and only then pauses, without
      // losing work. The pause button is the opposite: it aborts right away
      // (pauseTask).
      if (pauseRequested.has(taskId)) {
        pauseRequested.delete(taskId)
        await persist(pipelineId, taskId, (t) => ({
          ...t,
          status: 'paused',
          pauseReason: 'manual',
          workTimeMs: t.workTimeMs + (Date.now() - runStart),
        }))
        break
      }
    }
  } finally {
    running.delete(taskId)
    // Aborted in the middle of the phase: without this the task would stay
    // 'in_progress' forever, with the card spinning and nobody executing anything.
    if (controller.signal.aborted) {
      await persist(pipelineId, taskId, (t) =>
        t.status === 'in_progress'
          ? {
              ...t,
              status: 'paused',
              pauseReason: 'manual',
              phaseInterrupted: true,
              workTimeMs: t.workTimeMs + (Date.now() - runStart),
            }
          : t,
      )
    }
    pauseRequested.delete(taskId)
    // The automatic queue only moves when a task finishes — that is the "one at a time".
    if (activeQueues.has(pipelineId)) void advanceQueue(pipelineId)
  }
}

async function complete(pipelineId: string, taskId: string, runStart: number): Promise<void> {
  await persist(pipelineId, taskId, (t) =>
    // A pause may have won this write — never complete a task that was paused.
    t.status !== 'in_progress'
      ? t
      : {
          ...t,
          status: 'completed',
          completedAt: now(),
          workTimeMs: t.workTimeMs + (Date.now() - runStart),
        },
  )
}

// ─── Final commit ────────────────────────────────────────────────────────────

interface CommitResult {
  /** git error while measuring/staging/committing (message NOT generated is NOT an error — it becomes a fallback) */
  error?: string
  /** Short hash of the created commit */
  hash?: string
  tokens: number
  cost: number
}

/** How many paths per `git add` before falling back to add -A of the whole tree. */
const MAX_ADD_PATHS = 2000

/**
 * Deterministic final commit when `commitAtEnd` is on (D10).
 *
 * Without it, the adjustments from the phases after development would live only
 * in the working tree (the templates forbid them from committing) — and the push
 * would upload a branch without that work. The message is generated by a
 * one-shot call (no tools) with the SAME context a phase receives: task
 * description, notes from the previous phases, the user's commit preferences in
 * memory and the style of the repo's recent commits. Without a diff nothing is
 * committed — the previous phases may already have committed everything, and an
 * empty commit does not exist.
 *
 * Failure does NOT revert the task's completion (same as the push): the error
 * goes to `task.commitError` and the push is cancelled, so that incomplete work
 * is not uploaded.
 */
async function tryCommit(
  root: string,
  pipeline: Pipeline,
  task: Task,
  folders: string[],
  signal: AbortSignal,
): Promise<CommitResult> {
  // 1) Real diff of the worktree (porcelain -z + untracked-files=all: includes
  //    new files and does not break on paths with spaces/quotes).
  let status: string
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { cwd: root, env: userShellEnv(), timeout: 30_000, signal },
    )
    status = stdout
  } catch (err) {
    if (signal.aborted) return { tokens: 0, cost: 0 }
    const e = err as { stderr?: string; message?: string }
    return { error: e.stderr?.trim() || e.message || String(err), tokens: 0, cost: 0 }
  }
  if (!status.trim()) return { tokens: 0, cost: 0 }

  const { message, tokens, cost } = await generateCommitMessage(root, pipeline, task, folders, status, signal)

  // 3) Only the files the task changed (git status respects .gitignore): no
  //    scanning of the whole tree, nothing that is not the task's work.
  const paths = pathsFromStatus(status)
  const addArgs = paths.length > MAX_ADD_PATHS ? ['add', '-A'] : ['add', '-A', '--', ...paths]
  try {
    await execFileAsync('git', addArgs, { cwd: root, env: userShellEnv(), timeout: 120_000, signal })
  } catch (err) {
    if (signal.aborted) return { tokens, cost }
    const e = err as { stderr?: string; message?: string }
    return { error: e.stderr?.trim() || e.message || String(err), tokens, cost }
  }

  // 4) Commit — header and body as separate -m (git joins them with a blank
  //    line). An empty/fallback message falls back to the task title.
  const [header, ...body] = message.split('\n')
  const bodyJoined = body.join('\n').trim()
  const commitArgs = bodyJoined
    ? ['commit', '-m', header.trim() || task.title, '-m', bodyJoined]
    : ['commit', '-m', header.trim() || task.title]
  try {
    await execFileAsync('git', commitArgs, { cwd: root, env: userShellEnv(), timeout: 120_000, signal })
  } catch (err) {
    if (signal.aborted) return { tokens, cost }
    const e = err as { stderr?: string; message?: string }
    return { error: e.stderr?.trim() || e.message || String(err), tokens, cost }
  }

  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      env: userShellEnv(),
      timeout: 15_000,
      signal,
    })
    return { hash: stdout.trim() || undefined, tokens, cost }
  } catch {
    // An unreadable hash does not invalidate the commit — carry on without it in the report.
    return { tokens, cost }
  }
}

/**
 * Paths of `git status --porcelain=v1 -z`: each entry is `XY <path>`, except for
 * rename/copy (`R`/`C`) — with -z the current field is the DESTINATION and the
 * next field carries the origin (which no longer exists and does not need to go
 * into `git add`).
 */
function pathsFromStatus(status: string): string[] {
  const fields = status.split('\0')
  const paths: string[] = []
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    if (!field) continue
    const first = field[0]
    const path = field.slice(3)
    if (first === 'R' || first === 'C') {
      if (path) paths.push(path)
      i++
    } else if (path) {
      paths.push(path)
    }
  }
  return paths
}

/**
 * Generates the final commit message with a one-shot call (no tools) on the
 * pipeline's default model. The system prompt is the pipeline's `commitPrompt`
 * or the default (what the task asks; without that, the style of the last
 * commit; without history, preferences in memory; Conventional Commits as
 * fallback). A failed call does NOT fail the commit: it falls back to the task
 * title.
 */
async function generateCommitMessage(
  root: string,
  pipeline: Pipeline,
  task: Task,
  folders: string[],
  status: string,
  signal: AbortSignal,
): Promise<{ message: string; tokens: number; cost: number }> {
  const phase = pipeline.phases[0]
  if (!phase) return { message: task.title, tokens: 0, cost: 0 }
  let provider
  try {
    provider = await getProvider(phase.providerId)
  } catch {
    provider = undefined
  }
  let model
  try {
    model = await resolveModel(phase.providerId, phase.modelId)
  } catch (err) {
    console.error('[pipeline] final commit model unavailable — fallback message:', err)
    return { message: task.title, tokens: 0, cost: 0 }
  }

  // User's commit preferences: general ones by weight + a targeted search (the
  // lexical search finds "commit messages in English" even outside the top
  // results).
  const ctx = await loadPromptContext('code', root)
  const commitPrefs = await searchMemory({ query: 'commit', kinds: ['general'], limit: 5 }).catch(() => [])
  const memories = [...ctx.general, ...commitPrefs.filter((m) => !ctx.general.includes(m))]

  // Real style of the repo: the most recent commit is the de facto preference;
  // the headers list serves as a pattern when the last one is not enough to infer
  // the format.
  let log = ''
  let lastCommit = ''
  try {
    const [list, last] = await Promise.all([
      execFileAsync('git', ['log', '--oneline', '-20'], {
        cwd: root,
        env: userShellEnv(),
        timeout: 15_000,
        signal,
      }),
      execFileAsync('git', ['log', '-1', '--format=%B'], {
        cwd: root,
        env: userShellEnv(),
        timeout: 15_000,
        signal,
      }),
    ])
    log = list.stdout.trim()
    lastCommit = last.stdout.trim().slice(0, 4000)
  } catch {
    // repository without commits yet — carry on without the style block
  }

  const input: SendMessageInput = {
    sessionId: `pipeline_${task.id}`,
    text: task.description,
    providerId: phase.providerId,
    modelId: phase.modelId,
    mode: 'code',
    options: { permissionMode: 'full' },
    directory: root,
    extraDirectories: folders.filter((p) => p !== root),
  }

  const providerOptions = await buildProviderOptions(input)
  try {
    // withProviderSession: providers that require a stable conversation
    // identifier (e.g. the x-opencode-session header) receive the task's, as in
    // the phases.
    const { text, usage } = await withProviderSession(`pipeline_${task.id}`, () =>
      generateText({
        model,
        system: pipeline.commitPrompt?.trim() || PIPELINE_COMMIT_PROMPT_DEFAULT,
        messages: normalizeMessages(
          [
            {
              role: 'user',
              content: buildCommitPrompt({ pipeline, task, folders, status, memories, log, lastCommit }),
            },
          ],
          interleavedReasoningField(provider, phase.modelId),
        ),
        abortSignal: signal,
        providerOptions,
      }),
    )
    const tok = toTokenUsage(usage, provider?.models[phase.modelId]?.cost)
    const message = cleanCommitMessage(text)
    return {
      message: message || task.title,
      tokens: tok.input + tok.output + (tok.reasoning ?? 0),
      cost: tok.cost ?? 0,
    }
  } catch (err) {
    console.error('[pipeline] final commit message generation failed — falling back to the title:', err)
    return { message: task.title, tokens: 0, cost: 0 }
  }
}

/**
 * Context of the commit message — mirrors what a phase receives (buildMessage in
 * the runner): the agent must know what the previous phases did to write a good
 * commit, not guess it from the diff.
 */
function buildCommitPrompt(ctx: {
  pipeline: Pipeline
  task: Task
  folders: string[]
  status: string
  memories: Memory[]
  log: string
  lastCommit: string
}): string {
  const parts: string[] = []
  parts.push(`# Task: ${ctx.task.title}`)
  if (ctx.task.description.trim()) parts.push(ctx.task.description.trim())

  const phases = ctx.pipeline.phases
  const phaseList = phases.map((p) => `${p.name} — ${p.description}`).join('\n')
  parts.push(`\n## Pipeline\nThis task ran through ${phases.length} phases:\n${phaseList}`)

  // Review round: the commit describes the FIX the user asked for, with this
  // round's notes (the previous ones were already committed in their rounds).
  const round = taskRound(ctx.task)
  const taskReturn = returnForRound(ctx.task, round)
  if (taskReturn) {
    parts.push(
      `\n## Review round ${round}\nThe user reviewed the previous round and sent the task back with this feedback — this commit is the fix for it:\n${taskReturn.text}`,
    )
  }

  const earlier = notesForRound(ctx.task, round).filter((n) => n.status !== 'skipped')
  if (earlier.length > 0) {
    parts.push('\n## Notes from the phases')
    for (const n of earlier) {
      parts.push(`### ${n.phaseName} (${n.status})\n${n.content}`)
    }
  }

  const repo: string[] = [`Working folder: ${ctx.folders[0] ?? '(none)'}`]
  if (ctx.task.worktree) repo.push(`Branch: ${ctx.task.worktree.branch} (isolated worktree of this task)`)
  else if (ctx.pipeline.branch) repo.push(`Branch: ${ctx.pipeline.branch}`)
  if (ctx.pipeline.worktree) repo.push(`Worktree: ${ctx.pipeline.worktree}`)
  parts.push(`\n## Repository\n${repo.join('\n')}`)

  parts.push(`\n## Changed files (working tree)\n${ctx.status.trim() || '(none)'}`)

  // Style precedence, in the same order as the default prompt: what the task asks
  // (brief, at the top), the repo's most recent commit, the headers and, last,
  // the preferences from memory — only when there is no commit above to imitate.
  if (ctx.lastCommit) {
    parts.push(
      `\n## Most recent commit in this repository (match its language, format and scope)\n${ctx.lastCommit}`,
    )
  }
  if (ctx.log) {
    parts.push(`\n## Recent commit headers (pattern reference)\n${ctx.log}`)
  }
  if (ctx.memories.length > 0) {
    parts.push(
      `\n## User's commit preferences (from memory — use them only when there is no commit above to imitate)\n${ctx.memories.map((m) => `- ${m.text}`).join('\n')}`,
    )
  }
  return parts.join('\n')
}

/** Strips markdown fences and leftover blank lines from the model's response. */
function cleanCommitMessage(text: string): string {
  const withoutFences = text.trim().replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/i, '')
  return withoutFences.trim()
}

// ─── Final push ──────────────────────────────────────────────────────────────

/**
 * Deterministic push of the branch when `pushAtEnd` is on. It used to be an
 * instruction in the Report phase prompt (removed): the model could forget or
 * fail, and the push was one more LLM cost. Now the engine runs it when the last
 * phase completes and records the result.
 *
 * Failure does NOT revert the task's completion: the work is done, the push is
 * delivery — the error goes to `task.pushError` for the user to solve. First
 * `git push`; if it fails without upstream, tries `git push -u origin HEAD`.
 */
async function tryPush(root: string, signal: AbortSignal): Promise<string | undefined> {
  const attempts: string[][] = [
    ['git', 'push'],
    ['git', 'push', '-u', 'origin', 'HEAD'],
  ]
  let lastError = 'git push failed with no details.'
  for (const args of attempts) {
    try {
      await execFileAsync('git', args, { cwd: root, env: userShellEnv(), timeout: 120_000, signal })
      return undefined
    } catch (err) {
      // Pause in the middle of the push: the task is going to be paused anyway,
      // so recording a push failure in the state makes no sense.
      if (signal.aborted) return undefined
      const e = err as { stderr?: string; stdout?: string; message?: string }
      lastError = e.stderr?.trim() || e.stdout?.trim() || e.message || String(err)
    }
  }
  return lastError
}

// ─── Automatic queue (D9) ────────────────────────────────────────────────────

/**
 * One task at a time: the queue only fires the next one when the current
 * automatic task has completed ALL phases. The guard uses the PERSISTED state
 * (the Task's `auto` field), not an in-memory registry — a pause, an error, a
 * manual resume or turning the queue off/on never let the queue advance with the
 * previous one halfway through. Manually started tasks (`auto` absent) run in
 * parallel on purpose and neither block nor are blocked by the queue.
 */
const queueRunning = new Set<string>()

async function advanceQueue(pipelineId: string): Promise<void> {
  if (!activeQueues.has(pipelineId) || queueRunning.has(pipelineId)) return
  queueRunning.add(pipelineId)
  try {
    const tasks = await listTasks(pipelineId)
    // An automatic task that is not completed (running, paused or failed) holds
    // the queue: the next one only enters once the current one went all the way.
    // Solving that is up to the user (resume, remove or turn the queue off).
    const automaticUnfinished = tasks.some((t) => t.auto === true && t.status !== 'completed')
    if (automaticUnfinished) return
    const candidates = tasks
      .filter((t) => t.status === 'pending' && pendingDependencies(t, tasks).length === 0)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const next = candidates[0]
    if (!next) return
    await startTask(pipelineId, next.id, 0, true)
  } finally {
    queueRunning.delete(pipelineId)
  }
}

export function enableQueue(pipelineId: string): void {
  activeQueues.add(pipelineId)
  void advanceQueue(pipelineId)
}

/** Turning it off does not kill what is running: the task finishes the phase and pauses (§6.2). */
export function disableQueue(pipelineId: string): void {
  activeQueues.delete(pipelineId)
  void (async () => {
    const tasks = await listTasks(pipelineId)
    const current = tasks.find((t) => t.auto === true && t.status === 'in_progress')
    if (current) pauseRequested.add(current.id)
  })()
}

export function isQueueEnabled(pipelineId: string): boolean {
  return activeQueues.has(pipelineId)
}

// ─── Control API ─────────────────────────────────────────────────────────────

/**
 * Starts the task at the given phase. `startPhase > 0` comes from the drag: the
 * previous phases are recorded as 'skipped' so the history does not suggest they
 * ran. `auto` marks the task as started by the automatic queue (one at a time).
 */
export async function startTask(pipelineId: string, taskId: string, startPhase = 0, auto = false): Promise<void> {
  await stopAndWait(taskId)
  const context = await loadContext(pipelineId)
  if (!context) return
  const { pipeline } = context

  const skipped: PhaseNote[] = pipeline.phases.slice(0, startPhase).map((phase) => ({
    phaseId: phase.id,
    phaseName: phase.name,
    status: 'skipped',
    content: 'Phase skipped: the task was started manually from a later phase.',
    controlledCommands: [],
    tokens: 0,
    cost: 0,
    startedAt: now(),
    completedAt: now(),
  }))

  await persist(pipelineId, taskId, (t) => ({
    ...t,
    status: 'in_progress',
    currentPhase: startPhase,
    pauseReason: undefined,
    error: undefined,
    startedAt: t.startedAt ?? now(),
    auto: auto ? true : t.auto,
    // A resume keeps the notes; a start from scratch records the skipped ones
    notes: t.notes.length > 0 ? t.notes : skipped,
  }))
  void executeTask(pipelineId, taskId)
}

/**
 * Pauses NOW: aborts what the phase is doing (model and tools receive the abort)
 * and marks the task as paused.
 *
 * The previous version only marked it and waited for the phase to close — from
 * the user's side that is indistinguishable from a broken button, because a
 * phase takes minutes. The price is losing the current phase's work: on resume it
 * runs again from scratch (the previous phases already delivered their notes, and
 * the repository may hold partial changes — the resume warns the phase about
 * that).
 */
export async function pauseTask(pipelineId: string, taskId: string): Promise<void> {
  const controller = running.get(taskId)
  pauseRequested.add(taskId)
  controller?.abort()
  await persist(pipelineId, taskId, (t) =>
    t.status === 'in_progress'
      ? { ...t, status: 'paused', pauseReason: 'manual', phaseInterrupted: !!controller }
      : t,
  )
}

/**
 * Returns a completed task to the pipeline with the user's comment, opening a new
 * round from `startPhase`.
 *
 * The round runs on top of the work already done (same folder) and the task's
 * diff stays accumulated from the beginning — that is what matters for the
 * review. The phases before `startPhase` do not become 'skipped': their work
 * exists, from the previous round. Returning is manual: it does not enter the
 * automatic queue.
 */
export async function returnTask(
  pipelineId: string,
  taskId: string,
  text: string,
  startPhase = 0,
): Promise<void> {
  const comment = text.trim()
  if (!comment) throw new Error('The return comment is mandatory.')
  const context = await loadContext(pipelineId)
  if (!context) return
  const last = context.pipeline.phases.length - 1
  if (last < 0) throw new Error('The pipeline has no phases.')
  const start = Math.min(Math.max(0, Math.trunc(startPhase)), last)

  await stopAndWait(taskId)
  let returned = false
  await persist(pipelineId, taskId, (t) => {
    // Only a completed and stopped task: returning in the middle of an execution
    // would mix the notes of two rounds.
    if (t.status !== 'completed' || running.has(t.id)) return t
    returned = true
    const round = taskRound(t) + 1
    return {
      ...t,
      round,
      returns: [...(t.returns ?? []), { round, text: comment, startPhase: start, createdAt: now() }],
      status: 'in_progress',
      currentPhase: start,
      pauseReason: undefined,
      error: undefined,
      phaseInterrupted: undefined,
      commitError: undefined,
      pushError: undefined,
      // The final commit of the round that ended stays in the history (report).
      previousCommits: t.finalCommitHash ? [...(t.previousCommits ?? []), t.finalCommitHash] : t.previousCommits,
      finalCommitHash: undefined,
      completedAt: undefined,
      auto: undefined,
    }
  })
  if (!returned) throw new Error('Only a completed task can be returned.')
  void executeTask(pipelineId, taskId)
}

/**
 * Resuming restarts the SAME phase and resets the retry counter (§9.5).
 *
 * `instruction` (optional, only on a paused task): what the user wants the phase
 * to do differently — a piece of information that was missing, a direction to fix.
 * It is recorded on the task and enters the phase prompt as a priority
 * instruction, without opening a new round (that is the return, for a completed
 * task).
 */
export async function resumeTask(pipelineId: string, taskId: string, instruction?: string): Promise<void> {
  const text = instruction?.trim()
  const context = text ? await loadContext(pipelineId) : null
  await stopAndWait(taskId)
  const tasks = await listTasks(pipelineId)
  const task = tasks.find((t) => t.id === taskId)
  if (!task) return
  if (text && task.status !== 'paused') throw new Error('Only a paused task can be resumed with an instruction.')
  const interrupted = task.phaseInterrupted === true
  await persist(pipelineId, taskId, (t) => {
    const index = t.currentPhase ?? 0
    const phase = context?.pipeline.phases[index]
    return {
      ...t,
      status: 'in_progress',
      pauseReason: undefined,
      error: undefined,
      currentPhase: index,
      phaseInterrupted: undefined,
      instructions:
        text && phase
          ? [
              ...(t.instructions ?? []),
              { text, round: taskRound(t), phaseId: phase.id, phaseName: phase.name, createdAt: now() },
            ]
          : t.instructions,
    }
  })
  void executeTask(pipelineId, taskId, interrupted)
}

export function isTaskRunning(taskId: string): boolean {
  return running.has(taskId)
}

/**
 * Tasks persisted as 'in_progress' with nobody executing them: the app was closed
 * (or crashed) in the middle of a phase. `running` lives only in memory, so the
 * state on disk survives the process — and the card spun forever, as if the agent
 * were still working.
 *
 * Closes them as an interrupted pause, exactly like an abort: resuming runs the
 * phase FROM SCRATCH and the agent is warned that the tree may hold partial
 * changes. Runs at boot, before any new execution.
 */
export async function reconcileExecutions(): Promise<void> {
  for (const pipeline of await listPipelines()) {
    for (const task of await listTasks(pipeline.id)) {
      if (task.status !== 'in_progress' || running.has(task.id)) continue
      console.log(`[pipeline] task "${task.title}" was in progress with no execution — marking it as paused`)
      await persist(pipeline.id, task.id, (t) =>
        t.status === 'in_progress' ? { ...t, status: 'paused', pauseReason: 'manual', phaseInterrupted: true } : t,
      )
    }
  }
  // Worktrees of tasks that no longer exist (removed with the app closed or in a
  // removal that failed halfway) would only take up disk.
  const projects = await listProjects()
  const alive = new Map<string, Set<string>>()
  for (const pipeline of await listPipelines()) {
    const ids = alive.get(pipeline.projectId) ?? new Set<string>()
    for (const task of await listTasks(pipeline.id)) if (task.worktree) ids.add(task.id)
    alive.set(pipeline.projectId, ids)
  }
  await cleanOrphans(projects, alive).catch((err) => console.error('[pipeline] worktree cleanup failed:', err))
}

/** Aborts everything (app shutdown). */
export function abortAll(): void {
  for (const controller of running.values()) controller.abort()
  running.clear()
  activeQueues.clear()
  queueRunning.clear()
}

// ─── Task CRUD ───────────────────────────────────────────────────────────────

export async function createTask(input: NewTaskInput): Promise<Task> {
  const task: Task = {
    id: newId('task_'),
    pipelineId: input.pipelineId,
    title: input.title,
    description: input.description,
    status: 'pending',
    currentPhase: null,
    dependsOn: input.dependsOn ?? [],
    notes: [],
    createdAt: now(),
    workTimeMs: 0,
    tokens: 0,
    cost: 0,
    originSessionId: input.originSessionId,
  }
  // Append inside the lock (modifyTasks): concurrent creations are not lost.
  await modifyTasks(input.pipelineId, (tasks) => {
    tasks.push(task)
  })
  emit({ type: 'task', pipelineId: input.pipelineId, task })
  // A new task enters the automatic queue without waiting for the next completion.
  if (activeQueues.has(input.pipelineId)) void advanceQueue(input.pipelineId)
  return task
}

export async function updateTaskFields(
  pipelineId: string,
  taskId: string,
  patch: Partial<Pick<Task, 'title' | 'description' | 'dependsOn' | 'notes'>>,
): Promise<Task | null> {
  if (patch.dependsOn) {
    const tasks = await listTasks(pipelineId)
    if (createsCycle(taskId, patch.dependsOn, tasks)) {
      throw new Error('Circular dependency: the task would end up depending on itself.')
    }
  }
  return persist(pipelineId, taskId, (t) => ({ ...t, ...patch }))
}

export async function removeTask(pipelineId: string, taskId: string): Promise<void> {
  running.get(taskId)?.abort()
  const removed = (await listTasks(pipelineId)).find((t) => t.id === taskId)
  if (removed?.worktree) {
    const context = await loadContext(pipelineId)
    await discardTaskWorktree(removed, context?.project.folders[0])
  }
  // Filter + clean the dependencies INSIDE the lock: a removal concurrent with a
  // creation neither resurrects tasks nor leaves a dangling reference.
  const remaining = await modifyTasks(pipelineId, (tasks) => {
    const filtered = tasks
      .filter((t) => t.id !== taskId)
      .map((t) => (t.dependsOn.includes(taskId) ? { ...t, dependsOn: t.dependsOn.filter((d) => d !== taskId) } : t))
    tasks.splice(0, tasks.length, ...filtered)
    return filtered
  })
  emit({ type: 'tasks', pipelineId, tasks: remaining })
  // Removing the automatic task that was holding the queue (paused/error) frees the next one.
  if (activeQueues.has(pipelineId)) void advanceQueue(pipelineId)
}
