import { cn } from "@/lib/utils"
import { ChatInput } from "@/src/components/chat-input"
import { DockHandle } from "@/src/components/dock-handle"
import { useEdgeHover } from "@/src/hooks/use-edge-hover"
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
        <DockHandle pinned={pinned} onTogglePin={onTogglePin} />
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
