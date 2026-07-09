import type { PermissionMode, SendMessageInput } from '../../../shared/chat'
import { ask, newRequestId } from '../ask-broker'
import { broadcastChatEvent } from '../broadcast'
import type { ToolContext } from '../tools/context'
import { assess, decide, type WorkDirs } from './rules'

/**
 * Gate de permissões plugado na opção `toolApproval` do streamText/generateText
 * (ai-sdk v7): a função é async — quando o veredito exige confirmação, o card
 * aparece na UI e o stream fica aguardando a resposta, sem pausa/retomada.
 * Workers emitem o pedido no chat do orquestrador (gatekeeping).
 */

export type PermissionDecision = 'allow' | 'always' | 'deny'

/** "Sempre permitir" por sessão: ruleIds aprovados de forma permanente na sessão */
const alwaysAllowed = new Map<string, Set<string>>()

/** Razões de negação por toolCallId — consumidas pelo case tool-output-denied */
export const denialReasons = new Map<string, string>()

export function takeDenialReason(toolCallId: string): string | undefined {
  const reason = denialReasons.get(toolCallId)
  denialReasons.delete(toolCallId)
  return reason
}

interface ApprovalToolCall {
  toolCallId: string
  toolName: string
  input: unknown
}

export function createToolApproval(
  input: SendMessageInput,
  ctx: ToolContext | null,
  signal: AbortSignal | undefined,
) {
  const mode: PermissionMode = input.options.permissionMode ?? 'ask'
  const dirs: WorkDirs | null = ctx
    ? { directory: ctx.directory, extraDirectories: ctx.extraDirectories }
    : null

  return async ({ toolCall }: { toolCall: ApprovalToolCall }) => {
    const assessment = assess(toolCall.toolName, toolCall.input, dirs)
    if (!assessment) return 'not-applicable' as const

    const decision = decide(mode, assessment.verdict)
    if (decision === 'approved') return 'approved' as const
    if (decision === 'denied') {
      const reason = `Bloqueado pela política de segurança: ${assessment.claim.detail}.`
      denialReasons.set(toolCall.toolCallId, reason)
      return { type: 'denied' as const, reason: `${reason} Busque uma alternativa segura e siga.` }
    }

    // decision === 'user': confirma com o usuário (no chat do pai, se worker)
    if (alwaysAllowed.get(input.sessionId)?.has(assessment.ruleId)) return 'approved' as const

    const requestId = newRequestId()
    const isWorker = input.orchestrationRole === 'worker' && !!input.parentSessionId
    const target = isWorker ? input.parentSessionId! : input.sessionId
    broadcastChatEvent({
      type: 'permission',
      sessionId: target,
      requestId,
      claim: assessment.claim,
      origin: isWorker
        ? { workerSessionId: input.sessionId, workerTitle: input.workerTitle ?? 'worker' }
        : undefined,
    })
    try {
      const reply = await ask<PermissionDecision>(target, requestId, signal)
      if (reply === 'always') {
        const set = alwaysAllowed.get(input.sessionId) ?? new Set<string>()
        set.add(assessment.ruleId)
        alwaysAllowed.set(input.sessionId, set)
        return 'approved' as const
      }
      if (reply === 'allow') return 'approved' as const
      denialReasons.set(toolCall.toolCallId, 'Negado pelo usuário.')
      return {
        type: 'denied' as const,
        reason: 'O usuário negou esta ação. Não a repita — siga por outro caminho ou pergunte.',
      }
    } catch {
      // Abort da sessão / pedido rejeitado
      denialReasons.set(toolCall.toolCallId, 'Pedido de permissão cancelado.')
      return { type: 'denied' as const, reason: 'O pedido de permissão foi cancelado.' }
    } finally {
      broadcastChatEvent({ type: 'ask:done', sessionId: target, requestId })
    }
  }
}
