import { FullscreenChatFeed } from "@/src/components/fullscreen-chat-feed"
import { ArtifactChatTools } from "@/src/components/artifact/artifact-chat-tools"
import { AGENT_META } from "@/src/components/agent-meta"
import type { useArtifactChat } from "@/src/hooks/use-artifact-chat"

/**
 * The conversation card of an artifact's fullscreen: the floating chat feed with the
 * artifact's chat controls in its header. Fragments and motion use it as is; the design
 * screen puts the same body and controls in a tab (its left edge is taken by the layers).
 */
export function ArtifactChatFeed({
  chat,
  title,
  pinned,
  onTogglePin,
}: {
  chat: ReturnType<typeof useArtifactChat>
  title: string
  pinned: boolean
  onTogglePin: () => void
}) {
  return (
    <FullscreenChatFeed
      sessionId={chat.sessionId}
      pinned={pinned}
      onTogglePin={onTogglePin}
      title={title}
      icon={chat.kind ? AGENT_META[chat.kind].icon : undefined}
      headerExtra={
        <ArtifactChatTools
          kind={chat.kind}
          chats={chat.chats}
          sessionId={chat.sessionId}
          onSelect={chat.select}
          onNew={() => void chat.createEmbedded()}
        />
      }
    />
  )
}
