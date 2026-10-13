import { generateText, tool } from 'ai'
import { z } from 'zod'
import type { Question, SendMessageInput } from '@shared/chat'
import { formatAskLine } from '@shared/chat'
import { newRequestId } from '../ask-broker'
import { dispatchAsk } from '../ask-dispatch'
import { broadcastChatEvent } from '../broadcast'
import { resolveModel } from '../providers'

interface QuestionReply {
  answers?: string[]
  rejected?: boolean
}

const DISMISSED = 'The user dismissed the questions — proceed with the most reasonable option.'

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
    return `Decisions made automatically (autonomous mode):\n${text.trim()}`
  } catch {
    return 'Could not decide automatically — proceed with the most reasonable option.'
  }
}

export function createQuestionTool(input: SendMessageInput, signal?: AbortSignal) {
  const isWorker = input.orchestrationRole === 'worker'
  const permissionMode = input.options.permissionMode ?? 'ask'
  const autoRespond = permissionMode === 'full' || (permissionMode === 'approve' && isWorker)

  return tool({
    description:
      'Asks the user structured questions to UNBLOCK an actual task you are executing (decisions about implementation, ambiguous requirements, choices that affect the outcome) — offer clear options. Do NOT use it to answer a conversational question, to propose development options the user did not ask for, or for trivial confirmations. IMPORTANT: the question (text) must be just the question itself, WITHOUT examples or options — options must be provided exclusively in the "options" field.',
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
          .map((q, i) => formatAskLine(i, q.text, reply.answers?.[i] || '(no answer)'))
          .join('\n')
      } catch {
        return DISMISSED
      } finally {
        broadcastChatEvent({ type: 'ask:done', sessionId: target, requestId })
      }
    },
  })
}
