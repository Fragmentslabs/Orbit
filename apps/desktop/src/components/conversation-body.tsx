import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import type { ChatMessage } from "@shared/chat"
import { Message, MessageContent } from "@/src/components/ai/message"
import { AskCard } from "@/src/components/ask-card"
import { AskCardBatch } from "@/src/components/ask-card-batch"
import { CodeAssistantMessage } from "@/src/components/messages/code-message"
import { UserMessageQuote, UserMessageText } from "@/src/components/messages/shared"
import { visibleMessageText } from "@/src/lib/message-utils"
import { useSessionStatus, useSessionStore, type PendingAskUI } from "@/src/stores/session-store"

/** Stable lists for the zustand selectors (they avoid a re-render for a new reference). */
const NO_MSGS: ChatMessage[] = []
const NO_ASKS: PendingAskUI[] = []

/**
 * The conversation itself — messages, pending asks and the footer — without any chrome. The
 * floating feed wraps it in its edge panel; a screen with its own sidebar (the Design
 * fullscreen) puts it in a tab. `active` says when it is on screen (it scrolls to the end on
 * opening); `onAsk` warns that a permission request or question arrived.
 */
export function ConversationBody({
  sessionId,
  active,
  onAsk,
  footer,
}: {
  sessionId?: string
  active: boolean
  onAsk?: () => void
  footer?: ReactNode
}) {
  const { t } = useTranslation()
  const messages = useSessionStore((s) => (sessionId ? s.messages[sessionId] ?? NO_MSGS : NO_MSGS))
  const status = useSessionStatus(sessionId)
  const pendingAsks = useSessionStore((s) => (sessionId ? s.pendingAsks[sessionId] ?? NO_ASKS : NO_ASKS))
  const isBusy = status === "submitted" || status === "streaming" || status === "cancelling" || status === "fallback"
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const hasAsks = pendingAsks.length > 0

  // Loads the session history (the fullscreen may open before the chat)
  useEffect(() => {
    if (sessionId) void useSessionStore.getState().ensureMessages(sessionId)
  }, [sessionId])

  // Renderable messages (ignores summaries) — basis for the virtualized window.
  const visibleMessages = useMemo(() => messages.filter((m) => !m.summary), [messages])

  // "Inverted" virtualization: it shows the window of the most recent ones and loads the
  // old ones in chunks as the user scrolls to the top (reverse infinite scroll).
  const MIN_WINDOW = 40
  const CHUNK = 40
  /** Estimated pixels per old message not rendered yet (top placeholder). */
  const OLDER_PX = 52
  const [startOffset, setStartOffset] = useState(0)
  const inited = useRef(false)
  const prevLength = useRef(visibleMessages.length)
  const prevExpanded = useRef(active)
  const rendered = visibleMessages.slice(startOffset)
  const hasOlder = startOffset > 0

  // On the first render, it anchors at the end: it shows only the MIN_WINDOW most recent ones.
  useEffect(() => {
    if (inited.current) return
    inited.current = true
    setStartOffset(Math.max(0, visibleMessages.length - MIN_WINDOW))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const scrollToBottom = () => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  // On opening (hover/pin), it positions at the end to show the most recent messages.
  useEffect(() => {
    if (active && !prevExpanded.current) scrollToBottom()
    prevExpanded.current = active
    // Only the opening matters here — scrollToBottom is stable.
  }, [active])

  // Auto-scroll: new messages / streaming deltas / asks change the list
  useEffect(() => {
    if (visibleMessages.length > prevLength.current) scrollToBottom()
    prevLength.current = visibleMessages.length
    // It depends on the length, not on the list identity (which changes on every delta).
  }, [visibleMessages.length])

  // Loads a chunk of old messages, preserving the scroll position.
  const loadOlder = useCallback(() => {
    const el = scrollRef.current
    if (!el || startOffset <= 0) return
    const prevHeight = el.scrollHeight
    setStartOffset((s) => Math.max(0, s - CHUNK))
    requestAnimationFrame(() => {
      // Compensates the height added at the top so the viewport does not "jump".
      if (el) el.scrollTop += el.scrollHeight - prevHeight
    })
  }, [startOffset, CHUNK])

  // On getting near the top, it expands the window to the older ones.
  const handleScroll = () => {
    const el = scrollRef.current
    if (!el || startOffset <= 0) return
    if (el.scrollTop < 60) loadOlder()
  }

  // Auto-expands (pins) when a new permission request/question arrives,
  // so the user can answer without leaving fullscreen
  const prevAsks = useRef(0)
  useEffect(() => {
    if (pendingAsks.length > prevAsks.current && pendingAsks.length > 0) onAsk?.()
    prevAsks.current = pendingAsks.length
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAsks.length])

  const lastAssistantId = useMemo(() => {
    const last = [...messages].reverse().find((m) => m.role === "assistant" && !m.summary)
    return last?.id
  }, [messages])

  return (
    <>
      <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto p-3">
        {messages.length === 0 && !hasAsks ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">{t("browser.emptyConversation")}</p>
        ) : (
          <div className="flex flex-col">
            {/* Placeholder of old messages not loaded yet —
                on scrolling to the top, `loadOlder` materializes them in chunks. */}
            {hasOlder && (
              <div
                aria-hidden
                className="pointer-events-none flex w-full items-center justify-center py-2 text-[10px] uppercase tracking-wide text-muted-foreground/60"
                style={{ height: startOffset * OLDER_PX }}
              >
                {t("browser.loadingOlder")}
              </div>
            )}
            <div className="flex flex-col gap-3">
            {rendered.map((msg) => {
              if (msg.summary) return null
              if (msg.role === "user") {
                return (
                  <Message from="user" key={msg.id} data-msg-id={msg.id}>
                    {/* Same as the main chat: the quote of the replied message
                        comes out as a pill above the bubble (never as raw
                        text, `> [assistant] …`). */}
                    <UserMessageQuote text={visibleMessageText(msg)} />
                    <MessageContent>
                      <div className="text-sm">
                        <UserMessageText text={visibleMessageText(msg)} />
                      </div>
                    </MessageContent>
                  </Message>
                )
              }
              const isLast = msg.id === lastAssistantId
              return (
                <Message from="assistant" key={msg.id} data-msg-id={msg.id}>
                  <MessageContent>
                    <CodeAssistantMessage message={msg} sessionId={sessionId} isLast={isLast} isBusy={isBusy} />
                  </MessageContent>
                </Message>
              )
            })}
            {/* Tool permission requests / questions waiting for an answer —
                same behavior as the code chat (chat-view). */}
            {hasAsks && (
              <div className="flex flex-col gap-2 border-t pt-2">
                {pendingAsks
                  .filter((a) => !a.batchId)
                  .map((ask) => (
                    <AskCard key={ask.requestId} ask={ask} sessionId={sessionId} />
                  ))}
                {[...new Set(pendingAsks.map((a) => a.batchId).filter(Boolean))].map((batchId) => (
                  <AskCardBatch key={batchId} items={pendingAsks.filter((a) => a.batchId === batchId)} />
                ))}
              </div>
            )}
          </div>
          </div>
        )}
      </div>
      {footer && <div className="shrink-0 border-t px-3 py-2">{footer}</div>}
    </>
  )
}

