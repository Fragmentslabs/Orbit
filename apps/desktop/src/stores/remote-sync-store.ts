import { create } from "zustand"
import type { PeerSyncEvent } from "@shared/peers"
import { peersApi } from "@/src/lib/ipc"
import { EMPTY_SYNC, applySyncEvent, type RemoteSync } from "@/src/lib/remote-sync"

/**
 * The other desktop's per-chat settings, mirrored: the model, the input modes, thinking and
 * permission of each chat, the message queue, the app preferences. They live in THAT
 * machine's renderer; this store holds the last copy it pushed (`sync:get` on connect, then
 * the `*:change` events). Keys are the other machine's own chat ids — the composer reads
 * with the un-namespaced id. The rules are in lib/remote-sync.
 */

interface RemoteSyncState {
  byPeer: Record<string, RemoteSync | undefined>
  loading: Record<string, boolean>
  load: (peerId: string, force?: boolean) => Promise<void>
  apply: (peerId: string, event: PeerSyncEvent) => void
}

export const useRemoteSyncStore = create<RemoteSyncState>((set, get) => ({
  byPeer: {},
  loading: {},
  load: async (peerId, force = false) => {
    if (get().loading[peerId] || (!force && get().byPeer[peerId])) return
    set((s) => ({ loading: { ...s.loading, [peerId]: true } }))
    try {
      const snapshot = await peersApi.request<RemoteSync>(peerId, { type: "sync:get" })
      // Events that arrived while the request was in flight are newer than the snapshot only
      // when they changed that field; the snapshot is taken at answer time, so it wins.
      set((s) => ({ byPeer: { ...s.byPeer, [peerId]: { ...EMPTY_SYNC, ...snapshot } } }))
    } catch {
      /* offline or without control: the composer keeps the defaults */
    } finally {
      set((s) => ({ loading: { ...s.loading, [peerId]: false } }))
    }
  },
  apply: (peerId, event) =>
    set((s) => ({ byPeer: { ...s.byPeer, [peerId]: applySyncEvent(s.byPeer[peerId] ?? EMPTY_SYNC, event) } })),
}))

/** Wired once from env-sync: the other machine's mirrors keep this store current. */
export function applyPeerSync(peerId: string, event: PeerSyncEvent): void {
  useRemoteSyncStore.getState().apply(peerId, event)
}
