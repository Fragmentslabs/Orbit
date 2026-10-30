import type { ModelMessage } from 'ai'
import type { CatalogProvider } from '@shared/chat'
import { findCatalogModel } from '@shared/chat'
import { contextBudget, createTrimState, trimTurnContext, workingBudget } from './context-budget'
import { supportsAnthropicCache, withAnthropicCache } from './prompt-cache'
import { modelRuntime } from './provider-npm'
import { interleavedReasoningField, normalizeMessages } from './reasoning'
import { hoistToolImages } from './tool-images'

/**
 * What every tool loop does before each step — the main agent (chat-engine),
 * the subagents, the orchestrator, /init, computer_task and the pipeline. They
 * do not go through runChat because that is a whole chat turn (it persists
 * messages, emits screen events, takes a snapshot, compacts); what they share
 * is only this:
 *
 * 1. Cutting the turn's accumulation (context-budget.ts), remembering between
 *    steps so the prefix stays stable across cuts.
 * 2. Reasoning normalization: the SDK rebuilds the messages between steps and
 *    may drop the empty reasoning_content of a tool call (DeepSeek requires the
 *    field back in EVERY assistant message, otherwise a 400). Without the
 *    interleaved field it still sanitizes tool messages, avoiding the
 *    openai-compatible converter crash on malformed parts.
 * 3. Anthropic cache marks (prompt-cache.ts), when the model speaks that
 *    protocol.
 *
 * Single-step calls (title, vision, review, commit message) are left out on
 * purpose: there is no next step to re-read the cache, and writing to it costs
 * 25% more than the normal input.
 */
export interface StepPreparer {
  /** The messages ready for the step — the SAME reference when nothing changed. */
  prepare(messages: ModelMessage[]): ModelMessage[]
  /** Tool results discarded so far in this loop */
  readonly dropped: number
  readonly budget: number
  readonly workingBudget: number
}

export function createStepPreparer(
  provider: CatalogProvider | undefined,
  modelId: string,
  options: { directory?: string } = {},
): StepPreparer {
  const model = provider && findCatalogModel({ [provider.id]: provider }, provider.id, modelId)?.model
  const field = interleavedReasoningField(provider, modelId)
  const cache = supportsAnthropicCache(modelRuntime(provider, model).npm)
  const budget = contextBudget(model)
  const working = workingBudget(model)
  const state = createTrimState()
  return {
    prepare(messages) {
      const trimmed = trimTurnContext(messages, budget, { softBudget: working, state, directory: options.directory })
      const normalized = normalizeMessages(trimmed, field)
      return cache ? withAnthropicCache(normalized) : normalized
    },
    get dropped() {
      return state.dropped.size
    },
    budget,
    workingBudget: working,
  }
}

/** The preparer already in the SDK's `prepareStep` format. One per call to
 *  streamText/generateText: the cut's memory belongs to the loop, not the process. */
export function agentPrepareStep(
  provider: CatalogProvider | undefined,
  modelId: string,
  options: { directory?: string } = {},
): ({ messages }: { messages: ModelMessage[] }) => { messages?: ModelMessage[] } | Record<string, never> {
  const preparer = createStepPreparer(provider, modelId, options)
  return ({ messages }) => {
    // A tool image (Computer Use subagent screenshot) becomes a user
    // message — in openai-compatible it would arrive as base64 in text. The
    // main chat does the same in its own prepareStep (see tool-images.ts).
    const prepared = hoistToolImages(preparer.prepare(messages)).messages
    return prepared === messages ? {} : { messages: prepared }
  }
}
