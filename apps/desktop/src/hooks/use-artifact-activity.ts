import { useEffect } from "react"
import { artifactKey, type ArtifactRef } from "@shared/artifacts"
import { summarizeActivity, type ArtifactActivity } from "@/src/lib/artifact-activity"
import { chatsOf, useArtifactChatsStore } from "@/src/stores/artifact-chats-store"
import { useSessionStore } from "@/src/stores/session-store"

/**
 * What the chats of an artifact are doing — the same for every kind. Read from the chat
 * list of the artifact and the status of each chat, so the sidebar can show a spinner while
 * the agent works and a bullet when it finished, wherever the work happens.
 */
export function useArtifactActivity(ref: ArtifactRef | null): ArtifactActivity {
  const ensure = useArtifactChatsStore((s) => s.ensure)
  const chats = useArtifactChatsStore((s) => chatsOf(s.byKey, ref).sessionIds)
  const key = ref ? artifactKey(ref) : ""

  useEffect(() => {
    if (ref) void ensure(ref)
    // `key` stands for the ref's contents
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ensure])

  const working = useSessionStore((s) => summarizeActivity(chats, s.status, s.unreadCounts).working)
  const unread = useSessionStore((s) => summarizeActivity(chats, s.status, s.unreadCounts).unread)
  return { working, unread }
}

/**
 * While the person is looking at the artifact, what its chats produced counts as seen: the
 * bullet clears itself instead of waiting for them to open a chat.
 */
export function useMarkArtifactSeen(ref: ArtifactRef | null, looking: boolean): void {
  const { unread } = useArtifactActivity(ref)
  const chats = useArtifactChatsStore((s) => chatsOf(s.byKey, ref).sessionIds)
  useEffect(() => {
    if (!looking || !unread) return
    useSessionStore.setState((state) => {
      const unreadCounts = { ...state.unreadCounts }
      for (const id of chats) delete unreadCounts[id]
      return { unreadCounts }
    })
  }, [looking, unread, chats])
}
