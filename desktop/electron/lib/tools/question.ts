import { generateText, tool } from 'ai'
import { z } from 'zod'
import type { Question, SendMessageInput } from '../../../shared/chat'
import { DEFAULT_PERMISSION_THRESHOLDS } from '../../../shared/chat'
import { newRequestId } from '../ask-broker'
import { dispatchAsk } from '../ask-dispatch'
import { broadcastChatEvent } from '../broadcast'
import { resolveModel } from '../providers'

/**
 * Tool question: perguntas estruturadas ao usuário (card inline via AskBroker).
 * Autonomia por thresholds (decisionsAuto do modo ativo):
 * - full: sempre auto-responde (decisionsAuto high por default).
 * - approve + decisionsAuto=high: auto-responde também na sessão principal.
 * - workers: pai em ask → sobe ao chat do orquestrador (com batching);
 *   pai em approve → auto; pai em full → tool nem é exposta (tools/index.ts).
 */

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
        'Você decide no lugar do usuário para desbloquear um agente worker em execução autônoma. Escolha a opção mais razoável e segura para cada pergunta. Responda em linhas numeradas, apenas as escolhas, sem explicações.',
      prompt: questions
        .map(
          (q, i) =>
            `${i + 1}. ${q.text}${q.options?.length ? ` Opções: ${q.options.join(' | ')}` : ''}`,
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
  const decisionsAuto = (
    input.permissionThresholds?.[permissionMode] ?? DEFAULT_PERMISSION_THRESHOLDS[permissionMode]
  ).decisionsAuto
  const autoRespond =
    permissionMode === 'full' ||
    (permissionMode === 'approve' && (decisionsAuto === 'high' || isWorker))

  return tool({
    description:
      'Faz perguntas estruturadas ao usuário. Use diante de decisões com múltiplas abordagens válidas, requisitos ambíguos ou escolhas que afetam o resultado — ofereça opções claras. NÃO use para confirmações triviais.',
    inputSchema: z.object({
      questions: z
        .array(
          z.object({
            text: z.string().describe('A pergunta, completa e específica'),
            options: z.array(z.string()).optional().describe('Opções de resposta (2-4, curtas)'),
            multi: z.boolean().optional().describe('Permite selecionar múltiplas opções'),
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
