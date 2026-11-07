import { create } from "zustand"
import type { FragmentKind, FragmentManifest } from "@shared/fragments"
import { fragmentApi } from "@/src/lib/ipc"

/**
 * The fragments the app knows about, and what the Fragments page is showing.
 *
 * The list lives in the main process (disk); this store is its mirror, kept fresh by
 * the `fragment:updated` / `fragment:removed` events — the sidebar (pinned entries),
 * the page and the side panel's hub all read it.
 */
interface FragmentsState {
  items: FragmentManifest[]
  loaded: boolean
  /** The fragment open on the page; null = the gallery (or the creation screen). */
  activeId: string | null
  /** A creation started from the page: the chat that is building it, and its kind. */
  creating: { sessionId: string; kind: FragmentKind } | null
  /** The "new fragment" screen is showing (before any chat exists). */
  composing: boolean

  load: () => Promise<void>
  open: (id: string | null) => void
  startComposing: () => void
  startCreating: (creating: { sessionId: string; kind: FragmentKind }) => void
  /** Back to the gallery. */
  leave: () => void
  /**
   * The page's answer to "a fragment was created/rewritten": true when the page is
   * handling it (so the side panel must not open a second copy).
   */
  claim: (event: { id: string; sessionId?: string }) => boolean
}

let synced = false

export const useFragmentsStore = create<FragmentsState>((set, get) => ({
  items: [],
  loaded: false,
  activeId: null,
  creating: null,
  composing: false,

  load: async () => {
    if (!synced) {
      synced = true
      // Both events just mean "the list changed": re-read it. The manifests are tiny.
      fragmentApi.onUpdated(() => void get().load())
      fragmentApi.onRemoved(({ fragmentId }) => {
        if (get().activeId === fragmentId) set({ activeId: null })
        void get().load()
      })
    }
    const items = await fragmentApi.list()
    set({ items, loaded: true })
  },

  open: (id) => set({ activeId: id, composing: false, creating: null }),
  startComposing: () => set({ composing: true, activeId: null, creating: null }),
  startCreating: (creating) => set({ creating, composing: false, activeId: null }),
  leave: () => set({ activeId: null, composing: false, creating: null }),

  claim: ({ id, sessionId }) => {
    const { creating, activeId } = get()
    if (creating && sessionId && creating.sessionId === sessionId) {
      set({ activeId: id, creating: null, composing: false })
      void get().load()
      return true
    }
    return activeId === id
  },
}))
