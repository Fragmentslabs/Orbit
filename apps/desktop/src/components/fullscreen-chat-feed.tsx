import { type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { MessagesSquareIcon, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { ConversationBody } from "@/src/components/conversation-body"
import { FeedPinButton } from "@/src/components/dock-handle"
import { useEdgeHover } from "@/src/hooks/use-edge-hover"
import { useActiveSession, useSessionStatus, useSessionStore, type PendingAskUI } from "@/src/stores/session-store"
import { useWorkspaceMode } from "@/lib/workspace-context"
import { Hint } from "@/components/ui/hint"
import { Truncate } from "@/components/ui/truncated-text"

const NO_ASKS: PendingAskUI[] = []

/** Live conversation — panel collapsed on the left edge of the fullscreen screens
 *  (browser, Motion) and of the Computer Use panels. It shows the agent's streaming
 *  in real time. Without `sessionId`, it follows the active chat of the current
 *  workspace mode — the one the panel is showing, in any mode.
 *  `onHoverChange` warns when the mouse enters/leaves (the window of the
 *  Computer Use panels only captures clicks over them). */
export function FullscreenChatFeed({
  pinned,
  onTogglePin,
  sessionId: fixedSessionId,
  title,
  onHoverChange,
  footer,
  headerExtra,
  icon: FeedIcon = MessagesSquareIcon,
}: {
  pinned: boolean
  onTogglePin: () => void
  sessionId?: string
  title?: string
  onHoverChange?: (over: boolean) => void
  /** Below the conversation, when open (the compact input of the Computer Use panels) */
  footer?: ReactNode
  /** Extra controls in the header of the open feed (the artifact's chat selector…) */
  headerExtra?: ReactNode
  /** Icon of the feed (default: the conversation). An artifact's feed wears its kind's icon. */
  icon?: LucideIcon
}) {
  const { t } = useTranslation()
  const mode = useWorkspaceMode()
  const activeSession = useActiveSession(mode)
  const sessionId = fixedSessionId ?? activeSession?.id
  const status = useSessionStatus(sessionId)
  const pendingAsks = useSessionStore((s) => (sessionId ? s.pendingAsks[sessionId] ?? NO_ASKS : NO_ASKS))
  const isBusy = status === "submitted" || status === "streaming" || status === "cancelling" || status === "fallback"
  const { hovered, handleEnter, handleLeave } = useEdgeHover()
  const expanded = pinned || hovered
  const hasAsks = pendingAsks.length > 0

  return (
    <div
      onMouseEnter={() => {
        handleEnter()
        onHoverChange?.(true)
      }}
      onMouseLeave={() => {
        handleLeave()
        onHoverChange?.(false)
      }}
      className="pointer-events-auto absolute left-0 top-1/2 z-10 flex -translate-y-1/2 items-center"
    >
      <div
        className={cn(
          "flex flex-col overflow-hidden rounded-r-xl border border-l-0 bg-background/95 shadow-lg backdrop-blur transition-all duration-300 ease-out",
          expanded ? "h-[min(70vh,540px)] w-96" : "h-12 w-9",
        )}
      >
        {/* Handle: always visible; pulsing dot = agent active (green) or ask pending (amber) */}
        <Hint label={expanded ? t("browser.hideChatFeed") : t("browser.showChatFeed")}>
          <button
            type="button"
            onClick={onTogglePin}
            className="flex h-12 w-full shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
          >
            <span className="relative flex items-center justify-center">
              <FeedIcon className="size-4" />
              {(isBusy || hasAsks) && (
                <span className="absolute -right-1.5 -top-1.5 flex size-2">
                  <span
                    className={cn(
                      "absolute inline-flex size-full animate-ping rounded-full opacity-75",
                      hasAsks ? "bg-amber-500" : "bg-emerald-500",
                    )}
                  />
                  <span
                    className={cn("relative inline-flex size-2 rounded-full", hasAsks ? "bg-amber-500" : "bg-emerald-500")}
                  />
                </span>
              )}
            </span>
          </button>
        </Hint>
        {expanded && (
          <div className="flex min-h-0 flex-1 animate-in flex-col fade-in-0 duration-200">
            <div className="flex items-center gap-2 border-b px-3 py-2">
              <FeedIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <Truncate text={title ?? (fixedSessionId ? t("computer.panels.chat") : activeSession?.title) ?? t("browser.chatFeed")}>
                <span className="min-w-0 flex-1 truncate text-xs font-medium">
                  {title ?? (fixedSessionId ? t("computer.panels.chat") : activeSession?.title) ?? t("browser.chatFeed")}
                </span>
              </Truncate>
              {headerExtra}
              {isBusy && (
                <span className="flex shrink-0 items-center gap-1 text-[11px] text-emerald-500">
                  <span className="relative flex size-1.5">
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-75" />
                    <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
                  </span>
                  {t("chat.code.analyzing")}
                </span>
              )}
              <FeedPinButton pinned={pinned} onToggle={onTogglePin} />
            </div>
            <ConversationBody
              sessionId={sessionId}
              active={expanded}
              onAsk={() => {
                if (!pinned) onTogglePin()
              }}
              footer={footer}
            />
          </div>
        )}
      </div>
    </div>
  )
}

