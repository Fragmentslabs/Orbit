import { generateText, stepCountIs, tool, type LanguageModel, type ToolSet } from 'ai'
import { z } from 'zod'
import type { SendMessageInput } from '@shared/chat'
import { findCatalogModel } from '@shared/chat'
import { getAppSettings } from '../app-settings'
import { getProvider, modelSupportsVision } from '../catalog'
import { findRecipe, recipeHint, saveRecipe } from '../computer/recipes'
import { assertCanControl } from '../computer/session'
import { createToolApproval } from '../permission'
import { globalMode } from '../permission/global-mode'
import { computerSubagentPrompt } from '../prompts'
import { resolveModel } from '../providers'
import { buildCheapestReasoningOptions } from '../reasoning'
import { agentPrepareStep } from '../agent-step'
import { createComputerTools } from './computer'

/**
 * `computer_task` — Computer Use subagent. The main agent sends a
 * goal and waits; a dedicated agent runs the observe → act loop with a
 * SHORT context (only the goal and its own observations, never the conversation) and
 * a smaller model. Each step becomes lighter: in the direct loop, each click
 * resent the whole conversation.
 *
 * The model: the one from Preferences → Computer; without it, the auxiliary model (if
 * it calls tools); only then the conversation's. Reasoning at the lowest level the
 * model accepts — each step is "click what I just saw". When the loop
 * gets stuck (actions that change nothing, repeated errors), the next step goes up to
 * the conversation's model: the cheap one does the walking, the expensive one only enters at the impasse.
 *
 * The subagent's cu_* tools use the SAME sessionId as the conversation: the record of
 * observations, the yellow band, the chip, the panel thumbnail and a recording
 * in progress see what it does. Permissions go through the same gate
 * (the request appears in the conversation), and the denylist applies the same.
 */

const COMPUTER_TASK_MAX_STEPS = 40
/** The loop only: recording and permissions stay with the main agent. */
const SUBAGENT_TOOLS = ['cu_apps', 'cu_observe', 'cu_query', 'cu_computer', 'cu_batch']
/** Consecutive error results until it moves up to the conversation's model. */
const ESCALATE_AFTER_ERRORS = 2

interface Target {
  providerId: string
  modelId: string
  source: 'settings' | 'aux' | 'conversation'
}

async function subagentTarget(input: SendMessageInput): Promise<Target> {
  const { computer, auxModel } = getAppSettings()
  if (computer.model) return { ...computer.model, source: 'settings' }
  if (auxModel) {
    const provider = await getProvider(auxModel.providerId).catch(() => undefined)
    const found = provider && findCatalogModel({ [provider.id]: provider }, provider.id, auxModel.modelId)
    // The auxiliary model is picked for titles and summaries: it only serves here if it calls tools.
    if (found?.model.tool_call) return { providerId: auxModel.providerId, modelId: found.modelId, source: 'aux' }
  }
  return { providerId: input.providerId, modelId: input.modelId, source: 'conversation' }
}

/** Text of a tool result (a string, or the text part of one with an image). */
function resultText(output: unknown): string {
  if (typeof output === 'string') return output
  if (output && typeof output === 'object' && 'message' in output && typeof output.message === 'string') return output.message
  return ''
}

const isError = (text: string) => /^Error \(|STOPPED —|STOP: /m.test(text)

export function createComputerTaskTool(input: SendMessageInput, abort?: AbortSignal) {
  return tool({
    description:
      'Delegates a multi-step task in another app of the user\'s computer to a dedicated computer-use agent, which runs the observe/act loop with a short context and a faster model, and returns a report. The agent does not see this conversation: give a self-contained goal — the app, what to do, what "done" looks like, and anything it must not do. Use it for flows of several actions; for one quick action use cu_computer yourself, and to confirm its result use cu_verify instead of observing the whole window.',
    inputSchema: z.object({
      goal: z.string().describe('Self-contained goal: app, steps or outcome, constraints'),
    }),
    execute: async ({ goal }, { abortSignal }) => {
      // Another conversation in control: the subagent does not even come up (it would only hit the
      // same lock on every action, spending steps).
      try {
        assertCanControl(input.sessionId)
      } catch (err) {
        return `Error (busy): ${err instanceof Error ? err.message : String(err)} Do not retry: tell the user, and ask whether to wait for it or stop it (⌘⇧. stops it).`
      }
      const target = await subagentTarget(input)
      const provider = await getProvider(target.providerId)
      const model = await resolveModel(target.providerId, target.modelId)
      // The conversation's model, for the impasse. Equal to the subagent's, there is nowhere to go up to.
      const sameAsConversation = target.providerId === input.providerId && target.modelId === input.modelId
      let strong: LanguageModel | null = null
      const signal = abortSignal ?? abort
      let stalled = false
      let escalatedAt: number | null = null
      const all = createComputerTools({
        sessionId: input.sessionId,
        modelVision: modelSupportsVision(provider, target.modelId),
        visionModel: input.visionModel,
        conversation: { providerId: input.providerId, modelId: input.modelId },
        onStall: () => {
          stalled = true
        },
      })
      const tools: ToolSet = Object.fromEntries(Object.entries(all).filter(([name]) => SUBAGENT_TOOLS.includes(name)))
      const mode = input.options.permissionMode ?? 'ask'
      // The subagent's own gate: requests go to the conversation (same
      // sessionId), and "Allow for this turn" holds for its execution.
      const toolApproval = createToolApproval(
        input.options.followGlobalPermission ? () => globalMode(input.sessionId, mode) : mode,
        input.sessionId,
        input.directory ?? null,
        `${input.sessionId}-computer-task`,
        signal,
      )
      const recipe = await findRecipe(goal).catch(() => null)
      const prompt = recipe ? `${goal}\n\n${recipeHint(recipe)}` : goal
      const trim = agentPrepareStep(provider, target.modelId)
      const started = Date.now()
      const result = await generateText({
        model,
        system: computerSubagentPrompt(input.language),
        prompt,
        tools,
        toolApproval,
        providerOptions: await buildCheapestReasoningOptions(target.providerId, target.modelId, input.sessionId),
        // Stopping at the impasse with no model to go up to: the report goes back to the main
        // agent, which decides (or asks) — better than spending the 40 steps.
        stopWhen: [stepCountIs(COMPUTER_TASK_MAX_STEPS), () => stalled && (sameAsConversation || escalatedAt !== null)],
        abortSignal: signal,
        prepareStep: async ({ messages, steps }) => {
          const prepared = trim({ messages })
          if (sameAsConversation || escalatedAt !== null) return escalatedAt !== null && strong ? { ...prepared, model: strong } : prepared
          const recent = steps.slice(-ESCALATE_AFTER_ERRORS).flatMap((s) => s.toolResults.map((r) => resultText(r.output)))
          const stuck = stalled || (recent.length >= ESCALATE_AFTER_ERRORS && recent.every(isError))
          if (!stuck) return prepared
          strong ??= await resolveModel(input.providerId, input.modelId)
          escalatedAt = steps.length
          stalled = false
          return { ...prepared, model: strong }
        },
      })
      const calls = result.steps.flatMap((s) => s.toolCalls)
      const summaries = result.steps.flatMap((s) =>
        s.toolResults.filter((r) => r.toolName === 'cu_computer' || r.toolName === 'cu_batch').flatMap((r) => resultText(r.output).split('\n\nApp: ')[0].split('\n')),
      )
      const hitLimit = result.steps.length >= COMPUTER_TASK_MAX_STEPS
      // Only what worked becomes a recipe: a loop that got stuck or hit the ceiling
      // would teach the wrong path next time.
      if (!hitLimit && !stalled && summaries.length > 0 && !summaries.some(isError)) {
        await saveRecipe(goal, summaries.map((line) => line.replace(/^\d+\. /, ''))).catch(() => undefined)
      }
      const usage = result.totalUsage
      const seconds = Math.round((Date.now() - started) / 100) / 10
      const tokens = `${usage.inputTokens ?? 0} in (${usage.inputTokenDetails?.cacheReadTokens ?? 0} cached) / ${usage.outputTokens ?? 0} out (${usage.outputTokenDetails?.reasoningTokens ?? 0} reasoning)`
      console.info(
        `[computer_task] ${target.modelId} (${target.source}) · ${seconds}s · ${result.steps.length} step(s) · ${calls.length} call(s) · ${tokens}${escalatedAt !== null ? ` · escalated at step ${escalatedAt}` : ''}${recipe ? ' · recipe' : ''}`,
      )
      const header = [
        `Computer agent (${target.modelId}) finished in ${seconds}s with ${calls.length} tool call(s), ${tokens} tokens`,
        escalatedAt !== null ? ` — moved to ${input.modelId} at step ${escalatedAt + 1} after getting stuck` : '',
        hitLimit ? ' — stopped at the step limit' : '',
        stalled ? ' — stopped: its actions were not changing the screen' : '',
        '.',
      ].join('')
      return `${header}\n\n${result.text || '(no report — check the result with cu_verify)'}`
    },
  })
}
