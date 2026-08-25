import { create } from "zustand"
import type { Memory, MemoryEvent } from "@shared/memory"
import { memoryApi } from "@/src/lib/ipc"

/**
 * Store da view de Memórias. O índice completo vem do main (memory:list) e é
 * mantido em sincronia pelos MemoryEvents (canal memory:event) — toda mutação
 * feita pelo agente ou pela UI reflete aqui em tempo real.
 */

interface MemoryState {
  initialized: boolean
  /** true até o primeiro list() responder — a view mostra skeleton nesse meio. */
  loading: boolean
  index: Memory[]
  /** Documentos markdown carregados sob demanda, por id */
  docs: Record<string, string>

  initialize: () => Promise<void>
  refresh: () => Promise<void>
  openDoc: (id: string) => Promise<string | null>
  update: (id: string, patch: Partial<Pick<Memory, "text" | "tags" | "weight">>) => Promise<void>
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
      set((state) => {
        // Invalida o doc em cache — pode ter sido atualizado/removido junto
        const docs = { ...state.docs }
        delete docs[event.memory.id]
        return { index: applyEvent(event, state.index), docs }
      })
    })
    await get().refresh()
  },

  refresh: async () => {
    try {
      const index = await memoryApi.list()
      set({ index })
    } finally {
      // Sai do skeleton mesmo se o list falhar, senão a tela fica carregando
      // para sempre em vez de mostrar o estado vazio.
      set({ loading: false })
    }
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
    await memoryApi.update(id, patch) // o memory:event atualiza o índice
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
