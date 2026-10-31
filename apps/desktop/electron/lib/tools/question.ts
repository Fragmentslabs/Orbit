import { generateText, tool } from 'ai'
import { z } from 'zod'
import type { Question, SendMessageInput } from '@shared/chat'
import { formatAskLine } from '@shared/chat'
import { newRequestId } from '../ask-broker'
import { dispatchAsk } from '../ask-dispatch'
import { broadcastChatEvent } from '../broadcast'
import { resolveModel } from '../providers'
import { askOrchestrator, hasOrchestrator } from '../orchestration/questions'

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
  // An orchestra worker asks its orchestrator first, which knows the request and the
  // plan (orchestration/questions.ts). Read per call: the run may end mid-turn.
  const orchestrated = () => isWorker && hasOrchestrator(input.parentSessionId)
  const autoRespond = permissionMode === 'full' || (permissionMode === 'approve' && isWorker)

  const viaOrchestrator = orchestrated()
    ? ' In this run your questions go to the ORCHESTRATOR first — it knows the user\'s request and the whole plan, and answers what it can; only what it cannot settle reaches the user. So make each question stand alone: say what you found and why it blocks you.'
    : ''
  return tool({
    description:
      'Asks the user structured questions to UNBLOCK an actual task you are executing (decisions about implementation, ambiguous requirements, choices that affect the outcome) — offer clear options. Do NOT use it to answer a conversational question, to propose development options the user did not ask for, or for trivial confirmations. IMPORTANT: the question (text) must be just the question itself, WITHOUT examples or options — options must be provided exclusively in the "options" field.' + viaOrchestrator,
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
      let decided: string[] = []
      let pending = questions.map((q, index) => ({ q, index }))
      if (orchestrated()) {
        const rulings = await askOrchestrator({
          orchestratorSessionId: input.parentSessionId!,
          workerTitle: input.workerTitle ?? 'worker',
          questions,
          mode: permissionMode,
        })
        decided = rulings
          .filter((r) => r.answer)
          .map((r) => formatAskLine(r.index, questions[r.index].text, `${r.answer} (decided by the orchestrator)`))
        const reasons = new Map(rulings.filter((r) => r.escalate).map((r) => [r.index, r.escalate!]))
        pending = pending
          .filter(({ index }) => reasons.has(index))
          .map(({ q, index }) => ({ q: { ...q, text: `${q.text} (${reasons.get(index)})` }, index }))
        if (pending.length === 0) return decided.join('\n')
      } else if (autoRespond) {
        return autoAnswer(input, questions)
      }

      const withIds: Question[] = pending.map(({ q }, i) => ({ id: `q${i}`, ...q }))
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
        if (reply?.rejected || !reply?.answers) return [...decided, DISMISSED].join('\n')
        return [
          ...decided,
          ...pending.map(({ q, index }, i) => formatAskLine(index, q.text, reply.answers?.[i] || '(no answer)')),
        ].join('\n')
      } catch {
        return [...decided, DISMISSED].join('\n')
      } finally {
        broadcastChatEvent({ type: 'ask:done', sessionId: target, requestId })
      }
    },
  })
}
