import { generateText, stepCountIs } from 'ai'
import { z } from 'zod'
import type { BrowserWindow } from 'electron'
import type { ChatMessage, SendMessageInput, TextPart } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import { runChat } from './chat-engine'
import { REVIEW_PROMPT } from './prompts'
import { resolveModel } from './providers'
import { withProviderSession } from './provider-session'
import { readJson } from './storage'

export interface LoopEngineConfig {
  maxIterations: number
}

export interface ReviewResult {
  status: 'done' | 'needs_more' | 'replan'
  reason: string
  followUpPrompt?: string
  /** If replan, suggest a new approach */
  newApproach?: string
}

/** Abort controllers of the loop per session (separate from runChat's). */
const loopControllers = new Map<string, AbortController>()

/** Aborts a session's loop — called together with abortChat(). */
export function abortLoop(sessionId: string) {
  loopControllers.get(sessionId)?.abort()
}

/** Sessions with an active loop (between iterations of runChat, during the review). */
export function getLoopRunningSessionIds(): string[] {
  return [...loopControllers.keys()]
}

async function loadMessages(sessionId: string): Promise<ChatMessage[]> {
  return (await readJson<ChatMessage[]>(StorageKeys.messages(sessionId))) ?? []
}

/**
 * Reviews the result of the last iteration and decides whether the goal was reached.
 */
export async function reviewIteration(
  originalInput: string,
  history: ChatMessage[],
  providerId: string,
  modelId: string,
  abortSignal?: AbortSignal,
): Promise<ReviewResult> {
  const model = await resolveModel(providerId, modelId)
  const result = await generateText({
    model,
    system: REVIEW_PROMPT,
    messages: [
      { role: 'user', content: `## User's original request\n\n${originalInput}` },
      {
        role: 'user',
        content: `## Conversation history\n\n${history
          .map((m) => `[${m.role}]: ${m.parts.filter((p): p is TextPart => p.type === 'text').map((p) => p.text).join('\n')}`)
          .join('\n\n')}`,
      },
      {
        role: 'user',
        content:
          'Based on the original request and what has been done so far, analyze whether the goal was fully achieved. If so, use review_completion with status "done". If not, use "needs_more" and describe exactly what\'s missing in followUpPrompt. If the current approach is repeatedly failing, use "replan" with a new strategy in newApproach.',
      },
    ],
    tools: {
      review_completion: {
        description: 'Records whether the goal was achieved, needs more work, or requires re-planning.',
        inputSchema: z.object({
          status: z.enum(['done', 'needs_more', 'replan']),
          reason: z.string().describe('Short explanation of the decision'),
          followUpPrompt: z.string().optional().describe('If needs_more, describe exactly what\'s missing. Will be sent as a new instruction.'),
          newApproach: z.string().optional().describe('If replan, suggest a new approach or strategy.'),
        }),
      },
    },
    stopWhen: stepCountIs(1),
    abortSignal,
  })

  const toolCall = result.toolCalls?.[0]
  if (toolCall?.toolName === 'review_completion') {
    return (toolCall as unknown as { args: ReviewResult }).args
  }

  return { status: 'done', reason: result.text?.trim() || 'Review complete.' }
}

/**
 * Runs runChat in a loop: run → review → iterate until done or the limit.
 */
export async function runChatWithLoop(
  win: BrowserWindow,
  input: SendMessageInput,
  config: LoopEngineConfig,
): Promise<void> {
  return withProviderSession(input.sessionId, () => runLoop(win, input, config))
}

async function runLoop(
  win: BrowserWindow,
  input: SendMessageInput,
  config: LoopEngineConfig,
): Promise<void> {
  let iteration = 0
  let currentInput = { ...input }

  // Loop-level abort: aborting the current iteration's runChat does not end the loop —
  // it would go on to the next iteration even with the user trying to stop.
  const controller = new AbortController()
  loopControllers.set(input.sessionId, controller)
  try {
    while (iteration < config.maxIterations && !controller.signal.aborted) {
      await runChat(win, currentInput)
      if (controller.signal.aborted) break

      const history = await loadMessages(input.sessionId)
      const hasNewUser = history
        .slice()
        .reverse()
        .some((m) => m.role === 'user' && iteration > 0)
      if (hasNewUser) break

      const review = await reviewIteration(
        input.text,
        history,
        input.providerId,
        input.modelId,
        controller.signal,
      )
      if (review.status === 'done') break

      iteration++
      if (iteration >= config.maxIterations) break

      // The next iteration's instruction is NOT written here: whoever writes the
      // user message is runChat, with the input.text it receives. Writing
      // on both sides produced TWO messages per iteration — the one with the
      // "[Loop N/M]" prefix and, right below, the follow-up alone.
      currentInput = {
        ...currentInput,
        text:
          review.status === 'replan'
            // Replan: the current approach does not solve it — reformulate and start over.
            ? `[Replan ${iteration}/${config.maxIterations}] ${review.reason}\n\nNew approach: ${review.newApproach ?? 'Rework the execution strategy.'}`
            : `[Loop ${iteration}/${config.maxIterations}] ${review.reason}\n\n${review.followUpPrompt ?? 'Continue the work.'}`,
      }
    }
  } finally {
    loopControllers.delete(input.sessionId)
  }
}
