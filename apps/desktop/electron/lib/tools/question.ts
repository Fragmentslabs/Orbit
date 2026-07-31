import { generateText, tool } from 'ai'
import { z } from 'zod'
import type { Question, SendMessageInput } from '@shared/chat'
import { newRequestId } from '../ask-broker'
import { dispatchAsk } from '../ask-dispatch'
import { broadcastChatEvent } from '../broadcast'
import { resolveModel } from '../providers'

interface QuestionReply {
  answers?: string[]
  rejected?: boolean
}

const DISMISSED = 'O usuário dispensou as perguntas — prossiga com a opção mais razoável.'

async function autoAnswer(input: SendMessageInput, questions: Omit<Question, 'id'>[]): Promise<string> {
  try {
    const model = await resolveModel(input.providerId, input.modelId)
    const { text } = await generateText({
      model,
      system:
        'You decide on the user\'s behalf to unblock a worker agent running autonomously. Choose the most reasonable and safe option for each question. Reply with numbered lines, choices only, no explanations.',
      prompt: questions
        .map(
          (q, i) =>
            `${i + 1}. ${q.text}${q.options?.length ? ` Options: ${q.options.join(' | ')}` : ''}`,
        )
        .join('\n'),
    })
    return `Decisões tomadas automaticamente (modo autônomo):\n${text.trim()}`
  } catch {
    return 'Não foi possível decidir automaticamente — prossiga com a opção mais razoável.'
  }
}

export function createQuestionTool(input: SendMessageInput, signal?: AbortSignal) {
  const isWorker = input.orchestrationRole === 'worker'
  const permissionMode = input.options.permissionMode ?? 'ask'
  const autoRespond = permissionMode === 'full' || (permissionMode === 'approve' && isWorker)

  return tool({
    description:
      'Asks the user structured questions. Use it when facing decisions with multiple valid approaches, ambiguous requirements, or choices that affect the outcome — offer clear options. Do NOT use it for trivial confirmations. IMPORTANT: the question (text) must be just the question itself, WITHOUT examples or options — options must be provided exclusively in the "options" field.',
    inputSchema: z.object({
      questions: z
        .array(
          z.object({
            text: z.string().describe('The direct, objective question, WITHOUT examples or options — those go in the "options" field'),
            options: z.array(z.string()).optional().describe('Answer options (2-4, short and direct)'),
            multi: z.boolean().optional().describe('Allow selecting multiple options'),
          }),
        )
        .min(1)
        .max(4),
    }),
    execute: async ({ questions }) => {
      if (autoRespond) return autoAnswer(input, questions)

      const withIds: Question[] = questions.map((q, i) => ({ id: `q${i}`, ...q }))
      const requestId = newRequestId()
      const target = isWorker && input.parentSessionId ? input.parentSessionId : input.sessionId
      try {
        const reply = await dispatchAsk<QuestionReply>(
          target,
          {
            requestId,
            kind: 'question',
            questions: withIds,
            origin:
              target !== input.sessionId
                ? { workerSessionId: input.sessionId, workerTitle: input.workerTitle ?? 'worker' }
                : undefined,
          },
          signal,
        )
        if (reply?.rejected || !reply?.answers) return DISMISSED
        return questions
          .map((q, i) => `${i + 1}. ${q.text}\n   → ${reply.answers?.[i] || '(sem resposta)'}`)
          .join('\n')
      } catch {
        return DISMISSED
      } finally {
        broadcastChatEvent({ type: 'ask:done', sessionId: target, requestId })
      }
    },
  })
}
