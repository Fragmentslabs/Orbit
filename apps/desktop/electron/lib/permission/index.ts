import type { PermissionDecision, PermissionMode } from '@shared/chat'
import { newRequestId } from '../ask-broker'
import { dispatchAsk } from '../ask-dispatch'
import { broadcastChatEvent } from '../broadcast'
import { getMcpPermissionMode } from '../mcp'
import { runPreToolHooks } from '../hooks/run'
import { approvalCount, forgetApprovals, noteApproval, SUGGEST_AFTER } from './learning'
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

/**
 * Resolves the effective permission mode: MCP servers can have their own
 * override via permissionMode in the config, independent of the global mode.
 */
function effectiveMode(toolName: string, globalMode: PermissionMode): PermissionMode {
  return getMcpPermissionMode(toolName) ?? globalMode
}

export function createToolApproval(
  /** Fixed, or consulted on every tool (a turn that follows the global selector) */
  mode: PermissionMode | (() => PermissionMode),
  sessionId: string,
  dir: string | null,
  assistantMessageId: string,
  signal?: AbortSignal,
  parentSessionId?: string,
  workerTitle?: string,
) {
  // "Allow" holds for the TURN, not per call: the gate is born with the turn,
  // and a rule approved here does not ask again until it ends. Before, it was
  // only this once — the agent asked the same permission on every tool (in
  // Computer Use, on every click in the same app).
  const turnTrust = new Set<string>()

  return async ({ toolCall }: { toolCall: ApprovalToolCall }) => {
    if (isForbidden(toolCall.toolName, toolCall.input, dir)) {
      denialReasons.set(toolCall.toolCallId, 'Action blocked by the security policy.')
      return { type: 'denied' as const, reason: 'This action is blocked by the security policy. Look for a safe alternative.' }
    }

    // The user's own pre_tool_call hooks, in every permission mode: "full" is about
    // what Orbit asks, not about the rules the user wrote for their project.
    const hookVerdict = await runPreToolHooks({ toolName: toolCall.toolName, input: toolCall.input, sessionId, directory: dir })
    if (hookVerdict) {
      denialReasons.set(toolCall.toolCallId, `Blocked by a hook: ${hookVerdict}`)
      return { type: 'denied' as const, reason: `A pre_tool_call hook of the user blocked this call: ${hookVerdict}` }
    }

    const assessment = assess(toolCall.toolName, toolCall.input, dir)
    if (!assessment) return 'approved' as const

    const mcpMode = effectiveMode(toolCall.toolName, typeof mode === 'function' ? mode() : mode)
    if (mcpMode === 'full' && !assessment.alwaysAsk) return 'approved' as const

    const ruleId = assessment.ruleId
    // How many times the user already allowed this same rule, before this request.
    // An action that always asks is not counted: the count would never change anything.
    const prior = assessment.alwaysAsk ? 0 : approvalCount(ruleId)

    if (!assessment.alwaysAsk && checkTrust(ruleId)) return 'approved' as const
    if (!assessment.alwaysAsk && turnTrust.has(ruleId)) return 'approved' as const

    const targetSession = sessionTrust.get(sessionId)
    if (!assessment.alwaysAsk && targetSession?.has(ruleId)) return 'approved' as const

    const requestId = newRequestId()
    const isWorker = !!parentSessionId
    const target = isWorker ? parentSessionId! : sessionId

    try {
      const reply = await dispatchAsk<PermissionDecision>(
        target,
        {
          requestId,
          kind: 'permission',
          claim: {
            ...assessment.claim,
            ...(assessment.alwaysAsk ? { alwaysAsk: true } : {}),
            // "You already allowed this N times": what turns the arrow next to
            // "Allow once" into something worth opening. Never for an action that
            // asks on purpose (alwaysAsk) — there the suggestion would be a lie.
            ...(prior >= SUGGEST_AFTER ? { learned: { count: prior } } : {}),
          },
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
        if (!assessment.alwaysAsk) void noteApproval(ruleId, assessment.claim.title)
        return 'approved' as const
      }

      if (reply === 'always') {
        await addTrust(ruleId, assessment.claim.title)
        // Settled: the counter belongs to what is still being asked.
        await forgetApprovals(ruleId)
        const set = sessionTrust.get(sessionId) ?? new Set<string>()
        set.add(ruleId)
        sessionTrust.set(sessionId, set)
        return 'approved' as const
      }

      if (reply === 'allow') {
        // An action that always asks (e.g. removing a worktree) still goes one by one.
        if (!assessment.alwaysAsk) {
          turnTrust.add(ruleId)
          // "Allow once" is the approval that repeats most — counting only the
          // permanent choices would hide exactly the case worth suggesting.
          void noteApproval(ruleId, assessment.claim.title)
        }
        return 'approved' as const
      }

      denialReasons.set(toolCall.toolCallId, 'Denied by the user.')

      // Emits part:error directly to make sure mobile (and desktop)
      // update the tool part to error, regardless of the SDK emitting
      // tool-output-denied in the fullStream
      broadcastChatEvent({
        type: 'part',
        sessionId: target,
        messageId: assistantMessageId,
        part: {
          id: toolCall.toolCallId,
          type: 'tool',
          tool: toolCall.toolName,
          state: 'error',
          input: toolCall.input as Record<string, unknown> | undefined,
          error: 'Denied by the user.',
        },
      })

      return {
        type: 'denied' as const,
        reason: 'The user denied this action. Do not repeat it — take another route or ask.',
      }
    } catch {
      denialReasons.set(toolCall.toolCallId, 'Permission request canceled.')
      return { type: 'denied' as const, reason: 'The permission request was canceled.' }
    } finally {
      broadcastChatEvent({ type: 'ask:done', sessionId: target, requestId })
    }
  }
}
