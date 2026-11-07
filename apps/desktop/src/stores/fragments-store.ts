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
/** A creation in progress: shown in the gallery as a card that is being made. */
export interface Creation {
  sessionId: string
  kind: FragmentKind
  startedAt: number
}

interface FragmentsState {
  items: FragmentManifest[]
  loaded: boolean
  /** The fragment open on the page; null = the gallery (or the creation screen). */
  activeId: string | null
  /** A creation started from the page: the chat that is building it, and its kind. */
  creating: { sessionId: string; kind: FragmentKind } | null
  /** The "new fragment" screen is showing (before any chat exists). */
  composing: boolean
  /** Edit mode of the open fragment (its prompt and feeds). Lives here because the header turns it on. */
  editing: boolean
  /** Bumped to reload the open fragment's frame. */
  reloads: number
  /**
   * Every creation that has not produced its fragment yet, whether or not its screen is
   * showing. Leaving the creating screen does not stop it: it stays here as a card in the
   * gallery, and comes back with a click. It disappears when its fragment exists.
   */
  creations: Creation[]

  load: () => Promise<void>
  open: (id: string | null) => void
  toggleEditing: () => void
  reload: () => void
  startComposing: () => void
  startCreating: (creating: { sessionId: string; kind: FragmentKind }) => void
  /** Back to the creating screen of a creation that was left running. */
  viewCreation: (sessionId: string) => void
  /** Forget a creation that ended without producing a fragment. */
  discardCreation: (sessionId: string) => void
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
  editing: false,
  reloads: 0,
  creations: [],

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
    // A creation whose fragment now exists has done its job: the real card takes its place.
    const made = (sessionId: string) => items.some((f) => f.sessionId === sessionId)
    set((state) => {
      const creations = state.creations.filter((c) => !made(c.sessionId))
      return { items, loaded: true, creations: creations.length === state.creations.length ? state.creations : creations }
    })
  },

  open: (id) => set({ activeId: id, composing: false, creating: null, editing: false, reloads: 0 }),
  toggleEditing: () => set((state) => ({ editing: !state.editing })),
  reload: () => set((state) => ({ reloads: state.reloads + 1 })),
  startComposing: () => set({ composing: true, activeId: null, creating: null, editing: false }),
  startCreating: (creating) =>
    set((state) => ({
      creating,
      composing: false,
      activeId: null,
      editing: false,
      creations: [
        ...state.creations.filter((c) => c.sessionId !== creating.sessionId),
        { ...creating, startedAt: Date.now() },
      ],
    })),
  viewCreation: (sessionId) => {
    const found = get().creations.find((c) => c.sessionId === sessionId)
    if (found) set({ creating: { sessionId, kind: found.kind }, composing: false, activeId: null })
  },
  discardCreation: (sessionId) =>
    set((state) => ({
      creations: state.creations.filter((c) => c.sessionId !== sessionId),
      creating: state.creating?.sessionId === sessionId ? null : state.creating,
    })),
  leave: () => set({ activeId: null, composing: false, creating: null, editing: false }),

  claim: ({ id, sessionId }) => {
    const { creating, activeId } = get()
    if (creating && sessionId && creating.sessionId === sessionId) {
      set({ activeId: id, creating: null, composing: false, editing: false, reloads: 0 })
      void get().load()
      return true
    }
    // A creation the person left running: the fragment arrives while the gallery is showing.
    // The page handles it (the card swaps in), so the side panel must not open a copy.
    if (sessionId && get().creations.some((c) => c.sessionId === sessionId)) {
      void get().load()
      return true
    }
    return activeId === id
  },
}))
