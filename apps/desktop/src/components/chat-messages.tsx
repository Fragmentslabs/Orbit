import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useStickToBottomContext, type StickToBottomContext } from "use-stick-to-bottom"
import { useTranslation } from "react-i18next"
import type { ChatMessage, OrchestrationPlan, PlanReview } from "@shared/chat"
import { cn } from "@/lib/utils"
import { UserMessageNav } from "@/src/components/user-message-nav"
import { Conversation, ConversationContent, ConversationScrollButton } from "@/src/components/ai/conversation"
import { MessageItem } from "@/src/components/messages/message-item"
import { SummaryCard } from "@/src/components/messages/summary-card"
import { TaskProgress } from "@/src/components/task-progress"
import { PlanReviewCard, localPlanActions, type PlanReviewActions } from "@/src/components/plan-review-card"
import { MessageReplySelection } from "@/src/components/message-reply-selection"
import { DateSeparator, isNewDay } from "@/src/components/messages/date-separator"
import { ErrorBoundary } from "@/src/components/error-boundary"
import { messageBody } from "@/src/lib/message-utils"
import { PAGE_TURNS, defaultWindowStart, turnStart, windowStartFor } from "@/src/lib/message-window"
import { registerMessageRevealer, revealMessage } from "@/src/lib/message-jump"
import type { SendConfig } from "@/src/stores/session-store"

function BrokenMessage({ error }: { error: Error }) {
  const { t } = useTranslation()
  return (
    <div className="my-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs">
      <p className="font-medium text-destructive">{t("chat.brokenMessage")}</p>
      <p className="mt-1 break-words font-mono text-[11px] text-muted-foreground">{error.message}</p>
    </div>
  )
}

/**
 * Top of the message window: mounts the earlier turns when the person
 * scrolls close to it. It only reacts after they left the end of the conversation — when
 * opening the chat the top is on screen before the initial scroll goes down, and
 * loading there would mount the whole history, which is what the window avoids.
 * It also loads when the window does not even fill the screen (there is nothing to scroll).
 */
function EarlierMessages({ hiddenCount, onLoad, paused }: {
  /** Unknown (undefined) when the rest of the history is still on another machine. */
  hiddenCount?: number
  onLoad: () => void
  /** During a jump to a message: loading here would disturb the scroll in the middle
   *  of the scroll to the target. */
  paused: () => boolean
}) {
  const { t } = useTranslation()
  const { scrollRef, isAtBottom } = useStickToBottomContext()
  const ref = useRef<HTMLButtonElement>(null)
  const isAtBottomRef = useRef(isAtBottom)
  isAtBottomRef.current = isAtBottom
  const onLoadRef = useRef(onLoad)
  onLoadRef.current = onLoad
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  useEffect(() => {
    const scroller = scrollRef.current
    const el = ref.current
    if (!scroller || !el) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting || pausedRef.current()) return
        const fills = scroller.scrollHeight > scroller.clientHeight + 1
        if (!fills || !isAtBottomRef.current) onLoadRef.current()
      },
      { root: scroller, rootMargin: "600px 0px 0px 0px" },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [scrollRef])

  return (
    <button
      ref={ref}
      type="button"
      onClick={onLoad}
      className="mx-auto rounded-full px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {hiddenCount === undefined ? t("chat.earlierMessagesMore") : t("chat.earlierMessages", { count: hiddenCount })}
    </button>
  )
}

export function ChatMessages({ messages, historyPending, isBusy, busyLabel, mode, sessionId, sendMessage, planIds, planReview, planActions, plan, footer, underVeil, dateVariant = "pill", olderRemote }: {
  messages: ChatMessage[]
  /** The session history has not arrived from disk yet. */
  historyPending: boolean
  isBusy: boolean
  busyLabel?: string
  mode: "chat" | "code"
  sessionId?: string
  /** There is a veil at the top (persona visible): only then can the conversation rise under
   *  it. Without the veil, raising the conversation puts it over the header, which is
   *  transparent on purpose (the persona overflows into it). */
  underVeil?: boolean
  sendMessage: (mode: "chat" | "code", text: string, config: SendConfig) => Promise<void>
  planIds: Set<string>
  planReview: PlanReview | undefined
  plan?: OrchestrationPlan | undefined
  /** Who answers the plan card's buttons when the chat is not on this machine. */
  planActions?: PlanReviewActions
  /** Pages of history still on the other machine, beyond what is loaded. */
  olderRemote?: { onLoad: () => void }
  /** Cards that belong to the conversation (agent request, revert, orchestration)
   *  and therefore scroll with it, instead of taking the fixed strip above the input. */
  footer?: ReactNode
  /** Date marker between days: the quiet line of the routine chat, or the usual pill. */
  dateVariant?: "pill" | "line"
}) {
  const { t } = useTranslation()
  const lastAssistantId = [...messages].reverse().find((m) => m.role === "assistant" && !m.summary)?.id

  const userMsgItems = useMemo(
    () =>
      messages
        .filter((m) => m.role === "user")
        .map((m) => ({ id: m.id, text: messageBody(m), time: m.createdAt })),
    [messages],
  )

  // ── Window: only the last turns stay mounted (see message-window.ts) ──
  // Keyed by the ID of the first message, not by the index: new messages
  // arrive at the end and cannot shift the window. It stays fixed once defined
  // (the growing chat does not unmount what is above); switching session or the
  // message disappearing (revert, compaction) returns to the default.
  const [windowState, setWindowState] = useState<{ sessionId?: string; startId: string | null }>({
    sessionId,
    startId: null,
  })
  // State updates during render (derived state): React
  // discards this render and redoes it with the new value, without going through the DOM.
  const sameSession = windowState.sessionId === sessionId
  if (!sameSession) setWindowState({ sessionId, startId: null })
  let startIndex = 0
  if (messages.length > 0) {
    const saved = sameSession ? windowState.startId : null
    const savedIndex = saved ? messages.findIndex((m) => m.id === saved) : -1
    startIndex = savedIndex >= 0 ? savedIndex : defaultWindowStart(messages)
    if (savedIndex < 0) setWindowState({ sessionId, startId: messages[startIndex].id })
  }
  const visibleMessages = startIndex > 0 ? messages.slice(startIndex) : messages

  const stickRef = useRef<StickToBottomContext>(null)
  /** Scroll measurements before mounting turns above — to keep on screen what
   *  the person was reading when the content grows on top. */
  const anchorRef = useRef<{ height: number; top: number } | null>(null)
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const startIndexRef = useRef(startIndex)
  startIndexRef.current = startIndex
  /** Until when the automatic loading of the top stays halted (jump in progress). */
  const jumpUntilRef = useRef(0)
  const autoLoadPaused = useCallback(() => Date.now() < jumpUntilRef.current, [])

  const loadEarlier = useCallback(() => {
    const current = startIndexRef.current
    if (current <= 0) return
    const scroller = stickRef.current?.scrollRef.current
    if (scroller) anchorRef.current = { height: scroller.scrollHeight, top: scroller.scrollTop }
    const list = messagesRef.current
    setWindowState({ sessionId, startId: list[turnStart(list, current, PAGE_TURNS)].id })
  }, [sessionId])

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const scroller = stickRef.current?.scrollRef.current
    if (!anchor || !scroller) return
    anchorRef.current = null
    // Chromium may already have compensated by itself (scroll anchoring); it only touches
    // it if the position is not the expected one.
    const expected = anchor.top + (scroller.scrollHeight - anchor.height)
    if (Math.abs(scroller.scrollTop - expected) > 1) scroller.scrollTop = expected
  }, [startIndex])

  // Opens at the end BEFORE the first frame: StickToBottom only goes down in a
  // requestAnimationFrame, and until then the chat appeared at the top for an instant.
  // Runs when the conversation mounts (session switch or history that arrived).
  useLayoutEffect(() => {
    if (historyPending) return
    const scroller = stickRef.current?.scrollRef.current
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  }, [sessionId, historyPending])

  // The chat area also changes height without the content changing: the header
  // persona enters with the veil (the chat shrinks ~64px), the text field grows,
  // a card appears above the input. StickToBottom only observes the content,
  // so in those cases the end of the conversation stayed hidden underneath. Stuck to the
  // end before the change, it stays stuck after it.
  useEffect(() => {
    if (historyPending) return
    const scroller = stickRef.current?.scrollRef.current
    if (!scroller) return
    let lastHeight = scroller.clientHeight
    const observer = new ResizeObserver(() => {
      const height = scroller.clientHeight
      if (height === lastHeight) return
      const gapBefore = scroller.scrollHeight - scroller.scrollTop - lastHeight
      lastHeight = height
      if (stickRef.current?.isAtBottom || gapBefore <= 2) scroller.scrollTop = scroller.scrollHeight
    })
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [sessionId, historyPending])

  // Jump to a message outside the window (search, browser, gallery):
  // extends the window up to its turn. stopScroll releases the end lock —
  // otherwise the new content above would pull the conversation back
  // down while the search tries to scroll to the message.
  useEffect(() => {
    return registerMessageRevealer((messageId) => {
      const list = messagesRef.current
      const index = list.findIndex((m) => m.id === messageId)
      if (index < 0) return false
      if (index < startIndexRef.current) {
        stickRef.current?.stopScroll()
        jumpUntilRef.current = Date.now() + 1500
        // Extra turns above the target: the top of the window stays far from it, and
        // scrolling a little up after the jump does not hit the limit.
        const start = turnStart(list, windowStartFor(list, index), PAGE_TURNS)
        setWindowState({ sessionId, startId: list[start].id })
      }
      return true
    })
  }, [sessionId])

  const [activeUserMsgId, setActiveUserMsgId] = useState<string | null>(null)
  const observerRef = useRef<IntersectionObserver | null>(null)
  const ratioMapRef = useRef<Map<string, number>>(new Map())

  useEffect(() => {
    const ids = userMsgItems.map((i) => i.id)
    const key = ids.join(",")
    if (!key) return

    const ratioMap = ratioMapRef.current
    ratioMap.clear()

    if (observerRef.current) observerRef.current.disconnect()

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.getAttribute("data-user-msg-id")
          if (id) ratioMap.set(id, entry.intersectionRatio)
        }
        let maxId: string | null = null
        let maxRatio = 0
        for (const [id, ratio] of ratioMap) {
          if (ratio > maxRatio) {
            maxRatio = ratio
            maxId = id
          }
        }
        setActiveUserMsgId(maxId)
      },
      { threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] },
    )

    observerRef.current = observer

    const els = document.querySelectorAll<HTMLElement>("[data-user-msg-id]")
    for (const el of els) observer.observe(el)

    return () => observer.disconnect()
    // Re-observes when the window grows: the questions just mounted at the top
    // also count for the browser highlight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userMsgItems.map((i) => i.id).join(","), startIndex])

  const handleNavSelect = useCallback(async (id: string) => {
    const el = await revealMessage(id)
    if (!el) return
    // Scrolls the real scroll container (StickToBottom's inner div), which sits
    // under an ancestor with overflow-y-hidden — scrollIntoView does not always scroll
    // the right container in this structure.
    let scroller = el.parentElement
    while (scroller) {
      const overflowY = getComputedStyle(scroller).overflowY
      if (overflowY === "auto" || overflowY === "scroll") break
      scroller = scroller.parentElement
    }
    if (!scroller) return
    const containerRect = scroller.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    const target =
      scroller.scrollTop +
      (elRect.top - containerRect.top) -
      (scroller.clientHeight - elRect.height) / 2
    const max = scroller.scrollHeight - scroller.clientHeight
    scroller.scrollTo({ top: Math.max(0, Math.min(target, max)), behavior: "smooth" })
  }, [])

  // Without the history, the conversation does not mount. Mounted empty, the first measurement
  // of StickToBottom (the one that scrolls without animating) was spent on the empty list, and the
  // history arriving later became "content grew": the smooth spring went down
  // the whole chat from the top to the end, in plain sight.
  if (historyPending) return <div className="relative flex-1" />

  return (
    // initial="instant": the chat opens already at the end, without scrolling through everything to get there.
    <Conversation key={sessionId ?? "no-session"} contextRef={stickRef} initial="instant" className={cn("relative flex-1", underVeil && "-mt-10")}>
      <ConversationContent className="mx-auto w-full max-w-3xl">
        {startIndex > 0 && (
          // key by the window: every load remounts the observer, which re-evaluates on
          // the spot whether the top is still near (fast scrolling asks for more than one)
          <EarlierMessages key={messages[startIndex].id} hiddenCount={startIndex} onLoad={loadEarlier} paused={autoLoadPaused} />
        )}
        {startIndex === 0 && olderRemote && (
          <EarlierMessages key="remote-older" onLoad={olderRemote.onLoad} paused={autoLoadPaused} />
        )}
        {visibleMessages.map((msg, visibleIndex) => {
          // Index in the whole history: the date separator and the retry look at the
          // real previous message, mounted or not.
          const index = startIndex + visibleIndex
          const showSeparator = isNewDay(messages[index - 1]?.createdAt, msg.createdAt)

          if (msg.summary) {
            return (
              <div key={msg.id}>
                {showSeparator && <DateSeparator timestamp={msg.createdAt} variant={dateVariant} />}
                <SummaryCard message={msg} />
              </div>
            )
          }

          const isLast = msg.id === lastAssistantId
          const finished = msg.role !== "assistant" || !(isLast && isBusy)
          const waiting = msg.role === "assistant" && isLast && isBusy && msg.parts.length === 0

          return (
            <div key={msg.id}>
              {showSeparator && <DateSeparator timestamp={msg.createdAt} variant={dateVariant} />}
              {/* A message the renderer does not know how to draw — usually
                  data recorded by a previous version — becomes a notice in
                  its place. Before, it erased the whole conversation. */}
              <ErrorBoundary
                label={`message ${msg.id}`}
                resetKeys={[msg]}
                fallback={(error) => <BrokenMessage error={error} />}
              >
                <MessageItem
                  msg={msg}
                  isLast={isLast}
                  waiting={waiting}
                  finished={finished}
                  isBusy={isBusy}
                  busyLabel={busyLabel}
                  mode={mode}
                  sessionId={sessionId}
                  sendMessage={sendMessage}
                  messages={messages}
                  index={index}
                />
              </ErrorBoundary>
            </div>
          )
        })}
        {planReview && planReview.status === "proposed" && sessionId && (
          // max-w-2xl to align with the input: the conversation is max-w-3xl, and the
          // card was wider than the message box right below it.
          <div className="mx-auto w-full max-w-2xl px-1">
            <PlanReviewCard sessionId={sessionId} review={planReview} actions={planActions} />
          </div>
        )}
        {planReview && planReview.status === "implementing" && sessionId && !plan && (
          <div className="px-1">
            <TaskProgress
              tasks={[{ id: "plan", title: t("chat.implementPlan"), status: isBusy ? "streaming" : "idle" }]}
              title={t("chat.planTitle")}
              onDismiss={() => (planActions ?? localPlanActions(sessionId)).dismiss()}
            />
          </div>
        )}
        {footer}
      </ConversationContent>
      <ConversationScrollButton />
      <UserMessageNav items={userMsgItems} activeId={activeUserMsgId} onSelect={handleNavSelect} planIds={planIds} />
      {/* Select an excerpt and reply only to it — inside the Conversation
          because it is its scroll element that delimits the valid area. */}
      <MessageReplySelection sessionId={sessionId} />
    </Conversation>
  )
}

