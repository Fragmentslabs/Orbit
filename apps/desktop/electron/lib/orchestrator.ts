import { existsSync } from 'node:fs'
import { stepCountIs, streamText, type ModelMessage, type ToolSet } from 'ai'
import type { BrowserWindow } from 'electron'
import type {
  ChatEvent,
  ChatMessage,
  MessagePart,
  OrchestrationPlan,
  OrchestrationTask,
  SendMessageInput,
  SessionInfo,
  TextPart,
  ToolPart,
} from '@shared/chat'
import { StorageKeys, normalizeOrchestrationPlan, normalizeOrchestrationSettings } from '@shared/chat'
import { getProvider } from './catalog'
import { abortChat, runChat, toModelMessages } from './chat-engine'
import { forwardChatEvent } from './companion-server'
import { classifyProviderError, errorToText, isRecoverableErrorKind } from './errors'
import { hasStreamedContent, resolveRotation } from './model-rotation'
import { conductorInput } from './orchestrator-conductor'
import { registerOrchestrator } from './orchestration/questions'
import { workerAgentsForPlan } from './agents/suggestions'
import { ORCHESTRATOR_PLAN_PROMPT, ORCHESTRATOR_SYNTHESIS_PROMPT } from './prompts'
import { resolveModel } from './providers'
import { withProviderSession } from './provider-session'
import { coveredBy, currentTurnWrites, runWithWriteScope } from './session/write-journal'
import { buildProviderOptions, interleavedReasoningField, normalizeMessages } from './reasoning'
import { agentPrepareStep } from './agent-step'
import { listKeys, readJson, writeJson } from './storage'
import { SUBAGENT_MAX_STEPS, createRemoveTaskTool, createSubagentTool, createTaskTool } from './tools/orchestration'
import type { TaskModeCeiling } from './tools/orchestration'
import {
  createEditTool,
  createGlobTool,
  createGrepTool,
  createListTool,
  createReadTool,
  createWriteTool,
} from './tools/files'
import { createCodeTools } from './tools/code'
import { createToolApproval, takeDenialReason } from './permission'
import { globalMode } from './permission/global-mode'
import { createQuestionTool } from './tools/question'
import { buildWorkersNotice, createWorkerTools, loadWorkers } from './tools/workers'
import type { ToolContext } from './tools/context'
import { addTokenUsage, toTokenUsage } from './usage'
import { getWorkerConfigCache } from './companion-http'
import { folderDiff, turnDiffs } from './orchestration/diff'
import { budgetExhausted } from './orchestration/budget'
import { planFromTeam } from './orchestration/team-plan'
import type { RoutineTeam } from '@shared/routines'
import { MAX_PARALLEL, executePlan } from './orchestration/execution'
import { reviewWithModel } from './orchestration/reviewer'
import { discoverChecks, runCheck } from './orchestration/checks'
import {
  commitWork,
  createWorkerWorktree,
  chatRepository,
  mergeBranches,
  removeWorkerWorktree,
  worktreeDiff,
  worktreeFiles,
} from './orchestration/worktrees'
import { repositoryRoot } from './worktrees/core'
import { capture, diff } from './snapshot'
import { manualSavesUnder, stripFilesFromPatch } from './manual-saves'
import { perfEvent, perfSpan } from './perf'
import { tNow } from './i18n'

/**
 * OrchestratorEngine (Orchestra mode), in four phases:
 * 1. Triage + planning: the orchestrator decides whether the request is a
 *    conversation (answers directly), an ambiguity (uses the question tool) or
 *    work — and only then splits it with create_task. The plan is proposed to
 *    the user (semi-auto).
 * 2. Execution: each approved task becomes a real child session (persisted,
 *    shows up in the sidebar/panel), always in code mode, with the modes the
 *    orchestrator chose for it within the user's session ceiling.
 * 3. Follow-up (orchestration/execution.ts): each worker that finishes is
 *    reviewed by the orchestrator while the others keep going; it accepts, asks
 *    for an adjustment, marks a failure or creates an extra worker, within the
 *    "adjustments per worker" budget from the Orchestra settings. Dependencies
 *    between tasks and, optionally, one worktree per worker (merged at the end).
 * 4. Synthesis: the orchestrator consolidates the results into the final answer.
 */

const MAX_TASKS = 8
// Step ceiling for planning. It has to fit research (subagent) +
// registering several tasks (create_task) + the final summary. Too low
// (it used to be 4) made the research eat the whole budget and the plan be born empty.
const PLAN_MAX_STEPS = 16
// Planning research is light: it grounds the split, it does not solve the task.
const PLAN_SUBAGENT_MAX_STEPS = 5
// HARD ceiling on subagent calls during planning (the prompt already asks for
// "2-3 calls", but that is only a suggestion — without a real limit in code the
// model can ignore it, as it did: 17 calls to assemble one plan).
const PLAN_SUBAGENT_MAX_CALLS = 3
/**
 * A small change the orchestrator hands to a subagent instead of assembling a
 * plan (Subagents mode on). Step budget of a regular subagent — this is
 * execution, not research — and few calls: more than that is already a plan.
 */
const PLAN_DELEGATE_MAX_CALLS = 2
const PLAN_DELEGATE_DESCRIPTION =
  'Hands a SMALL, self-contained change (a style tweak, a rename, a one-file fix) to a subagent that does it in the working folder and returns a summary. '
  + 'Use it instead of create_task when the whole request is one small change. Set code: true. '
  + 'The subagent does not see this conversation: name the files and say exactly what to change.'
/**
 * Did it promise a plan and register no task? Only then is the nudge worth it.
 * Portuguese and English because the answer follows the user's language.
 */
const PROMISED_PLAN_RE =
  /\b(create_task|vou (dividir|criar|planejar)|dividir em (tarefas|workers)|criar (as )?tarefas|I(’|')?ll (split|create|plan)|going to (split|create)|split .{0,20}into (tasks|workers))\b/i
/** Retry answer that says "the first answer was already right". */
const NO_PLAN_SENTINEL = '<<NO_PLAN>>'
/**
 * HARD ceiling on direct reads (read/ls/glob/grep/subagent) in a planning pass.
 * The prompt tells the orchestrator to read the project on its own; without a
 * ceiling, scouting a large repo consumes the whole budget, the pass ends on a
 * read tool call — no text, no create_task — and the user saw only the tool
 * cards: the orchestrator "stopped halfway, without answering".
 */
const PLAN_READ_MAX_CALLS = 8
/** Returned in place of the result when the reading budget ran out. */
const PLAN_READ_BUDGET_NOTICE =
  'Planning read budget exhausted. Stop researching: register the tasks you already have with create_task, or answer in plain text saying what you still need.'
/**
 * Last step of the planning pass: tools off and a TEXT answer
 * forced. It is the same guard as the chat-engine (the same idea as
 * opencode's max-steps.ts): instead of cutting the stream in the middle of a
 * tool call, the model is made to say what it has. Without it the pass ended on
 * a tool call, with empty text, and the turn ended without any bubble.
 */
const PLAN_MAX_STEPS_PROMPT = `MAXIMUM STEPS REACHED while planning. Tools are now disabled — respond with text ONLY.

Your response must:
- State that the planning step limit was reached
- Summarize what you learned about the project so far
- Say plainly whether the request needs to be split, and that you did NOT register the tasks if that is the case
- Suggest what to do next (the user can say "continue" to resume)`
/** Last net: no assistant bubble ends without text (translated at the use site). */

interface PendingOrchestration {
  input: SendMessageInput
  plan: OrchestrationPlan
  assistantMessageId: string
}

// Plans waiting for approval/execution — in memory: if the app restarts between
// the proposal and the approval, the plan stays in storage but is no longer executable.
const pending = new Map<string, PendingOrchestration>()
const controllers = new Map<string, AbortController>()
// Running workers per orchestrator — to propagate the parent's abort
const activeWorkers = new Map<string, string[]>()

/** Worker title comparison: "Login Screen " and "login screen" are the same name in the sidebar. */
function normalizeTitle(title: string) {
  return title.trim().replace(/\s+/g, ' ').toLowerCase()
}

function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/** Same funnel as the chat-engine: window + companions. Without the forward,
 *  the whole orchestration flow (planning stream, plan card, task progress,
 *  status) existed only on the desktop — on the phone the approval card only
 *  appeared if the conversation was reopened, and never updated live. */
function emit(win: BrowserWindow, event: ChatEvent) {
  if (!win.isDestroyed()) win.webContents.send('chat:event', event)
  forwardChatEvent(event)
}

/** Inserts or updates a part in the message and emits the 'part' event — used
 * to render the planning stream (text, reasoning, tool calls) in the
 * orchestrator's message. */
function upsertPart(win: BrowserWindow, sessionId: string, message: ChatMessage, part: MessagePart) {
  const idx = message.parts.findIndex((p) => p.id === part.id)
  if (idx >= 0) message.parts[idx] = part
  else message.parts.push(part)
  emit(win, { type: 'part', sessionId, messageId: message.id, part })
}

async function loadMessages(sessionId: string): Promise<ChatMessage[]> {
  return (await readJson<ChatMessage[]>(StorageKeys.messages(sessionId))) ?? []
}

async function saveMessages(sessionId: string, messages: ChatMessage[]) {
  await writeJson(StorageKeys.messages(sessionId), messages)
}

/**
 * Snapshot of the planning turn — the same record as a regular chat-engine turn.
 * Now that the orchestrator makes a small change on its own (edit/write or
 * delegate_change), without this what it changed did not show in the Diff tab
 * nor could be reverted from the message.
 */
/** Start of each turn with an open snapshot — manual saves count from here. */
const snapshotStartedAt = new WeakMap<ChatMessage, number>()

async function openSnapshot(directory: string, message: ChatMessage) {
  snapshotStartedAt.set(message, Date.now())
  try {
    message.snapshot = { start: await capture(directory) }
  } catch (err) {
    message.snapshot = { failed: true, captureError: errorToText(err) }
  }
}

async function closeSnapshot(directory: string, message: ChatMessage) {
  const snapshot = message.snapshot
  if (!snapshot) return
  if (!snapshot.start) {
    snapshot.verified = 'unknown'
    return
  }
  // Manual saves from the panel are not the orchestrator's: revert preserves them.
  const since = snapshotStartedAt.get(message) ?? 0
  snapshot.manual = [...manualSavesUnder(directory, since)]
  // Authorship for the revert: what the turn's tools (and those of the workers
  // it awaited) wrote, and what the ones from other conversations wrote meanwhile.
  const writes = currentTurnWrites(directory)
  if (writes) {
    snapshot.authored = writes.authored
    snapshot.others = writes.others
  }
  try {
    const end = await capture(directory)
    if (end === snapshot.start) {
      snapshot.verified = 'unchanged'
      return
    }
    const changes = await diff(directory, snapshot.start, end)
    // What the person saved by hand during the turn, and what another
    // conversation wrote to the folder in the same window, is not the orchestrator's work.
    const notAgent = manualSavesUnder(directory, since)
    for (const file of changes.files) if (coveredBy(file, writes?.others ?? [])) notAgent.add(file)
    const files = notAgent.size > 0 ? changes.files.filter((f) => !notAgent.has(f)) : changes.files
    if (files.length === 0) {
      snapshot.verified = 'unchanged'
      // The folder changed only by a manual save: keep the final tree for the
      // isolate the orchestrator's paths from the person's.
      snapshot.end = end
      return
    }
    snapshot.verified = 'changed'
    snapshot.end = end
    snapshot.files = files
    snapshot.patch = notAgent.size > 0 ? stripFilesFromPatch(changes.patch, notAgent) : changes.patch
  } catch (err) {
    console.error('[snapshot] final orchestrator capture failed:', err)
    snapshot.verified = 'unknown'
  }
}

async function persistPlan(win: BrowserWindow, sessionId: string, plan: OrchestrationPlan) {
  await writeJson(StorageKeys.orchestration(sessionId), plan)
  emit(win, { type: 'orchestration:plan', sessionId, plan })
}

/**
 * A turn in a worker that already exists: the message enters its chat (which
 * remembers what it did and what the user said there) with the same modes it
 * received from the plan. Used by the review and by the message_worker tool.
 */
async function runWorkerTurn(
  win: BrowserWindow,
  input: SendMessageInput,
  worker: SessionInfo,
  text: string,
): Promise<{ text: string; error?: string; tokens?: ChatMessage['tokens'] }> {
  const orchestratorId = input.sessionId
  const workers = activeWorkers.get(orchestratorId) ?? []
  activeWorkers.set(orchestratorId, [...workers, worker.id])
  // One span per worker turn: it is the unit the wall clock is lost in (a worker
  // runs a whole task — 200+ tool calls — inside a single turn).
  const perf = perfSpan('worker', { sessionId: worker.id, title: worker.title, directory: worker.directory ?? input.directory })
  try {
    await runChat(win, {
      sessionId: worker.id,
      text,
      providerId: input.workerModel?.providerId ?? input.providerId,
      modelId: input.workerModel?.modelId ?? input.modelId,
      mode: 'code',
      options: {
        ...worker.orchestration?.options,
        reasoning: input.workerModel?.reasoning,
        // A worker never orchestrates — that would be recursion.
        orchestrate: undefined,
        // Gatekeeping: the worker inherits the orchestrator's permission mode (and,
        // if it follows the global selector, a change midway applies to it as well)
        permissionMode: input.options.permissionMode,
        followGlobalPermission: input.options.followGlobalPermission,
      },
      directory: worker.directory ?? input.directory,
      extraDirectories: worker.extraDirectories ?? input.extraDirectories,
      visionModel: worker.orchestration?.vision ? input.visionModel : undefined,
      orchestrationRole: 'worker',
      parentSessionId: orchestratorId,
      workerTitle: worker.title,
      language: input.language,
    })
  } catch (err) {
    // Closes the span when the turn throws (the happy path closes it below, with
    // the reply size). Idempotent: the second call is ignored.
    perf.end({ error: err instanceof Error ? err.message.slice(0, 160) : String(err) })
    throw err
  } finally {
    const rest = (activeWorkers.get(orchestratorId) ?? []).filter((id) => id !== worker.id)
    if (rest.length > 0) activeWorkers.set(orchestratorId, rest)
    else activeWorkers.delete(orchestratorId)
  }
  const messages = await loadMessages(worker.id)
  const last = [...messages].reverse().find((m) => m.role === 'assistant')
  const reply = last?.parts
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim() ?? ''
  perf.end({
    replyChars: reply.length,
    ...(last?.error ? { error: last.error.slice(0, 160) } : {}),
  })
  return { text: reply, error: last?.error, tokens: last?.tokens }
}

export function abortOrchestration(sessionId: string) {
  controllers.get(sessionId)?.abort()
  // Transitive abort: phase-2 workers have their own controllers in the chat-engine
  for (const workerId of activeWorkers.get(sessionId) ?? []) abortChat(workerId)
  // A plan waiting for approval is no longer executable (e.g. a deleted session)
  pending.delete(sessionId)
}

/** Sessions with an orchestration in progress (planning/synthesis). */
export function getOrchestrationRunningSessionIds(): string[] {
  return [...controllers.keys()]
}

/** Phase 1 — planning. Replaces runChat when options.orchestrate is on. */
export async function runOrchestration(win: BrowserWindow, input: SendMessageInput): Promise<void> {
  // Write scope of the turn: the workers it awaits open child scopes, so what
  // they record also counts as this turn's work.
  return runWithWriteScope(() => withProviderSession(input.sessionId, () => runOrchestrationTurn(win, input)))
}

/**
 * A routine's own team: the plan comes from the members the author defined, so there is no
 * planning pass, and it runs unattended (see `unattended` in SendMessageOptions). With no folder
 * there is nowhere for the workers to work, so it falls back to a plain turn like the planner does.
 */
export async function runTeam(win: BrowserWindow, input: SendMessageInput, team: RoutineTeam): Promise<void> {
  const plan = input.directory ? planFromTeam(team, newId) : null
  if (!plan) return runChat(win, input)
  const { sessionId } = input
  controllers.get(sessionId)?.abort()
  pending.set(sessionId, { input, plan, assistantMessageId: '' })
  try {
    await withProviderSession(sessionId, () => approvePlanTurn(win, sessionId, plan.id))
  } finally {
    if (pending.get(sessionId)?.plan === plan) pending.delete(sessionId)
  }
}

async function runOrchestrationTurn(win: BrowserWindow, input: SendMessageInput): Promise<void> {
  // Every worker runs in code mode in the working folder — with no folder there
  // is nothing to orchestrate. The desktop UI already blocks sending without a
  // folder, but a scheduled routine and the companion do not: before, create_task
  // downgraded the task to chat,
  // and now that the worker is always code, that would create child sessions
  // with no tools at all. It falls back to the normal turn, which at least works.
  if (!input.directory) {
    await runChat(win, input)
    return
  }
  const { sessionId } = input
  controllers.get(sessionId)?.abort()
  const controller = new AbortController()
  controllers.set(sessionId, controller)

  emit(win, { type: 'status', sessionId, status: 'submitted' })

  const history = await loadMessages(sessionId)
  const userMessage: ChatMessage = {
    id: newId('msg'),
    role: 'user',
    parts: [{ id: newId('prt'), type: 'text', text: input.text, state: 'done' }],
    createdAt: Date.now(),
  }
  history.push(userMessage)
  emit(win, { type: 'message', sessionId, message: userMessage })

  const conductor = conductorInput(input)
  const assistantMessage: ChatMessage = {
    id: newId('msg'),
    role: 'assistant',
    parts: [],
    createdAt: Date.now(),
    providerId: conductor.providerId,
    modelId: conductor.modelId,
  }
  history.push(assistantMessage)
  await saveMessages(sessionId, history)
  emit(win, { type: 'message', sessionId, message: assistantMessage })

  // Model rotation (same rule as the chat-engine): the rotation chosen in the
  // selector for this chat; otherwise the pinned model; otherwise the default — with the
  // first model as the starting point of the loop below. A configured
  // orchestra model stands on its own: rotation belongs to the chat's model.
  const rotationSequence = input.orchestratorModel
    ? [{ providerId: conductor.providerId, modelId: conductor.modelId }]
    : resolveRotation(input.sessionId, {
        providerId: input.providerId,
        modelId: input.modelId,
      })
  const primaryModel = rotationSequence[0] ?? { providerId: conductor.providerId, modelId: conductor.modelId }

  // Automatic notice: workers that already exist and what the user sent directly
  // to them since the orchestrator's last turn (its previous answer).
  const lastOrchestratorTurn = history.slice(0, -2).reverse().find((m) => m.role === 'assistant')
  const workersNotice = await buildWorkersNotice(sessionId, lastOrchestratorTurn?.createdAt ?? 0)
  const existingTitles = new Set((await loadWorkers(sessionId)).map((w) => normalizeTitle(w.title)))
  let autoApprove: string | undefined
  // Only when it can write: in plan mode there is nothing to record.
  if (!input.options.plan) await openSnapshot(input.directory, assistantMessage)

  try {
    // PLANNING retry loop: a recoverable failure before the first token switches
    // to the next model in the sequence (workers already inherit the rotation
    // through runChat; synthesis/review keep the current behavior).
    let attemptIndex = 0
    for (;;) {
      const primary = rotationSequence[attemptIndex] ?? primaryModel
      assistantMessage.providerId = primary.providerId
      assistantMessage.modelId = primary.modelId
      assistantMessage.parts = []
      assistantMessage.error = undefined
      assistantMessage.errorKind = undefined
      emit(win, { type: 'message', sessionId, message: assistantMessage })
      try {
        const model = await resolveModel(primary.providerId, primary.modelId)
        emit(win, { type: 'status', sessionId, status: 'streaming' })

    const tasks: OrchestrationTask[] = []
    let workersMessaged = 0
    // Planning tool context (project reading + subagent). It always exists: the
    // guard at the top guarantees the working folder.
    const planCtx: ToolContext = {
      sessionId: input.sessionId,
      directory: input.directory,
      extraDirectories: input.extraDirectories ?? [],
      abort: controller.signal,
    }
    // Mode ceiling of the workers: what the user's session allows. The
    // orchestrator chooses within it, task by task.
    const ceiling: TaskModeCeiling = {
      research: input.options.research === true,
      browser: input.options.browser === true,
      vision: Boolean(input.visionModel),
      subagents: input.options.subagents === true,
      // Slice of the conversation's MCP servers (absent = all the enabled ones).
      toolsServers: input.options.toolsServers,
    }
    // Reading budget of the planning passes. It lives outside runPlanningPass
    // because the tools are created once and reused by the nudge; every pass
    // resets the counter at the start.
    let planReadCalls = 0
    // Wraps a read tool so it stops EXECUTING when the budget is gone: the model
    // gets a notice instead of the result and decides to register the plan,
    // instead of the pass dying without text.
    const capReadTool = (readTool: ToolSet[string]): ToolSet[string] => {
      const run = readTool.execute
      if (!run) return readTool
      return {
        ...readTool,
        execute: async (callInput: never, callOptions: never) => {
          if (planReadCalls >= PLAN_READ_MAX_CALLS) return PLAN_READ_BUDGET_NOTICE
          planReadCalls++
          return run(callInput, callOptions)
        },
      } as ToolSet[string]
    }
    const planTools: ToolSet = {
      create_task: createTaskTool(
        (task, substitui) => {
          const idx = substitui ? tasks.findIndex((t) => t.id === substitui) : -1
          if (idx >= 0) {
            tasks[idx] = task
            return true
          }
          if (tasks.length >= MAX_TASKS) return false
          tasks.push(task)
          return true
        },
        ceiling,
        // Only earlier plans: repeating a title of THIS plan replaces the task.
        (title) => existingTitles.has(normalizeTitle(title)),
        () => tasks,
      ),
      remove_task: createRemoveTaskTool(
        () => tasks,
        (id) => {
          const idx = tasks.findIndex((t) => t.id === id)
          if (idx >= 0) tasks.splice(idx, 1)
        },
      ),
      // Asking before splitting: only worth it when the answer changes the plan,
      // but without the tool it had no way to do that even when it was.
      question: createQuestionTool(input, controller.signal),
      // Workers from any plan of this conversation: see, read and continue.
      // Without this the only path was create_task — always a new worker, which
      // knows nothing about what the previous ones did.
      ...createWorkerTools(sessionId, async (worker, message) => {
        workersMessaged++
        return runWorkerTurn(win, input, worker, message)
      }),
    }
    // Direct reading of the project. Planning used to have NO file tool at all,
    // so the only way to look at the code was to spend a whole subagent —
    // hence the flood of calls. Reading is not delegating: it stays available
    // even with Subagents mode off.
    planTools.read = capReadTool(createReadTool(planCtx))
    planTools.ls = capReadTool(createListTool(planCtx))
    planTools.glob = capReadTool(createGlobTool(planCtx))
    planTools.grep = capReadTool(createGrepTool(planCtx))
    // Code index: with only 8 reads of budget, the project map and the symbol
    // search give far more per call than ls/read.
    for (const [name, codeTool] of Object.entries(createCodeTools(planCtx))) planTools[name] = capReadTool(codeTool)
    // Delegating research to another model is what Subagents mode controls in
    // the rest of the app (allowDelegation in tools/index) — the orchestration
    // used to be the only exception. Now it follows the same rule.
    if (ceiling.subagents) {
      planTools.subagent = capReadTool(
        createSubagentTool(input, planCtx, PLAN_SUBAGENT_MAX_STEPS, PLAN_SUBAGENT_MAX_CALLS),
      )
    }
    // A small request ("make the button blue") is not worth a plan, an approval
    // and a worker. With Subagents on it delegates the change in this chat;
    // otherwise it does it itself. In plan mode (read-only) neither exists.
    const canEdit = !input.options.plan
    if (canEdit && ceiling.subagents) {
      planTools.delegate_change = createSubagentTool(
        input,
        planCtx,
        SUBAGENT_MAX_STEPS,
        PLAN_DELEGATE_MAX_CALLS,
        PLAN_DELEGATE_DESCRIPTION,
      )
    } else if (canEdit) {
      planTools.edit = createEditTool(planCtx)
      planTools.write = createWriteTool(planCtx)
    }
    // Writes go through the same permission gate as a normal turn.
    const permissionMode = input.options.permissionMode ?? 'ask'
    const toolApproval = createToolApproval(
      input.options.followGlobalPermission ? () => globalMode(sessionId, permissionMode) : permissionMode,
      sessionId,
      input.directory,
      assistantMessage.id,
      controller.signal,
    )

    // The ceiling goes into the prompt: without it the model asks for
    // research/browser and only finds out it does not have it in the tool reply,
    // task by task.
    const enabled = Object.entries(ceiling).filter(([, v]) => v).map(([k]) => k)
    // The user's agents a task may run as (empty when none qualifies).
    const agentsNote = await workerAgentsForPlan()
    const contextNote = [
      `\n\nWorking folder: ${input.directory}. Every worker runs there, in code mode.`,
      enabled.length > 0
        ? `Modes the user enabled — workers may only use these: ${enabled.join(', ')}.`
        : 'The user enabled no optional modes: workers get the working folder and nothing else. Do not request research, browser, vision or subagents.',
      ceiling.subagents
        ? 'You also have the subagent tool for research while planning (3 calls max).'
        : 'You do NOT have subagents: research the project yourself before splitting — code_outline (no filePath) for the project map and code_search to find code, then read/grep for details.',
      !canEdit
        ? 'This conversation is read-only (plan mode): you cannot change files yourself — small changes also go through create_task.'
        : ceiling.subagents
          ? 'For a SMALL change, use delegate_change (a subagent in this chat) instead of a plan.'
          : 'For a SMALL change, do it yourself with edit/write instead of a plan.',
    ].join('\n') + workersNotice
    const provider = await getProvider(primary.providerId)
    const baseMessages = normalizeMessages(
      toModelMessages(history.slice(0, -1)),
      interleavedReasoningField(provider, primary.modelId),
    )
    const providerOptions = await buildProviderOptions({ ...conductor, providerId: primary.providerId, modelId: primary.modelId })
    const cost = provider?.models[primary.modelId]?.cost

    // Consumes the stream of a planning pass, emitting parts (text, reasoning,
    // tool calls) so the UI shows the orchestrator working — researching with a
    // subagent and planning — instead of a mute "Analyzing".
    const runPlanningPass = async (messages: ModelMessage[]) => {
      // Each pass has its OWN reading budget: the nudge reuses the same tools,
      // but does not inherit what the first one already spent.
      planReadCalls = 0
      const reasoningStep = agentPrepareStep(provider, primary.modelId, { directory: input.directory })
      let lastStepNumber = 0
      let sawFinish = false
      // Last-step guard. The SDK calls prepareStep with stepNumber = the steps
      // ALREADY completed (the do-while runs with steps.length 0..PLAN_MAX_STEPS-1
      // and stops when steps.length === PLAN_MAX_STEPS), so the last executed
      // step is PLAN_MAX_STEPS - 1 — at `>= PLAN_MAX_STEPS` the guard would never
      // fire.
      const prepareStep = ({
        stepNumber,
        messages: stepMessages,
      }: {
        stepNumber: number
        messages: ModelMessage[]
      }) => {
        lastStepNumber = Math.max(lastStepNumber, stepNumber)
        const base = reasoningStep({ messages: stepMessages })
        const normalized = 'messages' in base && base.messages ? base.messages : stepMessages
        if (stepNumber >= PLAN_MAX_STEPS - 1) {
          // No tools and a text answer required: instead of ending the pass on a
          // tool call (empty text, empty plan, a turn
          // without a reply), the model says what it has.
          return {
            activeTools: [],
            toolChoice: 'none' as const,
            messages: [...normalized, { role: 'user' as const, content: PLAN_MAX_STEPS_PROMPT }],
          }
        }
        return base
      }
      const stream = streamText({
        model,
        system: ORCHESTRATOR_PLAN_PROMPT + agentsNote + contextNote,
        messages,
        tools: planTools,
        toolApproval,
        stopWhen: stepCountIs(PLAN_MAX_STEPS),
        abortSignal: controller.signal,
        providerOptions,
        prepareStep,
        onError: () => { /* tratado no loop do fullStream */ },
      })
      let text = ''
      const reasoningStart = new Map<string, number>()
      // Stream ids → part id (same rule as the chat-engine). The SDK reuses
      // "txt-0"/"reasoning-0" on every step AND every pass: without this the
      // nudge pass overwrote the first one's text (the reply
      // "cut" in the middle) and the stale-text filter erased both.
      const streamIds = new Map<string, string>()
      const startStreamPart = (sdkId: string): string => {
        let id = sdkId
        for (let n = 1; assistantMessage.parts.some((p) => p.id === id); n++) id = `${sdkId}~${n}`
        streamIds.set(sdkId, id)
        return id
      }
      const streamPartId = (sdkId: string): string => streamIds.get(sdkId) ?? sdkId
      for await (const part of stream.fullStream) {
        switch (part.type) {
          case 'text-start':
            upsertPart(win, sessionId, assistantMessage, { id: startStreamPart(part.id), type: 'text', text: '', state: 'streaming' })
            break
          case 'text-delta': {
            const existing = assistantMessage.parts.find((p) => p.id === streamPartId(part.id))
            if (existing?.type === 'text') {
              existing.text += part.text
              text += part.text
              emit(win, { type: 'part-delta', sessionId, messageId: assistantMessage.id, partId: existing.id, kind: 'text', delta: part.text })
            }
            break
          }
          case 'text-end': {
            const existing = assistantMessage.parts.find((p) => p.id === streamPartId(part.id))
            if (existing?.type === 'text') upsertPart(win, sessionId, assistantMessage, { ...existing, state: 'done' })
            break
          }
          case 'reasoning-start':
            reasoningStart.set(part.id, Date.now())
            upsertPart(win, sessionId, assistantMessage, { id: startStreamPart(part.id), type: 'reasoning', text: '', state: 'streaming' })
            break
          case 'reasoning-delta': {
            const existing = assistantMessage.parts.find((p) => p.id === streamPartId(part.id))
            if (existing?.type === 'reasoning') {
              existing.text += part.text
              emit(win, { type: 'part-delta', sessionId, messageId: assistantMessage.id, partId: existing.id, kind: 'reasoning', delta: part.text })
            }
            break
          }
          case 'reasoning-end': {
            const existing = assistantMessage.parts.find((p) => p.id === streamPartId(part.id))
            if (existing?.type === 'reasoning') {
              const started = reasoningStart.get(part.id)
              upsertPart(win, sessionId, assistantMessage, { ...existing, state: 'done', durationMs: started ? Date.now() - started : undefined })
            }
            break
          }
          case 'tool-call':
            upsertPart(win, sessionId, assistantMessage, { id: part.toolCallId, type: 'tool', tool: part.toolName, state: 'running', input: part.input as Record<string, unknown> })
            break
          case 'tool-result': {
            const existing = assistantMessage.parts.find((p) => p.id === part.toolCallId) as ToolPart | undefined
            upsertPart(win, sessionId, assistantMessage, {
              id: part.toolCallId,
              type: 'tool',
              tool: part.toolName,
              state: 'done',
              input: existing?.input,
              output: typeof part.output === 'string' ? part.output : JSON.stringify(part.output, null, 2),
            })
            break
          }
          // Without these two, a denied write (or a read that failed) left the
          // card spinning forever.
          case 'tool-output-denied': {
            const existing = assistantMessage.parts.find((p) => p.id === part.toolCallId) as ToolPart | undefined
            upsertPart(win, sessionId, assistantMessage, {
              id: part.toolCallId,
              type: 'tool',
              tool: part.toolName,
              state: 'error',
              input: existing?.input,
              error: takeDenialReason(part.toolCallId) ?? 'Action denied by the permission policy.',
            })
            break
          }
          case 'tool-error': {
            const existing = assistantMessage.parts.find((p) => p.id === part.toolCallId) as ToolPart | undefined
            upsertPart(win, sessionId, assistantMessage, {
              id: part.toolCallId,
              type: 'tool',
              tool: part.toolName,
              state: 'error',
              input: existing?.input,
              error: errorToText(part.error),
            })
            break
          }
          case 'finish':
            sawFinish = true
            break
          case 'error':
            throw part.error instanceof Error ? part.error : new Error(errorToText(part.error))
        }
      }
      const hitCeiling = lastStepNumber >= PLAN_MAX_STEPS - 1
      return {
        text: text.trim(),
        usage: await stream.usage,
        // The step budget ran out (the last step was forced to text) —
        // the plan may have been left half done.
        hitCeiling,
        // Stream ended without `finish` (a provider/gateway that drops the connection):
        // without this the turn looked normally finished. It is the same diagnosis
        // as the chat-engine.
        lostFinish: !sawFinish && !controller.signal.aborted,
      }
    }

    const firstPass = await runPlanningPass(baseMessages)
    let planUsage = toTokenUsage(firstPass.usage, cost)
    let planTruncated = firstPass.hitCeiling || firstPass.lostFinish

    // Safety net: the orchestrator sometimes narrates "I will split into tasks"
    // and stops without calling create_task (empty plan). We give ONE explicit
    // nudge before giving up and treating it as a trivial answer.
    //
    // Only nudge when it REALLY promised a plan, OR when the pass
    // ran out of budget without producing any text (the most common case:
    // spending the steps reading the project and ending on a tool call). Answering
    // with no tasks is a legitimate outcome now — it is path 1 of the prompt (a
    // simple question, or offering "want me to implement it?"). Nudging that
    // would turn every conversation into a plan, which is exactly what we are
    // fixing. Whoever continued a worker's conversation has already acted — it is
    // not an empty plan.
    const promisedPlan = Boolean(firstPass.text) && PROMISED_PLAN_RE.test(firstPass.text)
    const silentOverrun = !firstPass.text && firstPass.hitCeiling
    if (tasks.length === 0 && workersMessaged === 0 && (promisedPlan || silentOverrun)) {
      const firstPassIds = new Set(assistantMessage.parts.map((p) => p.id))
      const nudgeMessages: ModelMessage[] = [...baseMessages]
      // Without text in the first pass there is no assistant reply to
      // resend — the nudge goes only as an engine message.
      if (firstPass.text) nudgeMessages.push({ role: 'assistant', content: firstPass.text })
      nudgeMessages.push({
        role: 'user',
        content: silentOverrun
          ? `[Engine check, not the user] You spent the whole planning budget (${PLAN_MAX_STEPS} steps) researching and produced NO reply and NO task. Do not promise anything. Either call create_task NOW, one per subtask, or answer in plain text with what you already have.`
          : `[Engine check, not the user] Your reply mentioned splitting the work but no task was registered. If the request needs to be split, call create_task NOW for each subtask. If your previous reply was already the right answer (a question answered, or work only offered), reply with exactly ${NO_PLAN_SENTINEL} and nothing else. Otherwise, answer directly without promising a plan.`,
      })
      const retry = await runPlanningPass(nudgeMessages)
      planUsage = addTokenUsage(planUsage, toTokenUsage(retry.usage, cost))
      planTruncated = planTruncated || retry.hitCeiling || retry.lostFinish
      if (tasks.length === 0) {
        if (retry.text.includes(NO_PLAN_SENTINEL) || !retry.text) {
          // Regex false positive: the first reply stands. Discard everything
          // from the nudge (text and reasoning) — otherwise the user saw the model
          // arguing about an internal message they never sent.
          assistantMessage.parts = assistantMessage.parts.filter((p) => firstPassIds.has(p.id))
        } else {
          // The final reply is the retry's — drop the first pass narration so the
          // user's final bubble does not duplicate text.
          assistantMessage.parts = assistantMessage.parts.filter((p) => p.type !== 'text' || !firstPassIds.has(p.id))
        }
      }
    }

    // Backstop: an assistant bubble with NO text is not a reply. If the
    // pass (and the nudge) died without text — budget spent on reads, provider
    // that ended the stream without `finish` — we write what happened instead of
    // handing over the tool cards and nothing else, which is how the orchestrator
    // "stopped halfway, without answering" the user.
    const hasText = assistantMessage.parts.some((p) => p.type === 'text' && p.text.trim().length > 0)
    if (tasks.length === 0 && !hasText) {
      upsertPart(win, sessionId, assistantMessage, {
        id: newId('prt'),
        type: 'text',
        text: tNow('orchestrator.stepsExhausted'),
        state: 'done',
      })
      planTruncated = true
    }
    // Ran out with no plan: mark the message so the next turn gets the
    // continuation reminder (same treatment as the chat-engine).
    if (tasks.length === 0 && planTruncated) assistantMessage.truncated = true

    // With message_worker in the turn, what changed in the folder is (also) the
    // worker's, and is already recorded in its chat — crediting the orchestrator would duplicate it.
    if (workersMessaged > 0) assistantMessage.snapshot = undefined
    else await closeSnapshot(input.directory, assistantMessage)

    await saveMessages(sessionId, history)

    if (tasks.length === 0) {
      // Trivial request: the orchestrator answered directly, with no plan
      emit(win, { type: 'message', sessionId, message: assistantMessage })
      emit(win, { type: 'status', sessionId, status: 'idle' })
      return
    }

    const plan: OrchestrationPlan = {
      id: newId('plan'),
      tasks,
      status: 'proposed',
      usage: planUsage,
    }
    // No loopConfig: the review is no longer a separate mode with its own
    // iterations — it always runs, and the Loop toggle only decides the SIZE of
    // the global round budget (see the review phase in approvePlan).
    pending.set(sessionId, { input, plan, assistantMessageId: assistantMessage.id })
      await persistPlan(win, sessionId, plan)
        emit(win, { type: 'message', sessionId, message: assistantMessage })
        emit(win, { type: 'status', sessionId, status: 'idle' })
        // A single-worker plan with the option on: the card shows up (it is the
        // record of what will run), but it does not wait for the click.
        const approval = normalizeOrchestrationSettings(getWorkerConfigCache().orchestration)
        if (input.options.orchestrate?.unattended || approval.autoApprove || (tasks.length === 1 && approval.approveSingleTask)) {
          autoApprove = plan.id
        }
        break
      } catch (err) {
        const aborted = controller.signal.aborted
        const { kind } = classifyProviderError(err)
        const nextIndex = attemptIndex + 1
        if (
          !aborted &&
          !hasStreamedContent(assistantMessage.parts) &&
          isRecoverableErrorKind(kind) &&
          nextIndex < rotationSequence.length
        ) {
          attemptIndex = nextIndex
          emit(win, {
            type: 'status',
            sessionId,
            status: 'fallback',
            fallback: { current: nextIndex + 1, total: rotationSequence.length },
          })
          continue
        }
        throw err
      }
    }
  } catch (err) {
    const aborted = controller.signal.aborted
    const { kind, detail: message } = classifyProviderError(err)
    assistantMessage.error = aborted ? undefined : message
    assistantMessage.errorKind = aborted || kind === 'unknown' ? undefined : kind
    // Stopped halfway (error or abort) after it had already edited: what changed
    // still needs to show up.
    await closeSnapshot(input.directory, assistantMessage)
    await saveMessages(sessionId, history)
    emit(win, { type: 'message', sessionId, message: assistantMessage })
    emit(win, {
      type: 'status',
      sessionId,
      status: aborted ? 'idle' : 'error',
      error: aborted ? undefined : message,
    })
  } finally {
    if (controllers.get(sessionId) === controller) controllers.delete(sessionId)
  }
  // Outside the try: the execution has its own controller and its own error
  // handling. We are already inside the planning's withProviderSession.
  if (autoApprove && !controller.signal.aborted) await approvePlanTurn(win, sessionId, autoApprove)
}

/** Phase 2 (worker execution) + Phase 3 (synthesis). */
export async function approvePlan(
  win: BrowserWindow,
  sessionId: string,
  planId: string,
  taskIds?: string[],
): Promise<void> {
  return withProviderSession(sessionId, () => approvePlanTurn(win, sessionId, planId, taskIds))
}

async function approvePlanTurn(
  win: BrowserWindow,
  sessionId: string,
  planId: string,
  taskIds?: string[],
  opts?: { resume?: boolean },
): Promise<void> {
  const entry = pending.get(sessionId)
  if (!entry || entry.plan.id !== planId) {
    emit(win, {
      type: 'status',
      sessionId,
      status: 'error',
      error: tNow('orchestrator.planGone'),
    })
    return
  }
  pending.delete(sessionId)
  const { input, plan } = entry
  const controller = new AbortController()
  controllers.set(sessionId, controller)

  let unregisterQuestions: (() => void) | undefined
  const selected = taskIds ? plan.tasks.filter((t) => taskIds.includes(t.id)) : plan.tasks
  if (selected.length === 0 && !opts?.resume) {
    plan.status = 'rejected'
    await persistPlan(win, sessionId, plan)
    return
  }

  try {
    // Marks the main session as the orchestrator (it becomes the parent node in the sidebar)
    const parent = await readJson<SessionInfo>(StorageKeys.session(sessionId))
    if (parent && parent.orchestration?.role !== 'orchestrator') {
      const next = { ...parent, orchestration: { role: 'orchestrator' as const }, updatedAt: Date.now() }
      await writeJson(StorageKeys.session(sessionId), next)
      emit(win, { type: 'session', sessionId, session: next })
    }

    // Current settings (the Orchestra dialog, via the cache the renderer
    // pushes). They live on the plan: the card shows the budget, and a plan in
    // progress does not change behavior if the user edits the dialog.
    // Resuming keeps the settings the plan was approved with: the dialog may have
    // changed since, and a half-done plan is finished the way it started.
    const config = opts?.resume
      ? normalizeOrchestrationSettings(plan.config ?? getWorkerConfigCache().orchestration)
      : normalizeOrchestrationSettings(getWorkerConfigCache().orchestration)
    plan.config = config
    // One worktree per worker only makes sense in a git repository.
    const chatRepo = config.worktrees ? await chatRepository(input.directory!) : null

    // Tasks outside the selection do not run — and depending on them no longer exists.
    // On a resume nothing is dropped: the accepted tasks stay in the plan (they are
    // the record of what was done and go into the synthesis/merge) and only the
    // selected ones run again.
    if (!opts?.resume) {
      const ids = new Set(selected.map((t) => t.id))
      for (const t of selected) if (t.dependsOn) t.dependsOn = t.dependsOn.filter((id) => ids.has(id))
      plan.tasks = selected
    }

    // Child sessions of the workers. Each worker is registered in activeWorkers
    // ALREADY AT CREATION — an abort in this window has to reach them.
    activeWorkers.set(sessionId, [])
    const workerSessions = new Map<string, SessionInfo>()
    const createSession = async (task: OrchestrationTask): Promise<SessionInfo> => {
      // Resuming: this task already has a worker — a session with the conversation
      // of what it did before the interruption (and, with worktrees, its own tree).
      // It continues there instead of starting over in a new child session.
      if (opts?.resume && task.workerSessionId) {
        const existing = await readJson<SessionInfo>(StorageKeys.session(task.workerSessionId))
        if (existing) {
          workerSessions.set(task.id, existing)
          activeWorkers.get(sessionId)?.push(existing.id)
          return existing
        }
      }
      const now = Date.now()
      const worker: SessionInfo = {
        id: newId('ses'),
        title: task.title,
        mode: 'code',
        pinned: false,
        archived: false,
        folderId: null,
        directory: input.directory,
        extraDirectories: input.extraDirectories,
        // An agent worker runs that agent's setup (profile is read from the session each turn).
        ...(task.agent ? { profile: task.agent } : {}),
        // The modes come from the plan: the orchestrator chose them task by task,
        // within the session ceiling. They stay on the session so whoever continues
        // the conversation later (review, message_worker) uses the same ones.
        orchestration: { role: 'worker', parentSessionId: sessionId, task: task.title, options: task.options, vision: task.vision },
        parentId: sessionId,
        createdAt: now,
        updatedAt: now,
      }
      await writeJson(StorageKeys.session(worker.id), worker)
      workerSessions.set(task.id, worker)
      task.workerSessionId = worker.id
      activeWorkers.get(sessionId)?.push(worker.id)
      emit(win, { type: 'session', sessionId: worker.id, session: worker })
      return worker
    }
    // They all show up in the sidebar right away, even the ones waiting on a dependency.
    for (const task of selected) await createSession(task)

    plan.status = 'running'
    // It is running again: whatever was left of the interruption is history now.
    delete plan.interrupted
    await persistPlan(win, sessionId, plan)
    emit(win, { type: 'status', sessionId, status: 'streaming' })

    // Queued writes: workers and reviews change the plan all the time, and two
    // simultaneous writes to the same file would trample each other.
    let writes = Promise.resolve()
    const persist = () => {
      writes = writes.then(() => persistPlan(win, sessionId, plan)).catch(() => {})
      return writes
    }

    // The reviewer is the conductor (the same model as planning and synthesis).
    const reviewer = conductorInput(input)
    const reviewerModel = await resolveModel(reviewer.providerId, reviewer.modelId)
    const reviewerProvider = await getProvider(reviewer.providerId)
    const reviewerOptions = await buildProviderOptions(reviewer)
    // The workers' questions go to the conductor first, with the request and the plan
    // (orchestration/questions.ts). It is woken per question — nothing stays running.
    unregisterQuestions = registerOrchestrator(sessionId, () => ({
      providerId: reviewer.providerId,
      modelId: reviewer.modelId,
      request: input.text,
      plan,
    }))
    const repoRoot = await repositoryRoot(input.directory!).catch(() => undefined)

    /**
     * Diff of the worker's work, for the reviewer. With a worktree git answers
     * directly; without one, the evidence is the snapshots of its chat turns —
     * and a turn whose capture failed leaves no patch at all. Returning empty
     * there would make the reviewer read "wrote nothing" where the truth is
     * "could not record it" (which is what the chat-engine's discriminated
     * check exists to separate), so the failure is stated and the folder state — the
     * real proof, even if shared with the other workers — is consulted.
     */
    const taskDiff = async (task: OrchestrationTask): Promise<string> => {
      if (task.worktree) return worktreeDiff(task.worktree)
      if (!task.workerSessionId) return ''
      const msgs = await loadMessages(task.workerSessionId)
      const snaps = msgs.filter((m) => m.role === 'assistant' && m.snapshot).map((m) => m.snapshot!)
      const { patch, unavailable } = turnDiffs(snaps)
      if (!unavailable) return patch
      const fromFolder = await folderDiff(input.directory!)
      return [unavailable, patch, fromFolder].filter(Boolean).join('\n\n')
    }
    /**
     * Files the worker changed, to check against the ones it owns. Without a
     * worktree they come from the turn snapshots; if some turn was not recorded
     * the list would be incomplete, and an incomplete list must not clear
     * anyone — then there is no check (null).
     */
    const taskFiles = async (task: OrchestrationTask): Promise<string[] | null> => {
      if (task.worktree) return worktreeFiles(task.worktree)
      if (!task.workerSessionId) return null
      const snaps = (await loadMessages(task.workerSessionId))
        .filter((m) => m.role === 'assistant' && m.snapshot)
        .map((m) => m.snapshot!)
      if (snaps.length === 0 || snaps.some((s) => s.failed || s.verified === 'unknown')) return null
      return snaps.flatMap((s) => s.files ?? [])
    }

    // The plan as a window: from the first worker leaving the queue to the last
    // review closing. `parallel` goes along so the record says how much of the
    // slot budget the plan actually used.
    const planPerf = perfSpan('plan', {
      plan: plan.id,
      tasks: plan.tasks.length,
      parallel: MAX_PARALLEL,
      behavior: config.behavior,
      worktrees: chatRepo ? true : false,
    })
    perfEvent('plan:start', { plan: plan.id, tasks: plan.tasks.map((t) => t.title) })
    const workerResults = await executePlan({
      plan,
      config,
      signal: controller.signal,
      keepAccepted: opts?.resume === true,
      parallel: input.options.orchestrate?.unattended?.maxParallel,
      extraOptions: { subagents: input.options.subagents === true },
      persist,
      runWorker: async (task, text) => {
        // An unattended run (a routine) stops starting turns once its budget is spent; the task
        // fails with that reason and the other branches carry on.
        if (budgetExhausted(plan.usage, input.options.orchestrate?.unattended?.tokenBudget)) {
          return { text: '', error: 'The token budget of this execution is spent.' }
        }
        const worker = workerSessions.get(task.id) ?? (await createSession(task))
        const r = await runWorkerTurn(win, input, worker, text)
        // Every turn (the first one and the adjustments) goes into the plan's cost.
        if (r.tokens) plan.usage = addTokenUsage(plan.usage, r.tokens)
        return r
      },
      prepareTask: chatRepo
        ? async (task) => {
            const worker = workerSessions.get(task.id) ?? (await createSession(task))
            // Resuming: the tree exists and holds what the worker wrote before the
            // interruption — a new one would start again from the base commit and
            // leave that work behind on the old branch. If the folder is gone (it
            // was deleted by hand), the plan forgets it and a new one is created below.
            if (task.worktree && existsSync(task.worktree.folder)) {
              return [`You work in an isolated git worktree (${task.worktree.folder}) on branch ${task.worktree.branch}, created from ${task.worktree.base}. You don't need to commit: the orchestrator commits your work when it is accepted and merges it at the end.`]
            }
            if (task.worktree) task.worktree = undefined
            const dependencies = (task.dependsOn ?? [])
              .map((id) => plan.tasks.find((t) => t.id === id)?.worktree)
              .filter((w): w is NonNullable<OrchestrationTask['worktree']> => !!w)
            const { worktree, notices } = await createWorkerWorktree({ chatFolder: input.directory!, planId: plan.id, task, dependencies })
            task.worktree = worktree
            // The worker's session now works in its own worktree.
            const next = { ...worker, directory: worktree.folder, updatedAt: Date.now() }
            await writeJson(StorageKeys.session(next.id), next)
            workerSessions.set(task.id, next)
            emit(win, { type: 'session', sessionId: next.id, session: next })
            return [
              `You work in an isolated git worktree (${worktree.folder}) on branch ${worktree.branch}, created from ${worktree.base}. Other workers have their own. You don't need to commit: the orchestrator commits your work when it is accepted and merges it at the end.`,
              ...notices,
            ]
          }
        : undefined,
      onAccept: chatRepo
        ? async (task) => {
            if (task.worktree) await commitWork(task.worktree, task.title).catch(() => {})
          }
        : undefined,
      review:
        config.behavior === 'orchestrate'
          ? undefined
          : (request, actions) =>
              reviewWithModel(
                {
                  model: reviewerModel,
                  providerOptions: reviewerOptions,
                  prepareStep: agentPrepareStep(reviewerProvider, reviewer.modelId, { directory: input.directory }),
                  originalRequest: input.text,
                  plan,
                  config,
                  signal: controller.signal,
                  diff: taskDiff,
                  touchedFiles: taskFiles,
                  checks: (task) => discoverChecks(task.worktree?.folder ?? input.directory!, task.worktree?.path ?? repoRoot),
                  runCheck: (_task, check) => runCheck(check, controller.signal),
                  onUsage: (usage) => {
                    plan.usage = addTokenUsage(plan.usage, toTokenUsage(usage as Parameters<typeof toTokenUsage>[0], reviewerProvider?.models[reviewer.modelId]?.cost))
                  },
                },
                request,
                actions,
              ),
    })
    activeWorkers.delete(sessionId)
    planPerf.end({
      accepted: plan.tasks.filter((t) => t.phase === 'accepted').length,
      failed: plan.tasks.filter((t) => t.phase === 'failed').length,
      inputTokens: plan.usage?.input,
      aborted: controller.signal.aborted,
    })

    // Abort during the execution: the workers already stopped, synthesizing makes no sense
    if (controller.signal.aborted) {
      plan.status = 'done'
      await persistPlan(win, sessionId, plan)
      emit(win, { type: 'status', sessionId, status: 'idle' })
      return
    }

    // Worktrees: merge the accepted work into the chat, dependencies first.
    if (chatRepo) await mergeWork(win, sessionId, plan, input.directory!)

    // Phase 3: streaming synthesis in the main chat
    const history = await loadMessages(sessionId)
    const conductor = conductorInput(input)
    const synthesisMessage: ChatMessage = {
      id: newId('msg'),
      role: 'assistant',
      parts: [],
      createdAt: Date.now(),
      providerId: conductor.providerId,
      modelId: conductor.modelId,
    }
    history.push(synthesisMessage)
    emit(win, { type: 'message', sessionId, message: synthesisMessage })

    const resultsText = plan.tasks
      .map((t) => {
        const state = t.phase === 'accepted' ? 'accepted' : t.phase === 'failed' ? 'FAILED' : t.phase ?? 'unknown'
        const note = t.reviewNote ? `\nOrchestrator note: ${t.reviewNote}` : ''
        // A resumed plan carries tasks accepted in the earlier run: this one has no
        // reply for them, and "(no reply)" would read like a worker that said nothing.
        const text =
          workerResults.get(t.id)?.text ||
          (t.phase === 'accepted' ? '(finished in an earlier run — its work is already in the folder)' : '(no reply)')
        return `## ${t.title}${t.extra ? ' (extra)' : ''} [${state}${t.revisions ? `, ${t.revisions} adjustment(s)` : ''}]${note}\n\n${text}`
      })
      .join('\n\n---\n\n') + (plan.review?.merge ? `\n\n---\n\nMerge of the workers' branches: ${plan.review.merge.detail}` : '')

    // A single task, accepted, with no merge issue: the synthesis would be a
    // model call to rewrite the worker's own summary. Deliver the summary
    // directly. A failure, an extra created in the review or a merge that did not
    // close still go through the synthesis — there is something to explain there.
    const onlyOne = plan.tasks.length === 1 ? plan.tasks[0] : undefined
    const directSummary =
      onlyOne && onlyOne.phase === 'accepted' && plan.review?.merge?.ok !== false
        ? workerResults.get(onlyOne.id)?.text?.trim()
        : undefined
    if (directSummary) {
      const part: TextPart = { id: newId('prt'), type: 'text', text: directSummary, state: 'done' }
      synthesisMessage.parts.push(part)
      emit(win, { type: 'part', sessionId, messageId: synthesisMessage.id, part })
    } else {
      const model = await resolveModel(conductor.providerId, conductor.modelId)
      const provider = await getProvider(conductor.providerId)
      const stream = streamText({
        model,
        system: ORCHESTRATOR_SYNTHESIS_PROMPT,
        messages: [
          ...normalizeMessages(
            toModelMessages(history.slice(0, -1)),
            interleavedReasoningField(provider, conductor.modelId),
          ),
          { role: 'user', content: `Worker results:\n\n${resultsText}` },
        ],
        abortSignal: controller.signal,
        providerOptions: await buildProviderOptions(conductor),
      })

      const part: TextPart = { id: newId('prt'), type: 'text', text: '', state: 'streaming' }
      let started = false
      for await (const delta of stream.textStream) {
        if (!started) {
          started = true
          synthesisMessage.parts.push(part)
          emit(win, { type: 'part', sessionId, messageId: synthesisMessage.id, part })
        }
        part.text += delta
        emit(win, {
          type: 'part-delta',
          sessionId,
          messageId: synthesisMessage.id,
          partId: part.id,
          kind: 'text',
          delta,
        })
      }
      part.state = 'done'
      if (started) emit(win, { type: 'part', sessionId, messageId: synthesisMessage.id, part })

      // Synthesis usage: recorded on the message itself and added to the plan
      synthesisMessage.tokens = toTokenUsage(await stream.usage, provider?.models[conductor.modelId]?.cost)
      plan.usage = addTokenUsage(plan.usage, synthesisMessage.tokens)
    }
    await saveMessages(sessionId, history)

    const session = await readJson<SessionInfo>(StorageKeys.session(sessionId))
    if (session) await writeJson(StorageKeys.session(sessionId), { ...session, updatedAt: Date.now() })

    plan.status = 'done'
    await persistPlan(win, sessionId, plan)
    emit(win, { type: 'message', sessionId, message: synthesisMessage })

    emit(win, { type: 'status', sessionId, status: 'idle' })
  } catch (err) {
    const aborted = controller.signal.aborted
    const message = errorToText(err)
    plan.status = 'done'
    await persistPlan(win, sessionId, plan)
    emit(win, {
      type: 'status',
      sessionId,
      status: aborted ? 'idle' : 'error',
      error: aborted ? undefined : message,
    })
  } finally {
    unregisterQuestions?.()
    activeWorkers.delete(sessionId)
    if (controllers.get(sessionId) === controller) controllers.delete(sessionId)
  }
}

export async function rejectPlan(win: BrowserWindow, sessionId: string): Promise<void> {
  const entry = pending.get(sessionId)
  if (!entry) return
  pending.delete(sessionId)
  entry.plan.status = 'rejected'
  await persistPlan(win, sessionId, entry.plan)
  emit(win, { type: 'status', sessionId, status: 'idle' })
}

/** Tasks in dependency order (prerequisites first) — the merge order. */
function dependencyOrder(tasks: OrchestrationTask[]): OrchestrationTask[] {
  const order: OrchestrationTask[] = []
  const seen = new Set<string>()
  const visit = (t: OrchestrationTask) => {
    if (seen.has(t.id)) return
    seen.add(t.id)
    for (const id of t.dependsOn ?? []) {
      const dep = tasks.find((x) => x.id === id)
      if (dep) visit(dep)
    }
    order.push(t)
  }
  for (const t of tasks) visit(t)
  return order
}

/**
 * Merges into the chat the branches of the accepted tasks that are not in yet,
 * in dependency order. The result lands on the plan (card + synthesis); if
 * something was left out (uncommitted change in the chat, conflict, git error),
 * the card offers "Merge again".
 */
async function mergeWork(win: BrowserWindow, sessionId: string, plan: OrchestrationPlan, chatFolder: string): Promise<void> {
  const accepted = dependencyOrder(plan.tasks).filter((t) => t.phase === 'accepted' && t.worktree && !t.merged)
  if (accepted.length === 0) return
  const review = plan.review ?? { adjustmentsUsed: 0, maxAdjustments: 0 }
  plan.review = { ...review, activity: "Merging the workers' work" }
  await persistPlan(win, sessionId, plan)

  const r = await mergeBranches(chatFolder, accepted.map((t) => ({ title: t.title, worktree: t.worktree! })))
  for (const t of accepted) {
    if (!r.merged.includes(t.title)) continue
    t.merged = true
    await removeWorkerWorktree(t.worktree!, true).catch(() => {})
  }
  const missing = accepted.filter((t) => !t.merged)
  const summary = `${r.merged.length} of ${accepted.length} merged`
  const detail = r.blocked
    ? `Nothing was merged: the chat folder has uncommitted changes in files the workers changed (${r.blocked.files.join(', ')}). Commit or stash them and use "Merge again".`
    : r.conflict
      ? `Conflict merging "${r.conflict.title}"${r.conflict.files.length ? ` (${r.conflict.files.join(', ')})` : ''}. ${summary}; the rest stays on the workers' branches. Resolve it in the chat and use "Merge again", or merge the branches by hand.`
      : r.error
        ? `Git refused to merge "${r.error.title}": ${r.error.message}. ${summary}; use "Merge again" after resolving it.`
        : `${r.merged.length} branch(es) merged into the chat.`
  plan.review = { ...plan.review, activity: undefined, merge: { ok: missing.length === 0, detail, pending: missing.length > 0 } }
  await persistPlan(win, sessionId, plan)
}

/**
 * "Merge again" (orchestration card): tries once more to merge the accepted work
 * that was left out — after the user commits/stashes the chat changes or
 * resolves a conflict.
 */
export async function mergeAgain(win: BrowserWindow, sessionId: string): Promise<void> {
  if (controllers.has(sessionId)) return // the plan is still running
  // Legacy plans (Portuguese keys/phase values) are translated at the read edge.
  const plan = normalizeOrchestrationPlan(await readJson<unknown>(StorageKeys.orchestration(sessionId)))
  const session = await readJson<SessionInfo>(StorageKeys.session(sessionId))
  if (!plan || !session?.directory) return
  await mergeWork(win, sessionId, plan, session.directory)
}

/**
 * "Continue" on the orchestration card: runs again the tasks the plan did not
 * accept — the ones still queued, running or in review when the app closed or the
 * run was cut short. The accepted work stays (and is merged if it never was), the
 * worker of each resumed task continues in its own session and worktree, and the
 * plan is finished with the settings it was approved with.
 */
export async function resumePlan(win: BrowserWindow, input: SendMessageInput): Promise<void> {
  const sessionId = input.sessionId
  // The card is a click away from being pressed twice, and a run already going has
  // nothing to resume.
  if (controllers.has(sessionId) || pending.has(sessionId)) return
  if (!input.directory) return
  const plan = normalizeOrchestrationPlan(await readJson<unknown>(StorageKeys.orchestration(sessionId)))
  if (!plan || plan.dismissed) return

  const todo = plan.tasks.filter((t) => t.phase !== 'accepted')
  // Nothing left to run: what remains is the accepted work that was never merged.
  if (todo.length === 0) {
    await mergeWork(win, sessionId, plan, input.directory)
    return
  }

  // The reviewer judges the workers' work against the request that produced the
  // plan; on a resume there is no turn to take it from, so it comes from the
  // history (the last message the person wrote before the plan).
  if (!input.text) {
    const lastUser = [...(await loadMessages(sessionId))].reverse().find((m) => m.role === 'user')
    input = {
      ...input,
      text:
        lastUser?.parts
          .filter((p): p is TextPart => p.type === 'text')
          .map((p) => p.text)
          .join('\n') ?? '',
    }
  }

  // approvePlanTurn takes the turn's input from the pending entry — the same door
  // the card's "Approve" uses, with the plan that is already on disk instead of the
  // one that was just proposed.
  pending.set(sessionId, { input, plan, assistantMessageId: '' })
  try {
    await withProviderSession(sessionId, () =>
      approvePlanTurn(win, sessionId, plan.id, todo.map((t) => t.id), { resume: true }),
    )
  } finally {
    if (pending.get(sessionId)?.plan === plan) pending.delete(sessionId)
  }
}

/**
 * A plan only says `running` while the process running it is alive — but the FILE
 * keeps the last state it had. After a crash or a force quit it stays `running`
 * with tasks in an open phase, and the card comes back as "in progress" forever:
 * no X (the card only offers one when nothing is running) and no way to finish the
 * work. At boot nothing is running yet, so an approved/running plan on disk is a
 * leftover — it is closed as done and marked `interrupted`, with the phases kept
 * as they were so the card can say where it stopped and offer "Continue".
 */
export async function recoverInterruptedPlans(): Promise<number> {
  let keys: string[] = []
  try {
    keys = await listKeys('orchestration')
  } catch {
    return 0
  }
  let recovered = 0
  for (const key of keys) {
    if (controllers.has(key.split('/').pop() ?? '')) continue
    let plan: OrchestrationPlan | undefined
    try {
      plan = normalizeOrchestrationPlan(await readJson<unknown>(key))
    } catch {
      continue
    }
    if (!plan || (plan.status !== 'approved' && plan.status !== 'running')) continue
    plan.status = 'done'
    plan.interrupted = true
    // "Reviewing: X" would read as "the orchestrator is doing something right now".
    if (plan.review) plan.review = { ...plan.review, activity: undefined }
    await writeJson(key, plan).catch(() => {})
    recovered++
  }
  return recovered
}
