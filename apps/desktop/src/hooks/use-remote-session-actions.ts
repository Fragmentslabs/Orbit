import { useCallback, useMemo } from "react"
import type { SessionInfo } from "@shared/chat"
import { parseRemoteSessionId } from "@shared/peers"
import { peersApi } from "@/src/lib/ipc"
import { usePeersStore } from "@/src/stores/peers-store"

/** The id the paired desktop knows a chat by (the namespaced one loses its `peer:<id>:` prefix). */
export function remoteIdOf(id: string): string {
  return parseRemoteSessionId(id)?.sessionId ?? id
}

/** Any companion request to a paired desktop (needs its `control` grant). */
export function useRemoteRequest(peerId: string) {
  return useCallback(
    <T,>(payload: { type: string; [key: string]: unknown }) => peersApi.request<T>(peerId, payload),
    [peerId],
  )
}

export interface RemoteSessionActions {
  /** The paired desktop gave full control and is reachable: the actions below will be accepted. */
  canAct: boolean
  request: ReturnType<typeof useRemoteRequest>
  togglePin: () => void
  toggleArchive: () => void
  rename: (title: string) => void
  remove: () => void
}

/**
 * Pin, archive, rename and delete a chat that lives on another desktop. The sidebar rows and
 * the chat header both go through here, so the request shapes exist once.
 */
export function useRemoteSessionActions(peerId: string, session: SessionInfo | undefined): RemoteSessionActions {
  const request = useRemoteRequest(peerId)
  const canAct = usePeersStore((s) => {
    const peer = s.snapshot?.peers.find((p) => p.peerId === peerId)
    return peer?.grants.control === true && !!peer.online
  })
  const id = session?.id
  const pinned = !!session?.pinned
  const archived = !!session?.archived
  return useMemo(
    () => ({
      canAct,
      request,
      togglePin: () => id && void request({ type: "sessions:pin", sessionId: remoteIdOf(id), pinned: !pinned }),
      toggleArchive: () => id && void request({ type: "sessions:archive", sessionId: remoteIdOf(id), archived: !archived }),
      rename: (title: string) => id && void request({ type: "sessions:rename", sessionId: remoteIdOf(id), title }),
      remove: () => id && void request({ type: "sessions:delete", sessionId: remoteIdOf(id) }),
    }),
    [canAct, request, id, pinned, archived],
  )
}
