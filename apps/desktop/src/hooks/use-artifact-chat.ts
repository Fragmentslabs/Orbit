import { useCallback, useEffect } from "react"
import { artifactKey, type ArtifactRef } from "@shared/artifacts"
import { artifactChatsApi } from "@/src/lib/ipc"
import { embeddedChatFields } from "@/src/lib/artifact-session"
import { chatsOf, useArtifactChatsStore } from "@/src/stores/artifact-chats-store"
import { useSessionStore } from "@/src/stores/session-store"

/**
 * The chat an artifact's card is showing, and what can be done with the list. The same for
 * every kind of artifact:
 *
 *  - `sessionId`: the chat the person picked, else the artifact's author (`fallback`), else
 *    the first chat that worked on it. Chats that no longer exist are skipped.
 *  - `chats`: every chat that worked on it that still exists.
 *  - `select`: shows another chat in the card.
 *  - `createEmbedded`: a new chat made inside the artifact (out of the sidebar).
 *  - `ensure`: the shown chat, making an embedded one when the artifact has none.
 */
export function useArtifactChat(ref: ArtifactRef | null, options: { fallback?: string; fragmentKind?: "screen" | "panel" | "widget" } = {}) {
  const { fallback, fragmentKind } = options
  const ensureLoaded = useArtifactChatsStore((s) => s.ensure)
  const registry = useArtifactChatsStore((s) => chatsOf(s.byKey, ref))
  const sessions = useSessionStore((s) => s.sessions)
  const key = ref ? artifactKey(ref) : ""

  useEffect(() => {
    if (ref) void ensureLoaded(ref)
    // `key` stands for the ref's contents
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ensureLoaded])

  const exists = useCallback((id: string | undefined) => !!id && sessions.some((s) => s.id === id), [sessions])
  const chats = registry.sessionIds.filter((id) => exists(id))
  const candidates = [registry.current, fallback, chats[0]]
  const sessionId = candidates.find((id) => exists(id))

  const select = useCallback(
    (id: string) => {
      if (ref) void artifactChatsApi.setCurrent(ref, id)
    },
    [ref],
  )

  const createEmbedded = useCallback(async (): Promise<string | undefined> => {
    if (!ref) return undefined
    const session = await useSessionStore
      .getState()
      .createSession("chat", { setActive: false, ...embeddedChatFields(ref.kind, ref, fragmentKind) })
    await artifactChatsApi.associate(ref, session.id, true)
    return session.id
  }, [ref, fragmentKind])

  const ensure = useCallback(async () => sessionId ?? createEmbedded(), [sessionId, createEmbedded])

  return { kind: ref?.kind, sessionId, chats, select, createEmbedded, ensure }
}
