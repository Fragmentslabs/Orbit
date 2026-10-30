import { stepCountIs, streamText, type ToolSet } from 'ai'
import type { PhaseConfig, Pipeline, Task } from '@shared/pipeline'
import { instructionsForRound, notesForRound, returnForRound, taskRound } from '@shared/pipeline'
import { getProvider, modelSupportsVision } from '../catalog'
import { blockedMessage, classifyCommand } from './command-policy'
import { extractCommit, extractNote } from './contract'
import { resolveModel } from '../providers'
import { withProviderSession } from '../provider-session'
import { buildProviderOptions, interleavedReasoningField, normalizeMessages } from '../reasoning'
import { createBashTool } from '../tools/shell'
import type { ToolContext } from '../tools/context'
import {
  createEditTool,
  createGlobTool,
  createGrepTool,
  createListTool,
  createReadTool,
  createWriteTool,
} from '../tools/files'
import { createCodeTools } from '../tools/code'
import { createPanelBrowserTools } from '../tools/panel-browser'
import { createBrowserScriptTools } from '../tools/browser-script'
import { createChatMemoryTools } from '../tools/memory'
import { createVerifyChangesTool } from '../tools/verify-changes'
import { toTokenUsage } from '../usage'
import { agentPrepareStep } from '../agent-step'
import type { SendMessageInput } from '@shared/chat'

/**
 * Execution of ONE pipeline phase, without a chat session (D12).
 *
 * runChat cannot be reused: it is anchored to a session (persists messages,
 * emits chat:event, applies chat compaction and nudges). Here the cycle is a
 * different one — build the context → run the agent → collect the note →
 * advance — and the task's "history" is the phase notes, not a conversation.
 *
 * Full autonomy (D5): no tool approval is ever requested. The guardrail is the
 * phase's tool set + the command policy, applied inside bash.
 */

const MAX_STEPS = 60

/**
 * Precedence preamble injected BEFORE the phase prompt. It is what guarantees
 * that instructions in the task description (how to commit, whether to commit,
 * how to validate) beat what the phase prompt says by default — because the
 * phase prompt lives in `system`, which many models treat as stronger than the
 * user message. Without it, a "do not create a commit" in the description could
 * be run over by a "commit locally" from the template.
 *
 * What is NOT negotiable is the scope: the phase still does only its own job
 * (validation does not implement, dev does not push), whatever the description
 * asks. Description precedence applies to HOW to do the phase's own work, not
 * to WHAT each phase's work is.
 */
const PRECEDENCE = `The task description in the user message is your PRIMARY brief and takes precedence over this phase prompt. Where the two conflict — including how to commit, whether to create a commit at all, or how to validate — follow the task description, not this prompt. This precedence does NOT change your scope: you still do only your phase's job as defined here, and never push (the engine pushes).`

export interface PhaseContext {
  pipeline: Pipeline
  task: Task
  phase: PhaseConfig
  phaseIndex: number
  /** Working folders of the project (the first one is the main one) */
  folders: string[]
  /** Current attempt (1-based) — >1 injects the previous failure notice */
  attempt: number
  previousError?: string
  /** The previous run of this phase was aborted halfway (forced pause) */
  interruptedBefore?: boolean
  abort: AbortSignal
  /** Live feed of the agent text (the UI shows it on the card) */
  onText?: (delta: string) => void
  /** Live feed of the model's thinking (reasoning), delta by delta */
  onThinking?: (delta: string) => void
  /** Live feed of tool calls (start and completion) */
  onTool?: (progress: ToolProgress) => void
}

export interface ToolProgress {
  toolCallId: string
  tool: string
  state: 'running' | 'completed' | 'error'
  summary: string
  detail?: string
}

export interface PhaseResult {
  /** Note in markdown extracted from the response — absent = the phase failed */
  note?: string
  /** Full response text (fallback and diagnostics) */
  text: string
  controlledCommands: string[]
  commitHash?: string
  tokens: number
  cost: number
  error?: string
}

/** Maps the phase capabilities to the engine's real tools. */
function buildTools(ctx: PhaseContext, toolCtx: ToolContext, recordCommand: (cmd: string) => void): ToolSet {
  const tools: ToolSet = {}
  const allowed = new Set(ctx.phase.tools)

  // Reading is always unlocked: without reading the repository no phase can do
  // anything useful, not even report what it found.
  tools.read = createReadTool(toolCtx)
  tools.ls = createListTool(toolCtx)
  tools.glob = createGlobTool(toolCtx)
  tools.grep = createGrepTool(toolCtx)
  Object.assign(tools, createCodeTools(toolCtx))
  tools.verify_changes = createVerifyChangesTool(toolCtx)

  if (allowed.has('edit')) {
    tools.write = createWriteTool(toolCtx)
    tools.edit = createEditTool(toolCtx)
  }
  if (allowed.has('shell')) {
    tools.bash = withCommandPolicy(createBashTool(toolCtx), ctx, recordCommand)
  }
  // With screenshots enabled, the phase gets the browser even without asking for
  // it: the instruction to capture would be impossible to follow without the tools.
  if (allowed.has('browser') || ctx.pipeline.resultScreenshots) {
    // The panel browser is per session; the pipeline uses the task's synthetic
    // id, so each task has its own and does not dispute an open chat's panel.
    Object.assign(tools, createPanelBrowserTools(toolCtx))
    Object.assign(tools, createBrowserScriptTools(toolCtx))
  }
  if (allowed.has('memory')) {
    Object.assign(tools, createChatMemoryTools(syntheticSendInput(ctx)))
  }
  return tools
}

/**
 * Wraps bash with the three-layer policy. The check lives HERE, not in a
 * permission rule, because in the pipeline there is no user to approve: a
 * blocked command has to come back as an error for the agent itself to work
 * around.
 */
function withCommandPolicy(
  bashTool: ToolSet[string],
  ctx: PhaseContext,
  recordCommand: (cmd: string) => void,
): ToolSet[string] {
  const original = bashTool as { execute?: (args: unknown, opts: unknown) => Promise<unknown> }
  return {
    ...bashTool,
    execute: async (args: unknown, opts: unknown) => {
      const command = String((args as { command?: unknown })?.command ?? '')
      const { layer, reason } = classifyCommand(command, ctx.pipeline.commandPolicy)
      if (layer === 'blocked') return blockedMessage(command, reason)
      if (layer === 'controlled') recordCommand(command)
      return original.execute?.(args, opts)
    },
  } as ToolSet[string]
}

/** Synthetic SendMessageInput — the memory tools require it to know the session/mode. */
function syntheticSendInput(ctx: PhaseContext): SendMessageInput {
  return {
    sessionId: `pipeline_${ctx.task.id}`,
    text: ctx.task.description,
    providerId: ctx.phase.providerId,
    modelId: ctx.phase.modelId,
    mode: 'code',
    options: {
      permissionMode: 'full',
      brain: true,
      ...(ctx.phase.reasoning?.enabled ? { reasoning: ctx.phase.reasoning } : {}),
    },
    directory: ctx.folders[0],
    extraDirectories: ctx.folders.slice(1),
  }
}

/**
 * Index of the phase responsible for validating. Validation is exclusive to the
 * validation phase when it exists; without it, the responsibility falls to the
 * development phase (or, lacking that one, to the last phase — the "next" after
 * what the user described, last chance before closing).
 */
function validationPhaseIndex(phases: PhaseConfig[]): number {
  const idx = phases.findIndex((p) => (p.kind ?? 'generic') === 'validation')
  if (idx >= 0) return idx
  const dev = phases.findIndex((p) => (p.kind ?? 'generic') === 'development')
  if (dev >= 0) return dev
  return phases.length - 1
}

/**
 * Phase input context (§7): task description, previous notes and repo state. It
 * is what replaces the conversation history.
 *
 * The task description is the common BASE for every phase. What changes is the
 * scope: each phase receives the full pipeline list so it knows what is its own
 * and what it must leave for the next one.
 */
export function buildMessage(ctx: PhaseContext): string {
  const parts: string[] = []
  parts.push(`# Task: ${ctx.task.title}`)
  if (ctx.task.description.trim()) parts.push(ctx.task.description.trim())

  // Review round: the user's comment comes right after the brief, with priority
  // over it — it is the reason the task is running again.
  const round = taskRound(ctx.task)
  const taskReturn = returnForRound(ctx.task, round)
  if (taskReturn) {
    const earlierReturns = (ctx.task.returns ?? []).filter((r) => r.round < round)
    parts.push(
      `\n## Review feedback (round ${round})\n` +
        `The user reviewed the previous round and sent the task back with the feedback below. ` +
        `It takes priority over the original description wherever they conflict. ` +
        `The repository already contains the previous round's work: fix and adjust it — do not redo the task from scratch.\n\n` +
        taskReturn.text,
    )
    if (earlierReturns.length > 0) {
      parts.push(
        `Earlier review feedback (already addressed in previous rounds):\n` +
          earlierReturns
            .map((r) => `- Round ${r.round}: ${r.text.replace(/\s+/g, ' ').slice(0, 300)}`)
            .join('\n'),
      )
    }
  }

  // Instructions given when resuming: this phase's own are a priority (they are
  // the reason the phase runs again); the ones for other phases of the round
  // come in as context — they are usually project facts (test command, variable).
  const instructions = instructionsForRound(ctx.task, round)
  const forThisPhase = instructions.filter((i) => i.phaseId === ctx.phase.id)
  const forOthers = instructions.filter((i) => i.phaseId !== ctx.phase.id)
  if (forThisPhase.length > 0) {
    parts.push(
      `\n## Instructions from the user for this phase\n` +
        `This phase was paused and the user resumed it with the instructions below. Follow them — they take priority over the phase's default behavior and over the task description where they conflict.\n\n` +
        forThisPhase.map((i) => `- ${i.text}`).join('\n'),
    )
  }
  if (forOthers.length > 0) {
    parts.push(
      `\n## Instructions the user gave to other phases (context)\n` +
        forOthers.map((i) => `- ${i.phaseName}: ${i.text.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n'),
    )
  }

  const phases = ctx.pipeline.phases
  const index = ctx.phaseIndex
  const phaseList = phases
    .map((p, i) => {
      const marker = i === index ? ' ← YOU ARE HERE' : i < index ? ' (done)' : ''
      return `${i + 1}. ${p.name} — ${p.description}${marker}`
    })
    .join('\n')

  parts.push(
    `\n## Pipeline\n` +
      `This task runs through ${phases.length} phases in a fixed order, without going back${round > 1 ? ` (this is review round ${round})` : ''}. You are phase ${index + 1}: **${ctx.phase.name}**.\n\n` +
      `${phaseList}\n\n` +
      `Each phase does only its own job. Do NOT do the work of a later phase — leave it to them.\n\n` +
      `The task description above is your PRIMARY brief. Its instructions OVERRIDE this phase's default behavior wherever they conflict — including how to commit, whether to commit, how to validate, etc. ` +
      `Follow the parts that belong to your phase and ignore instructions meant for other phases in the Pipeline. ` +
      `The notes from previous phases (below) are context for what already happened, not new instructions.`,
  )

  // Validation fallback: without a validation phase, whoever validates is the
  // phase pointed at by validationPhaseIndex — but the notice is only injected
  // when it is not a validation phase (a validation phase already carries that
  // in its own prompt).
  const validator = validationPhaseIndex(phases)
  if (validator === index && (ctx.phase.kind ?? 'generic') !== 'validation') {
    parts.push(
      `\n## No dedicated validation phase\n` +
        `This pipeline has no validation phase, so validating is also your responsibility before you finish: run the applicable checks (build/typecheck/lint/tests), review the diff, and fix small problems. Record the result in your note.`,
    )
  }

  // Only this round's notes come in full; from the previous round goes the
  // summary of its last phase. Resending the whole history every round costs
  // more and mixes what was already fixed with what matters now.
  const roundNotes = notesForRound(ctx.task, round)
  if (round > 1) {
    const previousSummary = notesForRound(ctx.task, round - 1)
      .filter((n) => n.status !== 'skipped')
      .at(-1)
    if (previousSummary) {
      parts.push(
        `\n## Previous round summary (round ${round - 1}, ${previousSummary.phaseName})\n${previousSummary.content.slice(0, 3000)}`,
      )
    }
  }
  const earlier = roundNotes.filter((n) => n.status !== 'skipped')
  if (earlier.length > 0) {
    parts.push(round > 1 ? `\n## Notes from previous phases (this round)` : '\n## Notes from previous phases')
    for (const n of earlier) {
      parts.push(`### ${n.phaseName} (${n.status})\n${n.content}`)
    }
  }
  const skipped = roundNotes.filter((n) => n.status === 'skipped')
  if (skipped.length > 0) {
    parts.push(
      `\n## Skipped phases\n${skipped.map((n) => `- ${n.phaseName}`).join('\n')}\nThe task was started directly at a later phase — do not assume that work was done.`,
    )
  }

  const repo: string[] = [`Working folders: ${ctx.folders.join(', ') || '(none)'}`]
  const wt = ctx.task.worktree
  if (wt) {
    // Isolated worktree: the agent must know the folder is its own, that the main
    // repository is not, and what it may do with the dependencies.
    repo.push(
      `Isolated worktree for this task: ${wt.path}, on branch \`${wt.branch}\` (created from \`${wt.base}\`). ` +
        `Work, run commands and commit only inside it — the main checkout belongs to the user and to other tasks running in parallel.`,
    )
    repo.push(
      wt.dependencies === 'cloned'
        ? 'Dependencies (node_modules) were cloned from the main checkout; if you change dependency manifests, run the install here.'
        : wt.dependencies === 'linked'
          ? 'Dependencies (node_modules) are LINKED to the main checkout: do not run install commands — they would change the main checkout. If dependencies must change, say so in your note.'
          : 'The repository has no node_modules; install dependencies here if a command needs them.',
    )
    repo.push('If a dev server port is busy (another task may be running one), use another port.')
  } else if (ctx.pipeline.branch) {
    repo.push(`Branch: ${ctx.pipeline.branch}`)
  }
  if (ctx.pipeline.worktree) repo.push(`Worktree: ${ctx.pipeline.worktree}`)
  repo.push(
    `Push at the end: ${ctx.pipeline.pushAtEnd ? 'yes — the engine runs git push when the last phase succeeds, do not push yourself' : 'no (local commits only)'}`,
  )
  parts.push(`\n## Repository\n${repo.join('\n')}`)

  const { blocked, controlled } = ctx.pipeline.commandPolicy
  parts.push(
    `\n## Command policy (unsupervised run)\n` +
      `- Refused: ${blocked.join(', ') || '(none)'}\n` +
      `- Allowed but recorded: ${controlled.join(', ') || '(none)'}\n` +
      `- Anything else: free. A refused command counts as a phase failure — work around it.`,
  )

  // Screenshots of the result: an explicit instruction, otherwise the agent
  // describes the visual change in text and the user never sees what came out on
  // screen. The limits exist because over-capturing is the biggest token waste
  // of the pipeline: the image enters the context (see:true) and stays in the
  // history for every following turn of the phase.
  if (ctx.pipeline.resultScreenshots) {
    parts.push(
      `\n## Screenshots of the result (enabled for this pipeline)\n` +
        `If this task changed anything visible in a UI, capture the MINIMUM evidence needed (a few images, not a series):\n` +
        `- Static screens of known URLs/viewports: capture_batch — one call, the images stay out of your context.\n` +
        `- Timing/state (animations, waiting for a render, resizing): run_browser_script with waitFor/wait/resize — one call too.\n` +
        `- Interacting with the app (click, type, inspect): use the panel browser (panel_navigate / panel_read / panel_click / panel_type). panel_screenshot returns a media URL WITHOUT loading the image into your context; pass see:true only when you must see the capture yourself, at most once or twice per phase.\n` +
        `- If a previous phase already attached screenshots of this change and nothing visible changed since, do NOT recapture — say so in your note.\n` +
        `Attach the screenshots to your note with their orbit-media:// URLs and say what each one shows. Keep it short — the user reads the note, not a photo album.\n` +
        `If the change is not visible in a UI, say so in the note instead of capturing something unrelated.`,
    )
  }

  // Resume after a forced pause: the phase starts over from scratch, but the
  // repository may have been left halfway — hiding that would make the agent
  // reimplement on top of what already exists.
  if (ctx.interruptedBefore) {
    parts.push(
      `\n## Restarting this phase\nA previous run of THIS phase was interrupted before finishing. You are starting it over from the beginning.\n` +
        `The working tree may already contain partial changes from that attempt: check the current state of the files before writing anything, and continue from reality instead of assuming a clean start.`,
    )
  }

  if (ctx.attempt > 1) {
    parts.push(
      `\n## Retry ${ctx.attempt} of this phase\nThe previous attempt failed:\n${ctx.previousError ?? '(no detail)'}\nFix the cause instead of repeating the same steps.`,
    )
  }
  return parts.join('\n')
}

/** Short summary of a tool input for the modal's live feed. */
function summarizeTool(tool: string, input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>
  const short = (v: unknown): string => {
    const s = typeof v === 'string' ? v : JSON.stringify(v)
    if (!s) return ''
    return s.length > 80 ? `${s.slice(0, 77)}…` : s
  }
  switch (tool) {
    case 'bash':
      return `$ ${short(args.command)}`
    case 'read':
    case 'write':
    case 'edit':
      return short(args.filePath)
    case 'glob':
    case 'grep':
      return short(args.pattern)
    case 'code_search':
      return short(args.query)
    case 'code_outline':
      return short(args.filePath ?? args.path ?? 'project map')
    case 'code_refs':
      return short(args.symbol)
    case 'ls':
      return short(args.dirPath)
    case 'panel_navigate':
      return short(args.url)
    case 'panel_click':
      return args.ref != null ? `ref ${args.ref}` : short(args.selector)
    case 'panel_type':
      return args.ref != null ? `ref ${args.ref}: ${short(args.text)}` : short(args.selector)
    case 'panel_resize':
      return short(args.preset ?? (args.width ? `${args.width}×${args.height}` : 'fit'))
    case 'panel_eval':
      return short(args.code)
    case 'panel_console':
      return short(args.level ?? 'all')
    case 'panel_screenshot':
      if (args.fullPage === true) return 'whole page'
      if (typeof args.savePath === 'string') return short(args.savePath)
      return args.see === true ? 'see: true' : ''
    case 'capture_batch': {
      const steps = Array.isArray(args.steps) ? args.steps.length : 0
      return `${steps} capture(s)`
    }
    case 'run_browser_script':
      return short(args.taskId)
    case 'commit':
      return short(args.message)
    default:
      return short(args)
  }
}

export async function runPhase(ctx: PhaseContext): Promise<PhaseResult> {
  return withProviderSession(`pipeline_${ctx.task.id}`, () => runPhaseInner(ctx))
}

async function runPhaseInner(ctx: PhaseContext): Promise<PhaseResult> {
  const controlledCommands: string[] = []
  const provider = await getProvider(ctx.phase.providerId)
  const toolCtx: ToolContext = {
    sessionId: `pipeline_${ctx.task.id}`,
    directory: ctx.pipeline.worktree || ctx.folders[0] || '',
    extraDirectories: ctx.folders.slice(1),
    abort: ctx.abort,
    // Vision of the phase model: controls whether panel_screenshot offers `see`
    modelVision: modelSupportsVision(provider, ctx.phase.modelId),
  }
  if (!toolCtx.directory) {
    return { text: '', controlledCommands, tokens: 0, cost: 0, error: 'Project with no work folder defined.' }
  }

  const input = syntheticSendInput(ctx)
  const model = await resolveModel(ctx.phase.providerId, ctx.phase.modelId)
  const tools = buildTools(ctx, toolCtx, (cmd) => controlledCommands.push(cmd))

  let text = ''
  try {
    const stream = streamText({
      model,
      system: `${PRECEDENCE}\n\n${ctx.phase.prompt}`,
      messages: normalizeMessages(
        [{ role: 'user', content: buildMessage(ctx) }],
        interleavedReasoningField(provider, ctx.phase.modelId),
      ),
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: ctx.abort,
      providerOptions: await buildProviderOptions(input),
      prepareStep: agentPrepareStep(provider, ctx.phase.modelId, { directory: toolCtx.directory }),
      onError: () => {
        /* handled below, by the accumulated text/error */
      },
    })

    for await (const part of stream.fullStream) {
      if (part.type === 'text-delta') {
        text += part.text
        ctx.onText?.(part.text)
      } else if (part.type === 'reasoning-delta') {
        ctx.onThinking?.(part.text)
      } else if (part.type === 'tool-call') {
        ctx.onTool?.({
          toolCallId: part.toolCallId,
          tool: part.toolName,
          state: 'running',
          summary: summarizeTool(part.toolName, part.input),
        })
      } else if (part.type === 'tool-result') {
        const failed = (part as { isError?: boolean }).isError === true
        ctx.onTool?.({
          toolCallId: part.toolCallId,
          tool: part.toolName,
          state: failed ? 'error' : 'completed',
          summary: summarizeTool(part.toolName, (part as { args?: unknown }).args),
          detail: failed
            ? typeof part.output === 'string'
              ? part.output
              : JSON.stringify(part.output, null, 2)
            : undefined,
        })
      } else if (part.type === 'error') {
        const detail = part.error instanceof Error ? part.error.message : String(part.error)
        return { text, controlledCommands, tokens: 0, cost: 0, error: detail }
      }
    }

    const usage = toTokenUsage(await stream.usage, provider?.models[ctx.phase.modelId]?.cost)
    const tokens = usage.input + usage.output + usage.reasoning
    const note = extractNote(text)
    return {
      note,
      text,
      controlledCommands,
      commitHash: note ? extractCommit(note) : undefined,
      tokens,
      cost: usage.cost ?? 0,
      // A missing note is a contract failure: the next phase would receive noise
      // instead of the report, so a retry is worth it (§7).
      error: note ? undefined : 'The phase ended without the mandatory annotation (```note block).',
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { text, controlledCommands, tokens: 0, cost: 0, error: detail }
  }
}
