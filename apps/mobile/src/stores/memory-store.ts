import { create } from 'zustand'
import type { Memory } from '@orbit/shared'
import { useConnectionStore } from './connection-store'

interface MemoryState {
  /** Índice completo de memórias do desktop. */
  index: Memory[]
  loading: boolean
  /** Já houve uma carga automática (o pull-to-refresh da tela usa `fetch`). */
  loadedOnce: boolean

  /** Busca o índice via WS. */
  fetch: () => Promise<void>
  /**
   * Carga preguiçosa para quem só precisa RESOLVER um id — o chip de memória
   * numa conversa. Busca no máximo uma vez por sessão: sem isso, cada chip de
   * cada mensagem dispararia a mesma lista.
   */
  ensureIndex: () => Promise<void>
  /** Edita texto/tags/peso. */
  update: (id: string, patch: { text?: string; tags?: string[]; weight?: number }) => Promise<void>
  /** Exclui uma memória (e o doc anexado). */
  remove: (id: string) => Promise<void>
  /** Promove (seasonal → core; project/context → decision). */
  promote: (id: string) => Promise<void>
  /** Documento .md anexado (hasDoc). */
  openDoc: (id: string) => Promise<string | null>
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  index: [],
  loading: false,
  loadedOnce: false,

  ensureIndex: async () => {
    if (get().loadedOnce) return
    // Marca antes da chamada: um chip por mensagem pediria a lista ao mesmo tempo.
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
      // WS indisponível — mantém o índice atual
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
      // sem doc
    }
    return null
  },
}))
