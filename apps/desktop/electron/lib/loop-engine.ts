import { generateText, stepCountIs } from 'ai'
import { z } from 'zod'
import type { BrowserWindow } from 'electron'
import type { ChatMessage, SendMessageInput, TextPart } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import { runChat } from './chat-engine'
import { REVIEW_PROMPT } from './prompts'
import { resolveModel } from './providers'
import { readJson } from './storage'

export interface LoopEngineConfig {
  maxIterations: number
}

export interface ReviewResult {
  status: 'done' | 'needs_more' | 'replan'
  reason: string
  followUpPrompt?: string
  /** Se replan, sugestão de nova abordagem */
  newApproach?: string
}

/** Abort controllers do loop por sessão (separados dos do runChat). */
const loopControllers = new Map<string, AbortController>()

/** Aborta o loop de uma sessão — chamado junto com abortChat(). */
export function abortLoop(sessionId: string) {
  loopControllers.get(sessionId)?.abort()
}

/** Sessões com loop ativo (entre iterações do runChat, durante a revisão). */
export function getLoopRunningSessionIds(): string[] {
  return [...loopControllers.keys()]
}

async function loadMessages(sessionId: string): Promise<ChatMessage[]> {
  return (await readJson<ChatMessage[]>(StorageKeys.messages(sessionId))) ?? []
}

/**
 * Revisa o resultado da última iteração e decide se o objetivo foi atingido.
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

  return { status: 'done', reason: result.text?.trim() || 'Revisão concluída.' }
}

/**
 * Executa runChat em loop: executa → revisa → itera até done ou limite.
 */
export async function runChatWithLoop(
  win: BrowserWindow,
  input: SendMessageInput,
  config: LoopEngineConfig,
): Promise<void> {
  let iteration = 0
  let currentInput = { ...input }

  // Loop-level abort: abortar o runChat da iteração atual não encerra o loop —
  // ele seguiria para a próxima iteração mesmo com o usuário tentando parar.
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

      // A instrução da próxima iteração NÃO é gravada aqui: quem grava a
      // mensagem do usuário é o runChat, com o input.text que recebe. Gravar
      // dos dois lados produzia DUAS mensagens por iteração — a com o prefixo
      // "[Loop N/M]" e, logo abaixo, o follow-up sozinho.
      currentInput = {
        ...currentInput,
        text:
          review.status === 'replan'
            // Replan: a abordagem atual não resolve — reformula e recomeça.
            ? `[Replan ${iteration}/${config.maxIterations}] ${review.reason}\n\nNova abordagem: ${review.newApproach ?? 'Reformule a estratégia de execução.'}`
            : `[Loop ${iteration}/${config.maxIterations}] ${review.reason}\n\n${review.followUpPrompt ?? 'Continue o trabalho.'}`,
      }
    }
  } finally {
    loopControllers.delete(input.sessionId)
  }
}
