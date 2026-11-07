import { create } from "zustand"
import { artifactKey, type ArtifactChats, type ArtifactRef } from "@shared/artifacts"
import { artifactChatsApi } from "@/src/lib/ipc"

/**
 * The chats of every artifact, by `kind:id`. A mirror of the registry in the main process,
 * loaded when an artifact first asks for it and kept fresh by its change event.
 */
interface ArtifactChatsState {
  byKey: Record<string, ArtifactChats>
  /** Loads the artifact's chats once (and starts listening to changes the first time). */
  ensure: (ref: ArtifactRef) => Promise<void>
}

const EMPTY: ArtifactChats = { sessionIds: [] }
let listening = false
const requested = new Set<string>()

export const useArtifactChatsStore = create<ArtifactChatsState>((set, get) => ({
  byKey: {},
  ensure: async (ref) => {
    if (!listening) {
      listening = true
      artifactChatsApi.onChats(({ ref: changed, chats }) =>
        set((state) => ({ byKey: { ...state.byKey, [artifactKey(changed)]: chats } })),
      )
    }
    const key = artifactKey(ref)
    if (requested.has(key) && get().byKey[key]) return
    requested.add(key)
    const chats = await artifactChatsApi.chats(ref)
    set((state) => ({ byKey: { ...state.byKey, [key]: state.byKey[key] ?? chats } }))
  },
}))

export function chatsOf(byKey: Record<string, ArtifactChats>, ref: ArtifactRef | null): ArtifactChats {
  return (ref && byKey[artifactKey(ref)]) || EMPTY
}
