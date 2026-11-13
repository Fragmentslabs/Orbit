import { stepCountIs, streamText, type ToolSet } from 'ai'
import type { AllowedTool, PhaseConfig, Pipeline, Task } from '@shared/pipeline'
import { instructionsForRound, notesForRound, returnForRound, taskRound } from '@shared/pipeline'
import { getProvider, modelSupportsVision } from '../catalog'
import { blockedMessage, classifyCommand } from './command-policy'
import { extractCommit, extractNote } from './contract'
import { CONTRACT } from './templates'
import { buildPhaseTools } from './tools'
import { phaseSystemPrompt } from './prompt'
import { buildMap, type ToolFamily } from '../tools/catalog'
import { deriveActive } from '../tools/active'
import { queryFamily } from '../tools/load'
import { resolveModel } from '../providers'
import { withProviderSession } from '../provider-session'
import { buildProviderOptions, interleavedReasoningField, normalizeMessages } from '../reasoning'
import type { ToolContext } from '../tools/context'
import { toTokenUsage } from '../usage'
import { loadAgents } from '../agents/store'
import { isUserProfileId, userProfileId, type AgentDefinition } from '@shared/agents'
import { agentPrepareStep } from '../agent-step'
import { readAppLanguage } from '../app-language'
import { toolLimitFor, type SendMessageInput } from '@shared/chat'

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

/**
 * What this phase may use: its own capabilities plus the ones the specialist
 * brings. Memories are the only agent feature that translates into a phase.
 *
 * Subagents are deliberately left out: a phase is judged by ONE note, and a
 * delegate writes work that is not in it — the phase would pay twice and still
 * not be the one accountable. Parallelism here is the pipeline's (a task per
 * branch), not the phase's. Vision and orchestra have nobody to serve.
 */
function phaseCapabilities(phase: PhaseConfig, agent: AgentDefinition | undefined): Set<AllowedTool> {
  const capabilities = new Set<AllowedTool>(phase.tools)
  if (agent?.features.memories) capabilities.add('memory')
  return capabilities
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

/**
 * Synthetic SendMessageInput — the tool builder and the memory tools need to
 * know the session, the mode and which abilities are on. The phase's
 * capabilities are what turns them on here.
 */
function syntheticSendInput(
  ctx: PhaseContext,
  capabilities: ReadonlySet<AllowedTool>,
  /** The specialist, when it is a plain agent — it brings its own tool policy. */
  agent: AgentDefinition | undefined,
): SendMessageInput {
  return {
    sessionId: `pipeline_${ctx.task.id}`,
    text: ctx.task.description,
    providerId: ctx.phase.providerId,
    modelId: ctx.phase.modelId,
    mode: 'code',
    options: {
      permissionMode: 'full',
      ...(capabilities.has('memory') ? { brain: true } : {}),
      ...(capabilities.has('research') ? { research: true } : {}),
      ...(capabilities.has('browser') ? { browser: true } : {}),
      ...(ctx.phase.reasoning?.enabled ? { reasoning: ctx.phase.reasoning } : {}),
    },
    directory: ctx.folders[0],
    extraDirectories: ctx.folders.slice(1),
    // The specialist's policy travels with the phase: its allowlist narrows the toolset and
    // its blocks switch things off — it never grants anything (see profiles/tool-blocks.ts).
    // A craft agent is left out: its tools would REPLACE read/edit/shell, and phase tools are
    // the phase's own decision (the editor does not offer crafts for that reason).
    ...(agent && !agent.craft && ctx.phase.agent ? { profile: ctx.phase.agent } : {}),
  }
}

/**
 * The specialist as the phase sees it: its prompt plus the skills fixed on it — the same
 * composition a profile chat gets (profiles/user.ts), minus the chat-only blocks.
 */
async function specialistFor(agent: AgentDefinition | undefined): Promise<{ name: string; prompt: string } | undefined> {
  if (!agent) return undefined
  const { refreshPinnedSkills, pinnedSkillsBlock } = await import('../agents/pinned-skills')
  const pinned = agent.pinnedSkills ?? []
  await refreshPinnedSkills(pinned)
  const prompt = [agent.prompt, pinnedSkillsBlock(pinned)].filter(Boolean).join('\n\n').trim()
  return prompt ? { name: agent.name, prompt } : undefined
}

/**
 * The specialist running the phase, when the phase names one: the agent brings
 * who does the work — its identity, and its memories when it works with them —
 * while the phase prompt keeps the instructions. "General" is not an agent: the
 * phase runs with the engine's own rules and nothing from the chat.
 */
async function brainBlock(input: SendMessageInput): Promise<string[]> {
  // Imported on demand: prompts.ts drags the chat's whole dependency graph
  // (companion server included), and this module is reachable from tests that
  // run without Electron.
  const { buildBrainBlock } = await import('../prompts')
  return buildBrainBlock(input)
}

async function phaseAgent(phase: PhaseConfig): Promise<AgentDefinition | undefined> {
  if (!phase.agent || !isUserProfileId(phase.agent)) return undefined
  const agents = await loadAgents()
  return agents.find((a) => userProfileId(a.id) === phase.agent)
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
      wt.shared
        ? `Pipeline worktree: ${wt.path}, on branch \`${wt.branch}\`. Work and run commands only inside it — the main checkout belongs to the user.`
        : `Isolated worktree for this task: ${wt.path}, on branch \`${wt.branch}\` (created from \`${wt.base}\`, the pipeline's integration branch). ` +
          `Work, run commands and commit only inside it — the main checkout belongs to the user and to other tasks running in parallel. Do not merge: the pipeline merges your branch when the task is done.`,
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
  if (wt?.shared) {
    repo.push(
      'This worktree is shared by the pipeline\'s tasks, which run one at a time here. Leave your changes uncommitted: the pipeline commits them together when the person merges.',
    )
  }
  parts.push(`\n## Repository\n${repo.join('\n')}`)

  const { blocked, controlled } = ctx.pipeline.commandPolicy
  parts.push(
    `\n## Command policy (unsupervised run)\n` +
      `- Refused: ${blocked.join(', ') || '(none)'}\n` +
      `- Allowed but recorded: ${controlled.join(', ') || '(none)'}\n` +
      `- Anything else: free. A refused command counts as a phase failure — work around it.`,
  )

  // Screenshots of the result are the agent's call: only phases that already
  // have the browser get the paragraph, so the rest pay nothing for it. The
  // limits exist because over-capturing is the biggest token waste of the
  // pipeline: the image enters the context (see:true) and stays in the history
  // for every following turn of the phase.
  if (ctx.phase.tools.includes('browser')) {
    parts.push(
      `\n## Screenshots of the result\n` +
        `If this task changed something visible in a UI, attach the MINIMUM evidence that helps the person judge it (a few images, not a series). If it changed nothing visible, capture nothing and say nothing about it.\n` +
        `- Static screens of known URLs/viewports: capture_batch — one call, the images stay out of your context.\n` +
        `- Timing/state (animations, waiting for a render, resizing): run_browser_script with waitFor/wait/resize — one call too.\n` +
        `- Interacting with the app (click, type, inspect): use the panel browser (panel_navigate / panel_read / panel_click / panel_type). panel_screenshot returns a media URL WITHOUT loading the image into your context; pass see:true only when you must see the capture yourself, at most once or twice per phase.\n` +
        `- If a previous phase already attached screenshots of this change and nothing visible changed since, do NOT recapture.\n` +
        `Attach the screenshots to your note with their orbit-media:// URLs and say what each one shows. Keep it short — the person reads the note, not a photo album.`,
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

  const agent = await phaseAgent(ctx.phase)
  const capabilities = phaseCapabilities(ctx.phase, agent)
  const input = syntheticSendInput(ctx, capabilities, agent)
  const model = await resolveModel(ctx.phase.providerId, ctx.phase.modelId)
  const phaseTools = await buildPhaseTools(input, toolCtx, capabilities)
  // The command policy lives inside bash: it is not a permission rule because
  // there is nobody to approve — a blocked command comes back as an error for
  // the agent itself to work around.
  if (phaseTools.tools.bash) {
    phaseTools.tools.bash = withCommandPolicy(phaseTools.tools.bash, ctx, (cmd) => controlledCommands.push(cmd))
  }
  // The fixed half of the prompt: how the run works, what the tools require,
  // the catalog of families, the specialist's identity. The phase's own text
  // and the note contract close the list.
  const language = await readAppLanguage()
  const system = phaseSystemPrompt({
    language,
    tools: phaseTools.names,
    toolMap: phaseTools.families.length > 0 ? buildMap(phaseTools.families).text : undefined,
    memories: capabilities.has('memory') ? await brainBlock(input) : undefined,
    specialist: await specialistFor(agent),
    instructions: ctx.phase.prompt,
    noteContract: ctx.phase.noteContract,
    contract: CONTRACT,
  })

  // Tool catalog on demand, as in the chat: the core is always sent, and a
  // family is sent once `tools_load` (or a call to one of its tools) makes it
  // active. Without this a phase carried either everything or nothing.
  const cap = toolLimitFor(ctx.phase.providerId)
  const resolveQuery = (family: ToolFamily, query: string) => queryFamily(phaseTools.tools, family, query)
  const deriveTurn = (messages: readonly unknown[]) =>
    deriveActive(messages, phaseTools.families, phaseTools.names, { cap, resolveQuery })
  const initialActive = deriveTurn([])
  const step = agentPrepareStep(provider, ctx.phase.modelId, { directory: toolCtx.directory })

  let text = ''
  try {
    const stream = streamText({
      model,
      system,
      messages: normalizeMessages(
        [{ role: 'user', content: buildMessage(ctx) }],
        interleavedReasoningField(provider, ctx.phase.modelId),
      ),
      tools: phaseTools.tools,
      activeTools: initialActive.names,
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: ctx.abort,
      providerOptions: await buildProviderOptions(input),
      prepareStep: ({ stepNumber, messages }) => {
        const prepared = step({ messages }) as { messages?: typeof messages }
        const next = prepared.messages ?? messages
        // Last step: no tool call may open work that nobody will close.
        if (stepNumber >= MAX_STEPS - 1) return { ...prepared, activeTools: [] }
        return { ...prepared, activeTools: deriveTurn(next).names }
      },
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
