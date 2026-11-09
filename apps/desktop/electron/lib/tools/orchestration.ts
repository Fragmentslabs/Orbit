import { generateText, stepCountIs, tool, type ModelMessage } from 'ai'
import { z } from 'zod'
import type { OrchestrationTask, SendMessageInput } from '@shared/chat'
import { SUBAGENT_EMPTY_OUTPUT, SUBAGENT_NO_FOLDER_NOTICE } from '@shared/chat'
import { createToolApproval } from '../permission'
import { buildSystemPrompt } from '../prompts'
import { getProvider, modelSupportsVision } from '../catalog'
import { resolveModel } from '../providers'
import { buildProviderOptions } from '../reasoning'
import { agentPrepareStep } from '../agent-step'
import type { ToolContext } from './context'
import { buildToolSet } from './index'
import { globalMode } from '../permission/global-mode'
import { fileDisputes, normalizePath, waitsFor } from '../orchestration/ownership'
import { suggestibleAgent } from '../agents/suggestions'
import type { ProfileId } from '@shared/chat'

/**
 * Delegation tools:
 * - subagent: ephemeral worker in the background (Subagents mode) — runs an
 *   isolated generation with the worker model and returns the text as a
 *   tool-result.
 * - create_task: registers plan tasks (used only by the OrchestratorEngine in
 *   the planning phase of Orchestra mode).
 */

export const SUBAGENT_MAX_STEPS = 30

/**
 * The last step of a subagent: no tools, a text answer required. Without it a worker
 * that reached the ceiling on a tool call returned empty text, and everything it had
 * done was lost to the parent — the same guard as the orchestrator's planning pass.
 */
const SUBAGENT_LAST_STEP_PROMPT = `STEP LIMIT REACHED. Tools are now disabled — answer with text ONLY, for the agent that delegated this task:
- what you did and found (with exact paths, commands, results),
- what is still unfinished or unverified,
- the next concrete step to finish it.`

function newTaskId() {
  return `task_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * `maxSteps` limits the work of EACH subagent. During the orchestration's
 * PLANNING the research must stay light (the goal is to ground the split, not
 * to solve the task), so the orchestrator passes a low ceiling.
 *
 * `maxCalls` limits HOW MANY TIMES the model may call this tool in total —
 * without it, a prompt text asking for "at most 2-3 calls" is only a suggestion
 * the model may ignore (that is what happened: 17 calls just to plan). Past the
 * limit, the tool refuses instead of running one more full subagent (which by
 * itself already costs several steps and tokens).
 */
export function createSubagentTool(
  input: SendMessageInput,
  ctx: ToolContext | null,
  maxSteps = SUBAGENT_MAX_STEPS,
  maxCalls?: number,
  /** Same mechanics for another purpose (e.g. the orchestrator's small change). */
  description = 'Delegates a subtask to a worker that runs in the background and returns the result as text. Use for parallel or isolated work: research, file analysis, focused tasks. The worker does not see this conversation — include all necessary context in the task.',
) {
  let calls = 0
  return tool({
    description,
    inputSchema: z.object({
      task: z.string().describe('Self-contained task description, with all necessary context'),
      research: z.boolean().optional().describe('Enables web search (websearch/webfetch)'),
      browser: z.boolean().optional().describe('Enables JavaScript browser navigation'),
      code: z.boolean().optional().describe('Code mode: access to the working folder\'s files'),
      brain: z.boolean().optional().describe('Enables persistent memory (memory_* tools)'),
      simple: z.boolean().optional().describe('Plain text answers, no formatting'),
    }),
    execute: async ({ task, research, browser, code, brain, simple }) => {
      calls++
      if (maxCalls !== undefined && calls > maxCalls) {
        return `Limit of ${maxCalls} subagent calls reached — proceed with what has been gathered so far (do not request more research).`
      }
      const worker = input.workerModel ?? { providerId: input.providerId, modelId: input.modelId }
      const codeUnavailable = code === true && !input.directory
      const workerInput: SendMessageInput = {
        // Synthetic id: isolates the worker's native browser from the main session's
        sessionId: `${input.sessionId}-sub-${newTaskId()}`,
        text: task,
        providerId: worker.providerId,
        modelId: worker.modelId,
        mode: code && input.directory ? 'code' : 'chat',
        options: {
          research,
          browser,
          brain: brain ?? true,
          simple: simple ?? true,
          reasoning: worker.reasoning,
          // Gatekeeping: the worker inherits the parent's permission mode — and,
          // if the parent follows the global selector, a change mid-way applies to it too
          permissionMode: input.options.permissionMode,
          followGlobalPermission: input.options.followGlobalPermission,
          // The MCP server selection is the parent's too: the worker does not
          // decide on its own which servers it sees (undefined = all enabled).
          toolsServers: input.options.toolsServers,
        },
        directory: input.directory,
        extraDirectories: input.extraDirectories,
        orchestrationRole: 'worker',
        parentSessionId: input.sessionId,
        workerTitle: task.split('\n')[0].trim().slice(0, 60) || 'subagente',
        language: input.language,
      }

      const workerCtx: ToolContext | null =
        workerInput.mode === 'code' && ctx
          ? { ...ctx, sessionId: workerInput.sessionId }
          : null

      const model = await resolveModel(worker.providerId, worker.modelId)
      // the worker's provider for preparing each step of the tool loop (context
      // trimming, reasoning, cache) — the same as the main agent's.
      const workerProvider = await getProvider(worker.providerId)
      // Vision is the WORKER MODEL's, not the parent's: it is the parameter
      // (not ctx) that the chat branch consults, and the worker may be on another model.
      const tools = buildToolSet(workerInput, workerCtx, undefined, modelSupportsVision(workerProvider, worker.modelId))
      const modoWorker = workerInput.options.permissionMode ?? 'ask'
      const toolApproval = createToolApproval(
        // The level that counts is the CHAT's that asked for the worker: the
        // worker id is a child session with no entry of its own in the map.
        workerInput.options.followGlobalPermission
          ? () => globalMode(workerInput.parentSessionId ?? workerInput.sessionId, modoWorker)
          : modoWorker,
        workerInput.sessionId,
        ctx?.directory ?? null,
        workerInput.sessionId,
        ctx?.abort,
        workerInput.parentSessionId,
        workerInput.workerTitle,
      )

      const result = await generateText({
        model,
        system: await buildSystemPrompt(workerInput),
        prompt: task,
        tools: Object.keys(tools).length > 0 ? tools : undefined,
        toolApproval,
        stopWhen: stepCountIs(maxSteps),
        abortSignal: ctx?.abort,
        providerOptions: await buildProviderOptions(workerInput),
        prepareStep: lastStepGuard(agentPrepareStep(workerProvider, worker.modelId, { directory: ctx?.directory }), maxSteps),
      })
      const notice = codeUnavailable ? `${SUBAGENT_NO_FOLDER_NOTICE}\n\n` : ''
      return notice + (result.text || SUBAGENT_EMPTY_OUTPUT)
    },
  })
}

/**
 * The SDK calls prepareStep with stepNumber = steps already completed, so the last
 * one that runs is `maxSteps - 1` (see the same guard in orchestrator.ts).
 */
export function lastStepGuard(
  base: ReturnType<typeof agentPrepareStep>,
  maxSteps: number,
) {
  return ({ stepNumber, messages }: { stepNumber: number; messages: ModelMessage[] }) => {
    const prepared = base({ messages })
    if (stepNumber < maxSteps - 1) return prepared
    const current = 'messages' in prepared && prepared.messages ? prepared.messages : messages
    return {
      activeTools: [] as string[],
      toolChoice: 'none' as const,
      messages: [...current, { role: 'user' as const, content: SUBAGENT_LAST_STEP_PROMPT }],
    }
  }
}

export interface CreateTaskArgs {
  title: string
  prompt: string
  files?: string[]
  research?: boolean
  browser?: boolean
  readonly?: boolean
  simple?: boolean
  vision?: boolean
  subagents?: boolean
  dependsOn?: string[]
  agent?: string
}

/** "Login Screen " and "login screen" are the same name in the sidebar. */
function taskByTitle(tasks: OrchestrationTask[], title: string): OrchestrationTask | undefined {
  const key = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()
  return tasks.find((t) => key(t.title) === key(title))
}

/**
 * Mode ceiling: what the user's session allows. The orchestrator chooses
 * WITHIN it — asking above the ceiling does not fail, it is downgraded with a
 * notice in the tool result (the model must know it did not get what it asked for).
 */
export interface TaskModeCeiling {
  research: boolean
  browser: boolean
  vision: boolean
  subagents: boolean
  /** MCP server selection chosen in the conversation (undefined = all).
   *  The tools have no on/off switch: the selection applies to the workers. */
  toolsServers?: string[]
}

/**
 * The orchestrator's planning tool: each call becomes an OrchestrationTask.
 * Calling it again with the title of a task in THIS plan replaces it (same id,
 * so whoever depends on it keeps depending) — that is how the orchestrator fixes
 * a split after the files-in-dispute notice.
 */
export function createTaskTool(
  /** `replaces`: id of the task in this plan the new one takes the place of. */
  register: (task: OrchestrationTask, replaces?: string) => boolean,
  ceiling: TaskModeCeiling,
  /** Is the title already a worker's from a PREVIOUS plan? In the sidebar the
   *  title is the only thing that tells one worker from another. */
  titleTaken: (title: string) => boolean = () => false,
  /** Tasks already registered in this plan (dependsOn, replacement, disputes). */
  planTasks: () => OrchestrationTask[] = () => [],
) {
  const inPlan = (title: string) => taskByTitle(planTasks(), title)
  return tool({
    description: [
      'Registers a subtask in the orchestration plan. Each task becomes an independent worker session',
      'running in the working folder, in parallel, with no access to this conversation.',
      'Give each task the files it owns: tasks that touch different files run side by side without waiting.',
      'Calling it again with the title of a task already in this plan replaces that task.',
      'Choose the modes each worker needs — they are not free: research and browser add latency,',
      'subagents multiply cost. Enable only what the task actually requires.',
    ].join(' '),
    inputSchema: z.object({
      title: z.string().describe(
        'Worker name shown in the sidebar, in the user\'s language. 2-5 words naming the concrete area or deliverable, '
        + 'so the user tells workers apart at a glance — e.g. "Payments webhook", "Login screen: validation", "CSV parser tests". '
        + 'Never generic ("Implementation", "Analysis", "Task 1", "Backend") and never the same as another worker.',
      ),
      prompt: z.string().describe('Self-contained prompt for the worker, with all necessary context'),
      files: z
        .array(z.string())
        .optional()
        .describe(
          'Files or folders this task will change, relative to the working folder (globs allowed: "src/auth/**"). '
          + 'The worker is told it owns them and that other workers own the rest. Keep each task\'s files apart from '
          + 'the other parallel tasks — that is what lets them run at the same time. Omit for read-only tasks.',
        ),
      research: z.boolean().optional().describe('Web search — only if the task needs information from the internet'),
      browser: z.boolean().optional().describe('JavaScript browser — only to open/test real web pages'),
      readonly: z.boolean().optional().describe('Worker reads and analyses but never edits files or runs commands'),
      simple: z.boolean().optional().describe('Direct answers with no formatting. Good for short lookups, bad for specs and documentation'),
      vision: z.boolean().optional().describe('Lets the worker describe attached images'),
      subagents: z.boolean().optional().describe('Lets the worker delegate to its own background subagents. Costly — only for broad tasks'),
      agent: z
        .string()
        .optional()
        .describe('The id of one of the user\'s agents (from "AGENTS YOU CAN USE FOR A TASK"), when the task is exactly its job. Leave out for the general worker.'),
      dependsOn: z
        .array(z.string())
        .optional()
        .describe('Titles of tasks ALREADY registered in this plan that must be accepted before this one starts. Only for real order (tests after the feature, integration after its parts).'),
    }),
    execute: async ({ title, prompt, files, research, browser, readonly: readOnly, simple, vision, subagents, dependsOn, agent }: CreateTaskArgs) => {
      const previous = inPlan(title)
      const chosen = agent ? suggestibleAgent(agent) : null
      if (agent && !chosen) {
        return `Task "${title}" was NOT registered: there is no agent "${agent}" to use. Pick an id from "AGENTS YOU CAN USE FOR A TASK", or register it again without an agent.`
      }
      // A dependency only on an already registered task: besides giving the id,
      // this makes a cycle impossible (nobody depends on what does not exist
      // yet). On a replacement the same holds, except depending on itself.
      const dependsOnIds: string[] = []
      for (const prerequisite of dependsOn ?? []) {
        const id = inPlan(prerequisite)?.id
        if (!id || id === previous?.id) {
          return `Task "${title}" was NOT registered: "${prerequisite}" is not another task already registered in this plan. Register the prerequisites first and try again, using the exact title in dependsOn.`
        }
        if (previous && waitsFor(planTasks().find((t) => t.id === id)!, previous.id, planTasks())) {
          return `Task "${title}" was NOT registered: "${prerequisite}" already waits for it, so depending on it would be a cycle.`
        }
        if (!dependsOnIds.includes(id)) dependsOnIds.push(id)
      }
      if (!previous && titleTaken(title)) {
        return `A worker named "${title}" already exists in this conversation — the task was NOT registered. Call create_task again with a title that sets it apart (the specific area or deliverable), or use message_worker if the work continues that worker's.`
      }
      // Downgrades whatever is above the ceiling and counts it to warn the model.
      const denied: string[] = []
      const clamp = (want: boolean | undefined, allowed: boolean, name: string) => {
        if (want && !allowed) {
          denied.push(name)
          return undefined
        }
        return want
      }
      const owned = [...new Set((files ?? []).map(normalizePath).filter((f) => f.length > 0))]
      const task: OrchestrationTask = {
        id: previous?.id ?? newTaskId(),
        title,
        prompt,
        options: {
          research: clamp(research, ceiling.research, 'research'),
          browser: clamp(browser, ceiling.browser, 'browser'),
          plan: readOnly,
          simple,
          subagents: clamp(subagents, ceiling.subagents, 'subagents'),
          // Not the orchestrator's choice: the MCP server selection applies to
          // the whole conversation and follows the workers.
          toolsServers: ceiling.toolsServers,
        },
        vision: clamp(vision, ceiling.vision, 'vision'),
        status: 'idle',
        ...(dependsOnIds.length > 0 ? { dependsOn: dependsOnIds } : {}),
        ...(owned.length > 0 ? { files: owned } : {}),
        ...(chosen ? { agent: agent as ProfileId } : {}),
      }
      if (!register(task, previous?.id)) return 'Plan task limit reached — do not register more tasks.'
      const notices: string[] = []
      if (denied.length > 0) {
        notices.push(`It runs without ${denied.join(', ')}: the user did not enable ${denied.length > 1 ? 'those modes' : 'that mode'} in this conversation. Adjust the task prompt if it depended on it.`)
      }
      // A notice, not a lock: sometimes sharing the same file is the right call.
      // But the orchestrator must know these two will step on each other (or wait).
      const disputes = fileDisputes(task, planTasks())
      if (disputes.length > 0) {
        notices.push(
          'It shares files with tasks that would run at the same time: '
          + disputes.map((d) => `"${d.task.title}" (${d.files.join(', ')})`).join('; ')
          + '. Parallel workers editing the same files step on each other. Unless that is really intended, fix it now by '
          + 're-registering with the same title: narrow the files so they no longer overlap, add dependsOn so one runs '
          + 'after the other, or merge the work into one task (and remove_task the other).',
        )
      }
      const done = previous ? `Task "${title}" replaced in the plan.` : `Task "${title}" registered in the plan.`
      return notices.length > 0 ? `${done} ${notices.join(' ')}` : done
    },
  })
}

/** Takes a task out of the plan being assembled — create_task's pair for merging two. */
export function createRemoveTaskTool(
  planTasks: () => OrchestrationTask[],
  remove: (id: string) => void,
) {
  return tool({
    description: 'Removes a task registered in this plan (e.g. after merging its work into another task). Tasks that depended on it no longer wait for it.',
    inputSchema: z.object({
      title: z.string().describe('Exact title of the task to remove'),
    }),
    execute: async ({ title }: { title: string }) => {
      const target = taskByTitle(planTasks(), title)
      if (!target) return `No task titled "${title}" in this plan.`
      remove(target.id)
      for (const t of planTasks()) {
        if (!t.dependsOn?.includes(target.id)) continue
        const rest = t.dependsOn.filter((id) => id !== target.id)
        if (rest.length > 0) t.dependsOn = rest
        else delete t.dependsOn
      }
      return `Task "${target.title}" removed from the plan.`
    },
  })
}
