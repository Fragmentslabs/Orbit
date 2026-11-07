import { useMemo, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { CheckIcon, Loader2Icon, XIcon, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ChatMessage, ToolPart } from "@shared/chat"
import { FeedPinButton } from "@/src/components/dock-handle"
import { useEdgeHover } from "@/src/hooks/use-edge-hover"
import { useActiveSession, useSessionStatus, useSessionStore } from "@/src/stores/session-store"
import { useWorkspaceMode } from "@/lib/workspace-context"
import { Hint } from "@/components/ui/hint"
import { Truncate } from "@/components/ui/truncated-text"

const NO_MSGS: ChatMessage[] = []

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

function FeedPulse({ className }: { className?: string }) {
  return (
    <span className={cn("flex size-2", className)}>
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
      <span className="relative inline-flex size-2 rounded-full bg-primary" />
    </span>
  )
}

