import { create } from 'zustand'
import type { Memory } from '@orbit/shared'
import { useConnectionStore } from './connection-store'

interface MemoryState {
  /** Complete memory index of the desktop. */
  index: Memory[]
  loading: boolean
  /** There has already been an automatic load (the pull-to-refresh of the screen uses `fetch`). */
  loadedOnce: boolean

  /** Fetches the index via WS. */
  fetch: () => Promise<void>
  /**
   * Lazy load for whoever only needs to RESOLVE an id — the memory chip
   * in a conversation. It fetches at most once per session: without that, each chip of
   * each message would fire the same list.
   */
  ensureIndex: () => Promise<void>
  /** Edits text/tags/weight. */
  update: (id: string, patch: { text?: string; tags?: string[]; weight?: number }) => Promise<void>
  /** Deletes a memory (and the attached doc). */
  remove: (id: string) => Promise<void>
  /** Promotes (seasonal → core; project/context → decision). */
  promote: (id: string) => Promise<void>
  /** Attached .md document (hasDoc). */
  openDoc: (id: string) => Promise<string | null>
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  index: [],
  loading: false,
  loadedOnce: false,

  ensureIndex: async () => {
    if (get().loadedOnce) return
    // Marked before the call: one chip per message would ask for the list at the same time.
    set({ loadedOnce: true })
    await get().fetch()
  },

  fetch: async () => {
    const { wsClient } = useConnectionStore.getState()
    set({ loading: true })
    try {
      const res = await wsClient.send({ type: 'memory:list' })
      if (res.ok && Array.isArray(res.data)) {
        set({ index: res.data as Memory[] })
      }
    } catch {
      // WS unavailable — keeps the current index
    } finally {
      set({ loading: false })
    }
  },

  update: async (id, patch) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'memory:update', id, patch })
    if (res.ok && res.data) {
      const updated = res.data as Memory
      set((state) => ({ index: state.index.map((m) => (m.id === updated.id ? updated : m)) }))
    }
  },

  remove: async (id) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'memory:delete', id })
    if (res.ok) {
      set((state) => ({ index: state.index.filter((m) => m.id !== id) }))
    }
  },

  promote: async (id) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'memory:promote', id })
    if (res.ok && res.data) {
      const updated = res.data as Memory
      set((state) => ({ index: state.index.map((m) => (m.id === updated.id ? updated : m)) }))
    }
  },

  openDoc: async (id) => {
    const { wsClient } = useConnectionStore.getState()
    try {
      const res = await wsClient.send({ type: 'memory:doc', id })
      if (res.ok) return (res.data as string | null) ?? null
    } catch {
      // no doc
    }
    return null
  },
}))
