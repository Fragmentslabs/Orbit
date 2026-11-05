/**
 * Pipeline mode — task pipeline executor (see the pipeline design notes in docs/).
 *
 * A project (board) has pipelines; each pipeline is a FIXED sequence of phases
 * and a queue of tasks. Every phase runs with its own prompt, model, thinking
 * and tools, without a chat and without a manager agent: the routing is the
 * order of the phases itself.
 */

import type { ReasoningConfig } from './chat'

// ─── Project ─────────────────────────────────────────────────────────────────

export interface Project {
  id: string
  name: string
  /** Working folders, same semantics as the chat folder picker */
  folders: string[]
  createdAt: string
  /** ids of the project's pipelines */
  pipelines: string[]
}

// ─── Phases ──────────────────────────────────────────────────────────────────

/**
 * Capabilities unlocked per phase. It is a product grouping, not the name of
 * the engine tools — the mapping lives in electron/lib/pipeline/runner.ts.
 */
export type AllowedTool = 'read' | 'edit' | 'shell' | 'browser' | 'memory'

/**
 * Role of the phase in the pipeline. Defines what the phase does — and what it
 * leaves for the next ones — regardless of the name the user gives it. It is
 * what allows routing responsibilities (e.g. validate) even in custom phases.
 */
export type PhaseKind = 'development' | 'validation' | 'security' | 'review' | 'infra' | 'generic'

export interface PhaseConfig {
  id: string
  name: string
  description: string
  /** Phase instructions: what to do, what to note, when to fail */
  prompt: string
  /** Inherits the pipeline's default model; editable per phase */
  providerId: string
  modelId: string
  /** Legacy (never read at execution) — the reasoning level lives in `reasoning`. */
  thinkingLevel: number
  /** Phase reasoning; absent/null = off */
  reasoning?: ReasoningConfig | null
  /** Source template (absent in a phase created from scratch or saved before the field) */
  templateId?: string
  tools: AllowedTool[]
  /** Position in the sequence — execution follows ascending order, without skipping */
  order: number
  /**
   * Role of the phase in the pipeline. Optional for backwards compatibility:
   * pipelines saved before this field are read as 'generic' by consumers.
   */
  kind?: PhaseKind
}

/** System phase template: the phases are COPIED when the pipeline is created,
 *  so editing the pipeline never changes the master template. */
export interface PhaseTemplate {
  id: string
  name: string
  description: string
  prompt: string
  tools: AllowedTool[]
  /** true on the phases suggested up front in a new pipeline (the others come from the "+") */
  isDefault: boolean
  /** Created or overwritten by the user ("save as default") */
  custom?: boolean
  /** i18n key of the name/description (built-in phases). Absent on the user's. */
  i18nKey?: string
  /** Phase created by the user (not an overwrite of a built-in one) — can be deleted */
  userCreated?: boolean
  /** Role of the phase in the pipeline (defines responsibilities beyond name/prompt). */
  kind: PhaseKind
}

/** Phase already resolved in the creation modal — it may have been edited only
 *  for this pipeline, without becoming the default. */
export interface PhaseChoice {
  /** Source template (absent in a phase created from scratch) */
  templateId?: string
  name: string
  description: string
  prompt: string
  tools: AllowedTool[]
  /** Role of the phase in the pipeline. */
  kind: PhaseKind
  /** Phase's own model; absent = inherits the pipeline's default model */
  providerId?: string
  modelId?: string
  /** Phase's own reasoning; undefined = inherits the pipeline's, null = off */
  reasoning?: ReasoningConfig | null
}

// ─── Command policy ──────────────────────────────────────────────────────────

/**
 * Three layers: whatever is not on either list is free. More conservative than
 * interactive mode because the pipeline runs unsupervised (D5/D6).
 */
export interface CommandPolicy {
  /** Refused and noted on the task — counts as a phase failure */
  blocked: string[]
  /** Runs and is recorded in PhaseNote.controlledCommands */
  controlled: string[]
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

export type OperationMode = 'manual' | 'automatic'

export interface Pipeline {
  id: string
  projectId: string
  name: string
  /** Copy of the templates, editable without touching the master */
  phases: PhaseConfig[]
  /** Next task number to hand out (`Task.number`); never goes back. */
  nextTaskNumber?: number
  /**
   * The pipeline model: chosen when the pipeline is created, default of every
   * phase, and the one called when something must be decided outside a phase
   * (a merge conflict, a failed check, a commit message). Absent on older
   * pipelines — the first phase's model stands in (`pipelineModel`).
   */
  model?: { providerId: string; modelId: string; reasoning?: ReasoningConfig | null }
  /**
   * The integration branch and its worktree (see `pipelineFlow`). Born on the
   * first task that needs it; finished tasks are merged into it, and the
   * Merge button delivers it to a branch of the person's choice.
   */
  integration?: TaskWorktree
  /** How many automatic tasks run at once (1–4). Only with the `merge` flow; 1 otherwise. */
  parallelTasks?: number
  /** Working branch (absent = the repo's current branch) */
  branch?: string
  /** Legacy: fixed worktree path for the whole pipeline (no UI) */
  worktree?: string
  /**
   * Each task works in its own `git worktree`, on its own branch, and its work
   * is merged into the pipeline's integration branch. On by default; a folder
   * without git cannot use it (simple mode).
   */
  worktreePerTask?: boolean
  operationMode: OperationMode
  /**
   * The engine creates a final commit when the last phase completes, containing
   * only what the task changed (default true). Phases after development cannot
   * commit (templates), so without this their adjustments would live only in the
   * working tree and could not be merged. Off = the pipeline creates no commits.
   */
  commitAtEnd: boolean
  /**
   * Prompt of the agent that writes the final commit message. Absent = the
   * default (PIPELINE_COMMIT_PROMPT_DEFAULT): what the task asks about the
   * commit; without that, the style of the repository's most recent commit;
   * without history, the commit preferences in memory; without them,
   * Conventional Commits.
   */
  commitPrompt?: string
  commandPolicy: CommandPolicy
  templateId?: string
  createdAt: string
}

// ─── Task ────────────────────────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'in_progress' | 'paused' | 'completed'

/**
 * Merge-queue state of a completed task (flow `merge`). The task keeps status
 * `completed`; this says whether its work reached the integration branch.
 *
 * - `queued`: waiting its turn (or for a file the person is editing)
 * - `integrating`: the update-then-merge step is running
 * - `integrated`: merged into the integration branch — dependents may start
 * - `failed`: the pipeline model gave up (or git refused); the person decides
 */
export interface TaskIntegration {
  state: 'queued' | 'integrating' | 'integrated' | 'failed'
  /** Why it failed, or what the step is doing */
  detail?: string
  /** Files in the integration worktree the queue is waiting on */
  waitingFor?: string[]
  /** The `--no-ff` merge commit in the integration branch */
  mergeHash?: string
  /** Fix attempts the pipeline model has spent on this integration */
  attempts?: number
  updatedAt: string
}

export interface PhaseNote {
  phaseId: string
  phaseName: string
  /** 'skipped' = the task started at a later phase (manual start by drag) */
  status: 'ok' | 'error' | 'skipped'
  /** Markdown: what was done, artifacts, decisions */
  content: string
  controlledCommands: string[]
  commitHash?: string
  tokens: number
  cost: number
  startedAt: string
  completedAt: string
  /** Round in which the note was written (absent = 1, before rounds existed) */
  round?: number
}

/**
 * Review from the user who sent a completed task back to the pipeline. Each
 * return opens a new round (the first one opens round 2).
 */
export interface TaskReturn {
  /** Round this return opens */
  round: number
  /** What the user wants fixed — the round's priority instruction */
  text: string
  /** Index of the phase the round restarts from */
  startPhase: number
  createdAt: string
}

/**
 * Instruction the user gave when resuming a paused task. It applies to the
 * phase where the task stopped, in the round it was given — without opening a
 * new round.
 */
export interface ResumeInstruction {
  text: string
  round: number
  phaseId: string
  phaseName: string
  createdAt: string
}

/** Isolated worktree of a task (pipeline with `worktreePerTask`). */
export interface TaskWorktree {
  /** Worktree root (lives in userData/orbit-data/worktrees) */
  path: string
  /**
   * Working folder inside the worktree — it differs from the root when the
   * project's main folder is a subfolder of the repository (monorepo).
   */
  folder: string
  branch: string
  /** Branch (or commit) the worktree came from */
  base: string
  /**
   * How node_modules got there: 'cloned' (copy-on-write — installing is safe),
   * 'linked' (link to the main repository's — installing would change them) or
   * 'none' (the repository has none).
   */
  dependencies: 'cloned' | 'linked' | 'none'
  createdAt: string
  /**
   * The folder is the pipeline's integration worktree, shared (flow `shared`:
   * commits off). Never removed with the task.
   */
  shared?: boolean
}

export interface Task {
  id: string
  /**
   * Short handle (`#123`) the person and the chat tools use to refer to the task.
   * Per pipeline, assigned in order and never reused, even when a task is removed.
   * Absent only on data written before numbering existed (backfilled on load).
   */
  number?: number
  pipelineId: string
  title: string
  description: string
  status: TaskStatus
  /** 0-based index of the running phase; null while pending */
  currentPhase: number | null
  pauseReason?: 'manual' | 'error'
  error?: string
  /**
   * The current phase was aborted halfway (forced pause). When resumed it runs
   * FROM SCRATCH — and is told that the repository may hold partial changes from
   * the interrupted attempt.
   */
  phaseInterrupted?: boolean
  /** Tasks that must complete before this one starts */
  dependsOn: string[]
  notes: PhaseNote[]
  createdAt: string
  startedAt?: string
  completedAt?: string
  /** Sum of the running periods (pauses excluded) */
  workTimeMs: number
  tokens: number
  cost: number
  /**
   * Final commit failed (commitAtEnd on): the git error stays here — the task
   * does not pause, the work is done; commit and push are delivery.
   */
  commitError?: string
  /** Hash of the final commit created by the engine (commitAtEnd on). */
  finalCommitHash?: string
  /** Current round (absent = 1). Goes up on every return. */
  round?: number
  /** Returns in order — the task's review history */
  returns?: TaskReturn[]
  /** Isolated worktree of the task (pipeline with worktreePerTask) */
  worktree?: TaskWorktree
  /** Where the task stands in the merge queue (pipeline flow `merge`). */
  integration?: TaskIntegration
  /** Delivery that carried the task away; set = archived (history, read-only). */
  deliveryId?: string
  archivedAt?: string
  /** Id of the archived task this one follows up ("reopen"). */
  followUpOf?: string
  /** Instructions given when resuming the paused task, in order */
  instructions?: ResumeInstruction[]
  /** Final commits of previous rounds (the current round's is finalCommitHash) */
  previousCommits?: string[]
  /** Origin of the task, when created by the agent from a chat */
  originSessionId?: string
  /**
   * Task started by the AUTOMATIC QUEUE (one at a time): the queue only fires
   * the next one when the current automatic task completes EVERY phase. Tasks
   * without this field were started manually and run in parallel on purpose.
   */
  auto?: boolean
  /**
   * Accumulated diff of the task (filesystem snapshot before the first phase vs
   * current state). It is what the UI shows in the changed-files badge and opens
   * in the panel — the same path as the per-message diff in the chat.
   */
  diff?: {
    /** Tree hash before the first phase */
    start: string
    files: string[]
    patch: string
  }
}

/** Current round of the task (tasks older than rounds count as 1). */
export function taskRound(task: Pick<Task, 'round'>): number {
  return task.round ?? 1
}

/**
 * How a pipeline moves work around, from its two switches:
 * - `merge`: a worktree per task, commit per task, merged into the integration
 * - `shared`: worktrees on, commits off — tasks run one at a time inside the
 *   integration worktree and their changes pile up uncommitted
 * - `simple`: no worktree — tasks run in the project folder (no git needed)
 */
export type PipelineFlow = 'merge' | 'shared' | 'simple'

export function pipelineFlow(pipeline: Pick<Pipeline, 'worktreePerTask' | 'commitAtEnd'>): PipelineFlow {
  if (!pipeline.worktreePerTask) return 'simple'
  return pipeline.commitAtEnd === false ? 'shared' : 'merge'
}

/** The model used outside a phase: the pipeline's own, or the first phase's on older pipelines. */
export function pipelineModel(pipeline: Pick<Pipeline, 'model' | 'phases'>): {
  providerId: string
  modelId: string
  reasoning?: ReasoningConfig | null
} | null {
  if (pipeline.model?.providerId && pipeline.model.modelId) return pipeline.model
  const phase = pipeline.phases[0]
  return phase ? { providerId: phase.providerId, modelId: phase.modelId, reasoning: phase.reasoning } : null
}

/**
 * A dependency is satisfied when the task is completed AND, in a pipeline that
 * merges, its work reached the integration branch — otherwise a dependent task
 * would start without it. Delivered (archived) tasks always count.
 */
export function isTaskSatisfied(task: Pick<Task, 'status' | 'integration' | 'deliveryId'>): boolean {
  if (task.deliveryId) return true
  if (task.status !== 'completed') return false
  return !task.integration || task.integration.state === 'integrated'
}

/** Max attempts the pipeline model gets to resolve a conflict / fix failed checks. */
export const PIPELINE_INTEGRATION_ATTEMPTS = 3

/** Notes written in a round. */
export function notesForRound(task: Pick<Task, 'notes'>, round: number): PhaseNote[] {
  return task.notes.filter((n) => (n.round ?? 1) === round)
}

/** Resume instructions given in a round. */
export function instructionsForRound(task: Pick<Task, 'instructions'>, round: number): ResumeInstruction[] {
  return (task.instructions ?? []).filter((i) => i.round === round)
}

/** Return that opened the round (undefined on round 1). */
export function returnForRound(task: Pick<Task, 'returns'>, round: number): TaskReturn | undefined {
  return task.returns?.find((r) => r.round === round)
}

// ─── Delivery ────────────────────────────────────────────────────────────────

/** One Merge of the integration branch into a destination: the history entry. */
export interface Delivery {
  id: string
  pipelineId: string
  /** 1, 2, 3… per pipeline */
  number: number
  createdAt: string
  /** Branch the work went into (absent on "archive completed" in simple mode) */
  destination?: string
  /** Destination's head after the merge */
  mergeHash?: string
  taskIds: string[]
  taskNumbers: number[]
}

export type MergeOutcome =
  | { status: 'delivered'; delivery: Delivery }
  /** Uncommitted changes in the integration worktree: offer Commit or Cancel */
  | { status: 'dirty'; files: string[] }
  /** Destination checked out somewhere with uncommitted changes in files involved */
  | { status: 'blocked'; files: string[]; where: string }
  | { status: 'failed'; message: string }

// ─── Report ──────────────────────────────────────────────────────────────────

export interface PipelineReport {
  pipelineId: string
  completedTasks: number
  failedTasks: number
  tasksInProgress: number
  pendingTasks: number
  createdCommits: string[]
  totalTokens: number
  totalCost: number
  totalTimeMs: number
  updatedAt: string
}

// ─── Events (main → renderer) ────────────────────────────────────────────────

export type PipelineEvent =
  | { type: 'task'; pipelineId: string; task: Task }
  | { type: 'tasks'; pipelineId: string; tasks: Task[] }
  | { type: 'pipeline'; pipeline: Pipeline }
  | { type: 'projects'; projects: Project[] }
  | { type: 'deliveries'; pipelineId: string; deliveries: Delivery[] }
  /** Text progress of the running phase (live feed on the card) */
  | { type: 'phase-progress'; pipelineId: string; taskId: string; phaseIndex: number; text: string }
  /** Model thinking (reasoning) of the running phase, delta by delta */
  | { type: 'phase-thinking'; pipelineId: string; taskId: string; phaseIndex: number; text: string }
  /** Tool call of the running phase (start and end) */
  | {
      type: 'phase-tool'
      pipelineId: string
      taskId: string
      phaseIndex: number
      toolCallId: string
      tool: string
      state: 'running' | 'completed' | 'error'
      summary: string
      detail?: string
    }

/** Pipeline creation input — used by the UI, the companion app and the chat tools. */
export interface NewPipelineInput {
  projectId: string
  name: string
  /** Phases already resolved (may have been edited only for this pipeline). */
  phases?: PhaseChoice[]
  /** Simple alternative (chat tools): template ids, in the desired order. */
  templateIds?: string[]
  providerId: string
  modelId: string
  thinkingLevel?: number
  /** Default reasoning of the phases (each phase may bring its own) */
  reasoning?: ReasoningConfig | null
  branch?: string
  worktree?: string
  /** Each task in its own git worktree (default true; needs git) */
  worktreePerTask?: boolean
  /** Automatic tasks running at once, 1–4 (needs worktrees and commits) */
  parallelTasks?: number
  /** Engine's final commit when the last phase completes (default true) */
  commitAtEnd?: boolean
  /** Prompt of the final commit message (absent = PIPELINE_COMMIT_PROMPT_DEFAULT) */
  commitPrompt?: string
  operationMode?: 'manual' | 'automatic'
}

/** A task proposed by the planner, before the person approves it. */
export interface PlannedTask {
  title: string
  description: string
  /** Files or folders it will probably touch */
  files: string[]
  /** Indexes (in the same list) of earlier tasks it waits for */
  dependsOn: number[]
}

/** Task creation input — used by the UI and the chat tools. */
export interface NewTaskInput {
  pipelineId: string
  title: string
  description: string
  dependsOn?: string[]
  originSessionId?: string
  /** Archived task this one follows up (reopen) */
  followUpOf?: string
}

/**
 * Attempts per phase before pausing the task with an error. It is an internal
 * Orbit parameter, the same for every pipeline — not configurable per pipeline:
 * whoever is building a pipeline has no way to calibrate this number, and
 * exposing it would only add one more decision without a right answer.
 */
export const PIPELINE_RETRY_DEFAULT = 3

/**
 * Default prompt of the agent that writes the final commit message (D10). It is
 * the value of `Pipeline.commitPrompt` when the user does not customize it.
 * Precedence: what the task asks about the commit; without that, the style of
 * the repository's most recent commit; without history, the commit preferences
 * in memory; without them, Conventional Commits with a header + body of
 * summarized topics. The context (task, phase notes, changed files, last
 * commit) goes in the user message, as in the phases.
 */
export const PIPELINE_COMMIT_PROMPT_DEFAULT = `Write the git commit message for the final state of this pipeline task.

Follow this precedence:
1. What the task asks about the commit (language, format, scope): if the task description or the notes specify it, follow it exactly.
2. Otherwise, the style of the most recent commit in this repository (in the context below): match its language, format and scope.
3. With no commit history, follow the user's commit preferences from memory when they exist.
4. With none, fall back to Conventional Commits: a concise header "type: subject" plus a body with the summarized topics of what changed.

Base the message ONLY on the actual changes in the context below (task description, notes from the phases, changed files) — never invent work that was not done. The header must be short; the body lists the main topics, not a file-by-file log.

Output just the commit message: first line the header, then a blank line, then the body. No markdown fences, no commentary.`
