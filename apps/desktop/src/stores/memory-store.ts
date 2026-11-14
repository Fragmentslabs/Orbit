import { create } from "zustand"
import type { Memory, MemoryEvent } from "@shared/memory"
import { getActivePeer } from "@/src/lib/env-source"
import { memoryApi } from "@/src/lib/ipc"

/**
 * Store of the Memories view. The full index comes from main (memory:list) and is
 * kept in sync by the MemoryEvents (memory:event channel) — every mutation
 * made by the agent or by the UI reflects here in real time.
 */

interface MemoryState {
  initialized: boolean
  /** true until the first list() answers — the view shows a skeleton meanwhile. */
  loading: boolean
  index: Memory[]
  /** Markdown documents loaded on demand, by id */
  docs: Record<string, string>

  initialize: () => Promise<void>
  applyEvent: (event: MemoryEvent) => void
  /** The environment changed: forget what was loaded and read it again if the page was ever opened. */
  reset: () => void
  refresh: () => Promise<void>
  openDoc: (id: string) => Promise<string | null>
  update: (id: string, patch: Partial<Pick<Memory, "text" | "tags" | "weight" | "proposed">>) => Promise<void>
  remove: (id: string) => Promise<void>
  promote: (id: string) => Promise<void>
  link: (sourceId: string, targetId: string) => Promise<void>
}

function applyEvent(event: MemoryEvent, index: Memory[]): Memory[] {
  const { memory } = event
  if (event.action === "removed") return index.filter((m) => m.id !== memory.id)
  const exists = index.some((m) => m.id === memory.id)
  return exists ? index.map((m) => (m.id === memory.id ? memory : m)) : [...index, memory]
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  initialized: false,
  loading: true,
  index: [],
  docs: {},

  initialize: async () => {
    if (get().initialized) return
    set({ initialized: true })
    memoryApi.onEvent((event) => {
      // This machine's own changes are not the page on screen while another desktop is shown.
      if (getActivePeer()) return
      get().applyEvent(event)
    })
    await get().refresh()
  },

  applyEvent: (event) => {
    set((state) => {
      // Invalidates the cached doc — it may have been updated/removed along with
      const docs = { ...state.docs }
      delete docs[event.memory.id]
      return { index: applyEvent(event, state.index), docs }
    })
  },

  refresh: async () => {
    const peer = getActivePeer()
    try {
      const index = await memoryApi.list()
      if (getActivePeer() !== peer) return
      set({ index })
    } finally {
      // Leaves the skeleton even if the list fails, otherwise the screen stays loading
      // forever instead of showing the empty state.
      set({ loading: false })
    }
  },

  reset: () => {
    set({ index: [], docs: {}, loading: true })
    if (get().initialized) void get().refresh()
  },

  openDoc: async (id) => {
    const cached = get().docs[id]
    if (cached !== undefined) return cached
    const full = await memoryApi.get(id)
    const doc = full?.document ?? null
    if (doc !== null) set((state) => ({ docs: { ...state.docs, [id]: doc } }))
    return doc
  },

  update: async (id, patch) => {
    await memoryApi.update(id, patch) // the memory:event updates the index
  },

  remove: async (id) => {
    await memoryApi.delete(id)
  },

  promote: async (id) => {
    await memoryApi.promote(id)
  },

  link: async (sourceId, targetId) => {
    await memoryApi.link(sourceId, targetId)
  },
}))
