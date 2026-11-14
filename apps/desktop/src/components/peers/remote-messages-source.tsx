import { useCallback, useMemo, type ComponentProps } from "react"
import { useTranslation } from "react-i18next"
import type { PermissionMode } from "@shared/chat"
import { parseRemoteSessionId } from "@shared/peers"
import { OrchestrationPlanCard } from "@/src/components/orchestration-plan-card"
import type { ChatMessages } from "@/src/components/chat-messages"
import type { PlanReviewActions } from "@/src/components/plan-review-card"
import { peersApi } from "@/src/lib/ipc"
import { isRemoteRunning, usePeersStore } from "@/src/stores/peers-store"

type MessagesProps = ComponentProps<typeof ChatMessages>

/**
 * The remote chat as the props of the app's `ChatMessages`.
 *
 * Everything the list draws — date separators, summary cards, the scroll button, the
 * earlier-messages window, the user's bubble with copy/reply, the busy and fallback
 * labels — is the local conversation's own; this hook only says where the data comes
 * from (peers-store) and who answers the buttons (the machine that runs the agent).
 *
 * Revert, fork and approvals stay on that machine on purpose; the revert action hides
 * itself for a namespaced id.
 */
export function useRemoteMessagesSource(sessionId: string, mode: "chat" | "code"): MessagesProps {
  const { t } = useTranslation()
  const messages = usePeersStore((s) => s.messages[sessionId])
  const loading = usePeersStore((s) => !!s.loading[sessionId])
  const status = usePeersStore((s) => s.statuses[sessionId])
  const planReview = usePeersStore((s) => s.planReviews[sessionId])
  const plan = usePeersStore((s) => s.orchestration[sessionId])
  const exhausted = usePeersStore((s) => !!s.historyExhausted[sessionId])
  const send = usePeersStore((s) => s.send)
  const loadOlder = usePeersStore((s) => s.loadOlder)
  const dismissPlanReview = usePeersStore((s) => s.dismissPlanReview)
  const fallback = usePeersStore((s) => s.fallback[sessionId])

  const target = parseRemoteSessionId(sessionId)
  const ask = useCallback(
    (payload: { type: string; [key: string]: unknown }) => {
      if (target) void peersApi.request(target.peerId, { ...payload, sessionId: target.sessionId }).catch(() => {})
    },
    [target?.peerId, target?.sessionId], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const planActions = useMemo<PlanReviewActions>(
    () => ({
      accept: (permissionMode: PermissionMode, orchestrate) =>
        ask({ type: "plan:review-accept", messageId: planReview?.messageId, permissionMode, orchestrate }),
      reject: () => ask({ type: "plan:review-reject" }),
      review: (feedback) =>
        ask({ type: "plan:review-revise", messageId: planReview?.messageId, permissionMode: planReview?.permissionMode ?? "ask", feedback }),
      dismiss: () => dismissPlanReview(sessionId),
    }),
    [ask, planReview?.messageId, planReview?.permissionMode, dismissPlanReview, sessionId],
  )

  // The messages that opened a plan card: the user's navigation marks them like at home.
  const planIds = useMemo(() => {
    const ids = new Set<string>()
    if (planReview && (planReview.status === "proposed" || planReview.status === "implementing") && planReview.messageId) {
      ids.add(planReview.messageId)
    }
    return ids
  }, [planReview])

  const footer = plan ? (
    <div className="mx-auto w-full max-w-2xl px-1">
      <OrchestrationPlanCard
        sessionId={sessionId}
        plan={plan}
        actions={{
          approve: (planId, taskIds) => ask({ type: "orchestration:approve", planId, taskIds }),
          reject: () => ask({ type: "orchestration:reject" }),
        }}
      />
    </div>
  ) : null

  return {
    messages: messages ?? [],
    historyPending: loading && !messages,
    isBusy: isRemoteRunning(status),
    busyLabel:
      status === "fallback" && fallback
        ? t(fallback.retry ? "chat.retryingStatus" : "chat.fallbackStatus", { current: fallback.current, total: fallback.total })
        : undefined,
    mode,
    sessionId,
    // A retry re-sends the text as a new turn there: the other machine does not take `retryOf`.
    sendMessage: async (_mode, text) => {
      await send(sessionId, text)
    },
    planIds,
    planReview,
    planActions,
    plan,
    footer,
    olderRemote: exhausted || !messages?.length ? undefined : { onLoad: () => void loadOlder(sessionId) },
  }
}
