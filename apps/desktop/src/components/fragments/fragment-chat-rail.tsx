import { useTranslation } from "react-i18next"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"
import { Hint } from "@/components/ui/hint"
import { ArtifactChatTools } from "@/src/components/artifact/artifact-chat-tools"
import { ChatInput } from "@/src/components/chat-input"
import { ConversationBody } from "@/src/components/conversation-body"
import type { useArtifactChat } from "@/src/hooks/use-artifact-chat"
import { useSessionStatus, useSessionStore } from "@/src/stores/session-store"

/**
 * The conversation of the open fragment, docked on the right while edit mode is on — ONE
 * surface for the whole editing: what was asked, what the agent did (the tool steps come
 * inside the conversation, as in any chat) and the prompt at the bottom of the same column.
 *
 * The column narrows the fragment instead of covering it; its title is the picker among the
 * chats that worked on it. Closing it leaves edit mode (the header's Edit turns it back on).
 * `overlaid` is for when there is no room for two columns: it slides over the fragment.
 */
export function FragmentChatRail({
  chat,
  sessionId,
  overlaid,
  onClose,
}: {
  chat: ReturnType<typeof useArtifactChat>
  sessionId: string
  overlaid?: boolean
  onClose: () => void
}) {
  const { t } = useTranslation()
  const status = useSessionStatus(sessionId)
  const title = useSessionStore((s) => s.sessions.find((session) => session.id === sessionId)?.title)

  return (
    <aside
      aria-label={t("fragments.chat.title")}
      className={cn(
        "z-30 flex min-h-0 shrink-0 flex-col bg-background",
        overlaid ? "absolute inset-y-0 right-0 w-[min(400px,90%)] border-l shadow-xl" : "w-[400px] border-l",
      )}
    >
      <header className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
        <ArtifactChatTools
          title={title ?? t("fragments.chat.title")}
          kind={chat.kind}
          chats={chat.chats}
          sessionId={sessionId}
          onSelect={chat.select}
          onNew={() => void chat.createEmbedded()}
        />
        <Hint label={t("fragments.chat.hide")}>
          <button
            type="button"
            aria-label={t("fragments.chat.hide")}
            onClick={onClose}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </Hint>
      </header>

      <ConversationBody sessionId={sessionId} active />

      <div className="mt-2 shrink-0 px-2 pb-2">
        <ChatInput
          sessionId={sessionId}
          draftKey={`fragment-rail-${sessionId}`}
          status={status}
          onStop={() => useSessionStore.getState().stopStreaming(sessionId)}
          onSubmit={(text, options, files) =>
            void useSessionStore.getState().sendMessage("chat", text, { options, sessionId, files })
          }
        />
      </div>
    </aside>
  )
}
