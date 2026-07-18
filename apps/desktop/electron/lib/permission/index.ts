import type { PermissionDecision, PermissionMode } from '@shared/chat'
import { newRequestId } from '../ask-broker'
import { dispatchAsk } from '../ask-dispatch'
import { broadcastChatEvent } from '../broadcast'
import { assess, isForbidden } from './rules'
import { checkTrust, addTrust } from './trust-rules'

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

const sessionTrust = new Map<string, Set<string>>()

export function clearSessionTrust(sessionId: string): void {
  sessionTrust.delete(sessionId)
}

export function createToolApproval(
  mode: PermissionMode,
  sessionId: string,
  dir: string | null,
  signal?: AbortSignal,
  parentSessionId?: string,
  workerTitle?: string,
) {
  return async ({ toolCall }: { toolCall: ApprovalToolCall }) => {
    if (isForbidden(toolCall.toolName, toolCall.input, dir)) {
      denialReasons.set(toolCall.toolCallId, 'Ação bloqueada pela política de segurança.')
      return { type: 'denied' as const, reason: 'Esta ação é bloqueada pela política de segurança. Busque uma alternativa segura.' }
    }

    const assessment = assess(toolCall.toolName, toolCall.input, dir)
    if (!assessment) return 'approved' as const

    if (mode === 'full') return 'approved' as const

    const ruleId = assessment.ruleId

    if (checkTrust(ruleId)) return 'approved' as const

    const targetSession = sessionTrust.get(sessionId)
    if (targetSession?.has(ruleId)) return 'approved' as const

    const requestId = newRequestId()
    const isWorker = !!parentSessionId
    const target = isWorker ? parentSessionId! : sessionId

    try {
      const reply = await dispatchAsk<PermissionDecision>(
        target,
        {
          requestId,
          kind: 'permission',
          claim: assessment.claim,
          origin: isWorker
            ? { workerSessionId: sessionId, workerTitle: workerTitle ?? 'worker' }
            : undefined,
        },
        signal,
      )

      if (reply === 'always_chat') {
        const set = sessionTrust.get(sessionId) ?? new Set<string>()
        set.add(ruleId)
        sessionTrust.set(sessionId, set)
        return 'approved' as const
      }

      if (reply === 'always') {
        await addTrust(ruleId)
        const set = sessionTrust.get(sessionId) ?? new Set<string>()
        set.add(ruleId)
        sessionTrust.set(sessionId, set)
        return 'approved' as const
      }

      if (reply === 'allow') return 'approved' as const

      denialReasons.set(toolCall.toolCallId, 'Negado pelo usuário.')
      return {
        type: 'denied' as const,
        reason: 'O usuário negou esta ação. Não a repita — siga por outro caminho ou pergunte.',
      }
    } catch {
      denialReasons.set(toolCall.toolCallId, 'Pedido de permissão cancelado.')
      return { type: 'denied' as const, reason: 'O pedido de permissão foi cancelado.' }
    } finally {
      broadcastChatEvent({ type: 'ask:done', sessionId: target, requestId })
    }
  }
}
