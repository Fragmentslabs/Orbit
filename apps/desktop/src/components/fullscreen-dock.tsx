import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { CheckIcon, Loader2Icon, MessagesSquareIcon, PinIcon, PinOffIcon, XIcon, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ChatMessage, FilePart, SendMessageOptions, ToolPart } from "@shared/chat"
import { ConversationBody } from "@/src/components/conversation-body"
import { CodeInput } from "@/src/components/code-input"
import { useActiveSession, useSessionStatus, useSessionStore, type PendingAskUI } from "@/src/stores/session-store"
import { useWorkspaceMode } from "@/lib/workspace-context"
import { Hint } from "@/components/ui/hint"
import { Truncate } from "@/components/ui/truncated-text"

/**
 * Shared pieces of the fullscreen screens (browser, Motion and Design): the composer
 * that only appears on the hover of the bottom edge and the floating sidebars that
 * copy the look of the app's standard sidebar.
 */

/** Hover delays of the fullscreen bars — same convention as the app
 *  sidebar (App.tsx: SIDEBAR_SHOW_DELAY=100 / SIDEBAR_HIDE_DELAY=300). */
const EDGE_SHOW_DELAY = 100
const EDGE_HIDE_DELAY = 300

/** Hover with symmetric delay: it opens fast (100ms) when touching the edge and closes
 *  with slack (300ms) on leaving — it avoids expanding when crossing the edge in passing and
 *  collapsing when moving the mouse to the page. */
export function useEdgeHover() {
  const [hovered, setHovered] = useState(false)
  const showTimer = useRef<ReturnType<typeof setTimeout>>()
  const hideTimer = useRef<ReturnType<typeof setTimeout>>()
  const handleEnter = useCallback(() => {
    clearTimeout(hideTimer.current)
    showTimer.current = setTimeout(() => setHovered(true), EDGE_SHOW_DELAY)
  }, [])
  const handleLeave = useCallback(() => {
    clearTimeout(showTimer.current)
    hideTimer.current = setTimeout(() => setHovered(false), EDGE_HIDE_DELAY)
  }, [])
  useEffect(
    () => () => {
      clearTimeout(showTimer.current)
      clearTimeout(hideTimer.current)
    },
    [],
  )
  return { hovered, handleEnter, handleLeave }
}

/**
 * Fullscreen composer: it is the SAME input as the code chat (CodeInput) — with
 * model, permission mode, toggles, "/" commands, attachments and the selected
 * element badges. Before it was its own textarea, which kept falling behind
 * with every new feature of the main input.
 *
 * Collapsed by default: only the handle on the bottom edge stays visible. The hover on the
 * bottom part opens the composer; "pinning" keeps it open. The outer container
 * does not capture the mouse (pointer-events-none) — only the panel, so the hover does not
 * fire in the page area above it.
 */
export function FullscreenComposer({
  pinned,
  onTogglePin,
  onSent,
  fromBrowser = false,
  sessionId: fixedSessionId,
}: {
  pinned: boolean
  onTogglePin: () => void
  onSent?: () => void
  /** Request made from the browser itself: the agent can use it even with the
   *  browser tools turned off in Preferences. */
  fromBrowser?: boolean
  /** Conversation this fullscreen belongs to — the chat of the panel it was opened
   *  from, whatever its mode. Without it, the active chat of the current workspace. */
  sessionId?: string
}) {
  const { t } = useTranslation()
  const mode = useWorkspaceMode()
  const { hovered, handleEnter, handleLeave } = useEdgeHover()
  const expanded = pinned || hovered
  const activeSession = useActiveSession(mode)
  const sessionId = fixedSessionId ?? activeSession?.id
  // The mode goes with the SESSION, not with the screen: a fullscreen opened over a
  // chat-mode conversation answers in THAT conversation instead of the code chat.
  const sessionMode = useSessionStore((s) => (sessionId ? s.sessions.find((x) => x.id === sessionId)?.mode : undefined))
  const sendMode = sessionMode ?? mode
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const stopStreaming = useSessionStore((s) => s.stopStreaming)
  const status = useSessionStatus(sessionId)
  const messages = useSessionStore((s) => (sessionId ? s.messages[sessionId] ?? NO_MSGS : NO_MSGS))

  const handleSubmit = useCallback(
    (
      text: string,
      options: SendMessageOptions,
      directory: string,
      extraDirectories: string[],
      files?: FilePart[],
    ) => {
      void sendMessage(sendMode, text, {
        options: fromBrowser ? { ...options, fromBrowser: true } : options,
        directory,
        extraDirectories,
        sessionId,
        files,
      })
      onSent?.()
    },
    [sendMessage, sendMode, sessionId, onSent, fromBrowser],
  )

  const handleStop = useCallback(() => {
    if (sessionId) stopStreaming(sessionId)
  }, [sessionId, stopStreaming])

  return (
    <div
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-4"
    >
      <div
        className={cn(
          "pointer-events-auto w-full max-w-2xl rounded-t-xl border border-b-0 bg-background/95 shadow-lg backdrop-blur transition-transform duration-300 ease-out",
          // The handle (h-7) is what stays visible when collapsed
          expanded ? "translate-y-0" : "translate-y-[calc(100%-1.75rem)]",
        )}
      >
        <div className="relative flex h-7 items-center justify-center">
          <span className="h-1 w-10 rounded-full bg-muted-foreground/40" />
          <Hint label={pinned ? t("browser.unpinFeed") : t("browser.pinFeed")}>
            <button
              type="button"
              onClick={onTogglePin}
              className={cn(
                "absolute right-2 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground",
                pinned && "text-primary hover:text-primary",
              )}
            >
       
               {pinned ? <PinOffIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}
          </button>
          </Hint>
        </div>
        {/* Its own opaque background: the CodeInput InputGroup is semi-transparent and,
            over the fullscreen page, would become illegible. */}
        <div className="px-3">
          <CodeInput
            onSubmit={handleSubmit}
            status={status}
            onStop={handleStop}
            hasMessages={messages.length > 0}
            sessionId={sessionId}
            showFolders={false}
          />
        </div>
      </div>
    </div>
  )
}

/**
 * Floating sidebar of fullscreen, with the look of the app's standard sidebar
 * (variant="floating": rounded corners, `bg-sidebar`, shadow and ring
 * `sidebar-border`, 8px of breathing room from the edges, 200ms linear).
 *
 * - `open` = pinned open; the floating button NEXT to the panel toggles it.
 * - The panel takes the whole height (top-2/bottom-2) and the button stays next to it,
 *   aligned to the top, touching the inner edge when open; closed, it
 *   retreats to the screen edge (it stays clickable to reopen).
 * - Closed, touching the edge (6px strip) opens under hover and leaving closes —
 *   just like the standard sidebar in "hover" mode.
 * The outer container does not capture the mouse: only the strip, the button and the panel.
 */
export function FloatingSidebar({
  side,
  open,
  onToggle,
  openLabel,
  closeLabel,
  width = 288,
  children,
}: {
  side: "left" | "right"
  open: boolean
  onToggle: () => void
  openLabel: string
  closeLabel: string
  /** Width of the panel in px (the button positions itself from it). */
  width?: number
  children: ReactNode
}) {
  const { hovered, handleEnter, handleLeave } = useEdgeHover()
  const visible = open || hovered
  const left = side === "left"
  const ToggleIcon = left ? SidebarLeftIcon : SidebarRightIcon
  // Button next to the panel: 8px of breathing room from the screen + the sidebar width +
  // 6px of slack. Closed, it goes back to the edge (8px).
  const toggleOffset = visible ? 8 + width + 6 : 8

  return (
    <div
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      className={cn("pointer-events-none absolute inset-y-0 z-30 w-0", left ? "left-0" : "right-0")}
    >
      {/* Hover strip on the edge: only while the sidebar is closed */}
      {!visible && <div className={cn("pointer-events-auto absolute inset-y-0 w-1.5", left ? "left-0" : "right-0")} />}
      <Hint label={open ? closeLabel : openLabel}>
        <button
          type="button"
          onClick={onToggle}

          aria-label={open ? closeLabel : openLabel}
          className="pointer-events-auto absolute top-2 flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-all duration-200 ease-linear hover:bg-muted hover:text-foreground"
          style={left ? { left: toggleOffset } : { right: toggleOffset }}
        >
          <ToggleIcon open={open} className="size-4" />
        </button>
      </Hint>
      <div
        aria-hidden={!visible}
        className={cn(
          "absolute top-2 bottom-2 flex flex-col overflow-hidden rounded-lg bg-sidebar text-sidebar-foreground shadow-sm ring-1 ring-sidebar-border transition-transform duration-200 ease-linear",
          left ? "left-2" : "right-2",
          visible
            ? "pointer-events-auto translate-x-0"
            : cn("pointer-events-none", left ? "-translate-x-[calc(100%+0.75rem)]" : "translate-x-[calc(100%+0.75rem)]"),
        )}
        style={{ width }}
      >
        {children}
      </div>
    </div>
  )
}

/** Sidebar icons with the state: "close" when open, "open" when not. */
function SidebarLeftIcon({ open, className }: { open: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
      <path d={open ? "m16 15-3-3 3-3" : "m14 9 3 3-3 3"} />
    </svg>
  )
}

function SidebarRightIcon({ open, className }: { open: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M15 3v18" />
      <path d={open ? "m8 9 3 3-3 3" : "m10 15-3-3 3-3"} />
    </svg>
  )
}

/** Stable lists for the zustand selectors (they avoid a re-render for a new reference). */
const NO_MSGS: ChatMessage[] = []
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
              <Hint label={pinned ? t("browser.unpinFeed") : t("browser.pinFeed")}>
                <button
                  type="button"
                  onClick={onTogglePin}
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground",
                    pinned && "text-primary hover:text-primary",
                  )}
                >
       
                       {pinned ? <PinOffIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}
              </button>
              </Hint>
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


/** One agent action in the feed: the tool, the readable label and the summary of the output. */
export interface FeedAction {
  part: ToolPart
  label: string
}

/**
 * Agent actions — panel collapsed on the right edge of the fullscreen screens and of
 * the Computer Use panels, with a pin like the conversation's. It lists the session
 * tools, from the most recent to the oldest: state, label and the first line
 * of the output (a click shows the whole output).
 */
export function ActionsFeed({
  sessionId: fixedSessionId,
  pinned,
  onTogglePin,
  title,
  icon: Icon,
  filter,
  describe,
  headerExtra,
  top,
  onHoverChange,
  limit = 60,
}: {
  sessionId?: string
  pinned: boolean
  onTogglePin: () => void
  title: string
  icon: LucideIcon
  /** Which tools enter (default: all) */
  filter?: (part: ToolPart) => boolean
  /** Readable label of the action (default: the tool title or its name) */
  describe?: (part: ToolPart) => string
  headerExtra?: ReactNode
  /** Fixed content above the list (the Computer Use thumbnail) */
  top?: ReactNode
  onHoverChange?: (over: boolean) => void
  limit?: number
}) {
  const { t } = useTranslation()
  const mode = useWorkspaceMode()
  const activeSession = useActiveSession(mode)
  const sessionId = fixedSessionId ?? activeSession?.id
  const messages = useSessionStore((s) => (sessionId ? s.messages[sessionId] ?? NO_MSGS : NO_MSGS))
  const status = useSessionStatus(sessionId)
  const isBusy = status === "submitted" || status === "streaming" || status === "cancelling" || status === "fallback"
  const { hovered, handleEnter, handleLeave } = useEdgeHover()
  const expanded = pinned || hovered

  const actions = useMemo(() => {
    const list: ToolPart[] = []
    for (let i = messages.length - 1; i >= 0 && list.length < limit; i--) {
      const parts = messages[i].parts
      for (let j = parts.length - 1; j >= 0 && list.length < limit; j--) {
        const part = parts[j]
        if (part.type === "tool" && (!filter || filter(part))) list.push(part)
      }
    }
    return list
  }, [messages, filter, limit])
  const running = actions[0]?.state === "running"

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
      className="pointer-events-auto absolute right-0 top-1/2 z-30 flex -translate-y-1/2 items-center"
    >
      <div
        className={cn(
          "flex flex-col overflow-hidden rounded-l-xl border border-r-0 bg-background/95 shadow-lg backdrop-blur transition-all duration-300 ease-out",
          expanded ? "h-[min(72vh,600px)] w-80" : "h-12 w-9",
        )}
      >
        <Hint label={title}>
          <button
            type="button"
            onClick={onTogglePin}
            className="flex h-12 w-full shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
          >
       
           <span className="relative flex items-center justify-center">
            <Icon className="size-4" />
            {(running || isBusy) && <FeedPulse className="absolute -right-1.5 -top-1.5" />}
          </span>
        </button>
        </Hint>
        {expanded && (
          <div className="flex min-h-0 flex-1 animate-in flex-col fade-in-0 duration-200">
            <div className="flex items-center gap-2 border-b px-3 py-2">
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              <Truncate text={title}>
                <span className="min-w-0 flex-1 truncate text-xs font-medium">{title}</span>
              </Truncate>
              {headerExtra}
              <FeedPinButton pinned={pinned} onToggle={onTogglePin} />
            </div>
            {top}
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {actions.length === 0 ? (
                <p className="px-2 py-6 text-center text-[11px] text-muted-foreground">{t("computer.panels.empty")}</p>
              ) : (
                actions.map((part, i) => (
                  <ActionRow key={part.id} part={part} label={describe ? describe(part) : part.title || part.tool} latest={i === 0} />
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ActionRow({ part, label, latest }: { part: ToolPart; label: string; latest: boolean }) {
  const [open, setOpen] = useState(false)
  const detail = part.state === "error" ? part.error : part.output
  // The first line of the output is the summary ("Pressed element 2 (button "Salvar") via AXPress.").
  const summary = detail?.split("\n").find((line) => line.trim())?.trim()
  return (
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      className={cn(
        "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-muted/60",
        latest ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <span className="mt-0.5 shrink-0">
        {part.state === "running" ? (
          <Loader2Icon className="size-3 animate-spin text-primary-foreground dark:text-primary" />
        ) : part.state === "error" ? (
          <XIcon className="size-3 text-destructive" />
        ) : (
          <CheckIcon className="size-3 text-emerald-500" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{label}</span>
        {summary && (
          <span className={cn("mt-0.5 block whitespace-pre-wrap break-words text-muted-foreground", !open && "line-clamp-2")}>
            {open ? detail : summary}
          </span>
        )}
      </span>
    </button>
  )
}

/** Pin of the side feeds: it pins the panel open (the hover only opens while the mouse is on it). */
export function FeedPinButton({ pinned, onToggle }: { pinned: boolean; onToggle: () => void }) {
  const { t } = useTranslation()
  return (
    <Hint label={pinned ? t("browser.unpinFeed") : t("browser.pinFeed")}>
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground",
          pinned && "text-primary hover:text-primary",
        )}
      >
        {
    pinned ? <PinOffIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}
    </button>
    </Hint>
  )
}

function FeedPulse({ className }: { className?: string }) {
  return (
    <span className={cn("flex size-2", className)}>
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
      <span className="relative inline-flex size-2 rounded-full bg-primary" />
    </span>
  )
}
