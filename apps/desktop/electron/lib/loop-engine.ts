import { generateText, stepCountIs } from 'ai'
import { z } from 'zod'
import type { BrowserWindow } from 'electron'
import type { ChatMessage, SendMessageInput, TextPart } from '@shared/chat'
import { StorageKeys } from '@shared/chat'
import { runChat } from './chat-engine'
import { REVIEW_PROMPT } from './prompts'
import { resolveModel } from './providers'
import { readJson, writeJson } from './storage'

export interface LoopEngineConfig {
  maxIterations: number
  maxTokensPerIter: number
  autoReview: boolean
}

export interface ReviewResult {
  status: 'done' | 'needs_more'
  reason: string
  followUpPrompt?: string
}

function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function emit(win: BrowserWindow, event: Record<string, unknown>) {
  if (!win.isDestroyed()) win.webContents.send('chat:event', event)
}

async function loadMessages(sessionId: string): Promise<ChatMessage[]> {
  return (await readJson<ChatMessage[]>(StorageKeys.messages(sessionId))) ?? []
}

async function saveMessages(sessionId: string, messages: ChatMessage[]) {
  await writeJson(StorageKeys.messages(sessionId), messages)
}

/**
 * Revisa o resultado da última iteração e decide se o objetivo foi atingido.
 */
export async function reviewIteration(
  _sessionId: string,
  originalInput: string,
  history: ChatMessage[],
  _maxTokens: number,
  providerId: string,
  modelId: string,
  abortSignal?: AbortSignal,
): Promise<ReviewResult> {
  const model = await resolveModel(providerId, modelId)
  const result = await generateText({
    model,
    system: REVIEW_PROMPT,
    messages: [
      { role: 'user', content: `## Pedido original do usuário\n\n${originalInput}` },
      {
        role: 'user',
        content: `## Histórico da conversa\n\n${history
          .map((m) => `[${m.role}]: ${m.parts.filter((p): p is TextPart => p.type === 'text').map((p) => p.text).join('\n')}`)
          .join('\n\n')}`,
      },
      {
        role: 'user',
        content:
          'Com base no pedido original e no que já foi feito, analise se o objetivo foi completamente atingido. Se sim, use review_completion com status "done". Se não, use "needs_more" e descreva exatamente o que falta fazer no followUpPrompt.',
      },
    ],
    tools: {
      review_completion: {
        description: 'Registra se o objetivo foi atingido ou se precisa continuar.',
        inputSchema: z.object({
          status: z.enum(['done', 'needs_more']),
          reason: z.string().describe('Explicação curta da decisão'),
          followUpPrompt: z.string().optional().describe('Se needs_more, descreva exatamente o que falta. Será enviado como nova instrução.'),
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

  while (iteration < config.maxIterations) {
    await runChat(win, currentInput)

    const history = await loadMessages(input.sessionId)
    const hasNewUser = history
      .slice()
      .reverse()
      .some((m) => m.role === 'user' && iteration > 0)
    if (hasNewUser) break

    const review = await reviewIteration(input.sessionId, input.text, history, config.maxTokensPerIter, input.providerId, input.modelId)
    if (review.status === 'done') break

    iteration++
    if (iteration >= config.maxIterations) break

    if (!config.autoReview) {
      const msg: ChatMessage = {
        id: newId('msg'),
        role: 'user',
        parts: [{
          id: newId('prt'),
          type: 'text',
          text: `[Loop ${iteration}/${config.maxIterations}] ${review.reason}\n\nDeseja continuar? (sim/não)`,
          state: 'done',
        }],
        createdAt: Date.now(),
      }
      history.push(msg)
      await saveMessages(input.sessionId, history)
      emit(win, { type: 'message', sessionId: input.sessionId, message: msg })
      currentInput = { ...currentInput, text: review.followUpPrompt ?? 'Continue.' }
      continue
    }

    const followUp: ChatMessage = {
      id: newId('msg'),
      role: 'user',
      parts: [{
        id: newId('prt'),
        type: 'text',
        text: `[Loop ${iteration}/${config.maxIterations}] ${review.reason}\n\n${review.followUpPrompt ?? 'Continue o trabalho.'}`,
        state: 'done',
      }],
      createdAt: Date.now(),
    }
    history.push(followUp)
    await saveMessages(input.sessionId, history)
    emit(win, { type: 'message', sessionId: input.sessionId, message: followUp })

    currentInput = { ...currentInput, text: review.followUpPrompt ?? 'Continue o trabalho.' }
  }
}
