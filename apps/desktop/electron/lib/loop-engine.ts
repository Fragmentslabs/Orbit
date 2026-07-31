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
  status: 'done' | 'needs_more' | 'replan'
  reason: string
  followUpPrompt?: string
  /** Se replan, sugestão de nova abordagem */
  newApproach?: string
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

    // Replan: abordagem atual não resolve — reformula o prompt e reinicia
    if (review.status === 'replan') {
      const replanMsg: ChatMessage = {
        id: newId('msg'),
        role: 'user',
        parts: [{
          id: newId('prt'),
          type: 'text',
          text: `[Replan ${iteration}/${config.maxIterations}] ${review.reason}\n\nNova abordagem: ${review.newApproach ?? 'Reformule a estratégia de execução.'}`,
          state: 'done',
        }],
        createdAt: Date.now(),
      }
      history.push(replanMsg)
      await saveMessages(input.sessionId, history)
      emit(win, { type: 'message', sessionId: input.sessionId, message: replanMsg })
      currentInput = { ...currentInput, text: review.newApproach ?? review.reason }
      continue
    }

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
