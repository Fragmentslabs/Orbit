import { useTranslation } from "react-i18next"
import { PinIcon, PinOffIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { ChatInput } from "@/src/components/chat-input"
import { useEdgeHover } from "@/src/components/fullscreen-dock"
import { Hint } from "@/components/ui/hint"
import { useSessionStatus, useSessionStore } from "@/src/stores/session-store"

/**
 * The prompt of edit mode. It talks ONLY to the fragment's own conversation: it never falls
 * back to the active chat of the workspace (what the generic fullscreen composer does), and
 * it is the chat input — so the thinking level and model of that conversation are here too.
 */
export function FragmentComposer({
  sessionId,
  pinned,
  onTogglePin,
}: {
  sessionId: string
  pinned: boolean
  onTogglePin: () => void
}) {
  const { t } = useTranslation()
  const { hovered, handleEnter, handleLeave } = useEdgeHover()
  const expanded = pinned || hovered
  const status = useSessionStatus(sessionId)

  return (
    <div
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-4"
    >
      <div
        className={cn(
          "pointer-events-auto w-full max-w-2xl rounded-t-xl border border-b-0 bg-background/95 shadow-lg backdrop-blur transition-transform duration-300 ease-out",
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
        <div className="px-3 pb-3">
          <ChatInput
            sessionId={sessionId}
            draftKey={`fragment-edit-${sessionId}`}
            status={status}
            onStop={() => useSessionStore.getState().stopStreaming(sessionId)}
            onSubmit={(text, options, files) =>
              void useSessionStore.getState().sendMessage("chat", text, { options, sessionId, files })
            }
          />
        </div>
      </div>
    </div>
  )
}
