import { create } from "zustand"
import type { FragmentManifest } from "@shared/fragments"
import { FRAGMENT_SCHEME } from "@shared/fragments"
import type { FragmentProvenance } from "@shared/fragment-provenance"
import { fragmentApi } from "@/src/lib/ipc"
import { usePanelStore } from "@/src/stores/panel-store"

/**
 * The fragments the app knows about, and what the Fragments page is showing.
 *
 * The list lives in the main process (disk); this store is its mirror, kept fresh by
 * the `fragment:updated` / `fragment:removed` events — the sidebar (pinned entries),
 * the page and the side panel's hub all read it.
 *
 * Creating one is NOT here: it happens in a normal chat with the fragment agent (the
 * page's "new" opens that chat), and the fragment is born linked to the chat that made
 * it — which is the chat edit mode talks to.
 */
interface FragmentsState {
  items: FragmentManifest[]
  /** Origin of each fragment, read together with the list (the gallery's source filters). */
  origins: Record<string, FragmentProvenance>
  loaded: boolean
  /** The fragment open on the page; null = the gallery. */
  activeId: string | null
  /** Edit mode of the open fragment (its prompt and feeds). Lives here because the header turns it on. */
  editing: boolean
  /** Inspect mode: the next click on the open fragment picks an element to talk about. */
  inspecting: boolean
  /** The details panel of the open fragment is showing. */
  detailsOpen: boolean
  /** Bumped to reload the open fragment's frame. */
  reloads: number

  load: () => Promise<void>
  open: (id: string | null) => void
  toggleEditing: () => void
  toggleDetails: () => void
  toggleInspecting: () => void
  /** An element was picked in inspect mode: it becomes an attachment of the next message and edit mode opens. */
  pickElement: (fragment: { id: string; name: string }, element: { tag: string; selector: string; text: string; html: string }) => void
  reload: () => void
  /** Back to the gallery. */
  leave: () => void
  /**
   * The page's answer to "a fragment was created/rewritten": true when it is the one on
   * screen (so the side panel must not open a second copy of it).
   */
  claim: (event: { id: string; sessionId?: string }) => boolean
}

let synced = false

export const useFragmentsStore = create<FragmentsState>((set, get) => ({
  items: [],
  origins: {},
  loaded: false,
  activeId: null,
  editing: false,
  inspecting: false,
  detailsOpen: false,
  reloads: 0,

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
    const [items, origins] = await Promise.all([
      fragmentApi.list(),
      // An older main process may not know the bulk channel yet: the list still loads and
      // every fragment reads as local until the app restarts.
      fragmentApi.provenances().catch(() => ({} as Record<string, FragmentProvenance>)),
    ])
    set({ items, origins, loaded: true })
  },

  open: (id) => set({ activeId: id, editing: false, inspecting: false, detailsOpen: false, reloads: 0 }),
  toggleEditing: () => set((state) => ({ editing: !state.editing })),
  toggleDetails: () => set((state) => ({ detailsOpen: !state.detailsOpen })),
  toggleInspecting: () => set((state) => ({ inspecting: !state.inspecting })),
  pickElement: (fragment, element) => {
    // The same attachment the panel browser makes for a selected element: the composer shows
    // its chip and the engine turns it into text for the agent.
    usePanelStore.getState().addSelection({
      ...element,
      url: `${FRAGMENT_SCHEME}://${fragment.id}/`,
      where: `the fragment "${fragment.name}"`,
    })
    set({ inspecting: false, editing: true })
  },
  reload: () => set((state) => ({ reloads: state.reloads + 1 })),
  leave: () => set({ activeId: null, editing: false, inspecting: false, detailsOpen: false }),

  claim: ({ id }) => get().activeId === id,
}))
