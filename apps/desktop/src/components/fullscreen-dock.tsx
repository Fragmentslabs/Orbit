import { useCallback, type ReactNode } from "react"
import { cn } from "@/lib/utils"
import type { ChatMessage, FilePart, SendMessageOptions } from "@shared/chat"
import { CodeInput } from "@/src/components/code-input"
import { DockHandle } from "@/src/components/dock-handle"
import { useEdgeHover } from "@/src/hooks/use-edge-hover"
import { useActiveSession, useSessionStatus, useSessionStore } from "@/src/stores/session-store"
import { useWorkspaceMode } from "@/lib/workspace-context"
import { Hint } from "@/components/ui/hint"

/**
 * Shared pieces of the fullscreen screens (browser, Motion and Design): the composer
 * that only appears on the hover of the bottom edge and the floating sidebars that
 * copy the look of the app's standard sidebar. The side feeds live in
 * `fullscreen-chat-feed.tsx` and `actions-feed.tsx`.
 */

const NO_MSGS: ChatMessage[] = []

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
        <DockHandle pinned={pinned} onTogglePin={onTogglePin} />
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

