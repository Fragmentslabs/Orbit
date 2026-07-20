import { create } from 'zustand'
import type { AskItem } from '@orbit/shared'
import { useConnectionStore } from './connection-store'
import { Storage } from '~/lib/storage'

const CACHE_ASKS_PREFIX = 'orbit_cache_asks_'

async function cacheAsks(sessionId: string, asks: PendingAsk[]) {
  await Storage.setItem(CACHE_ASKS_PREFIX + sessionId, JSON.stringify(asks))
}

async function loadCachedAsks(sessionId: string): Promise<PendingAsk[] | null> {
  try {
    const raw = await Storage.getItem(CACHE_ASKS_PREFIX + sessionId)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

export { loadCachedAsks, CACHE_ASKS_PREFIX }

// ─── Types ──────────────────────────────────────────────────────────────────

/** Pedido pendente exibido como card no chat. */
export interface PendingAsk extends AskItem {
  title?: string
  batchId?: string
}

interface ChatState {
  /** Pedidos de permissão/question pendentes, por sessão. */
  pendingAsks: Record<string, PendingAsk[]>
  /** ID da sessão que tem pending ask (atalho para UI). */
  activeAskSessionId: string | null

  /** Adiciona um pending ask recebido via WS. */
  addPendingAsk: (sessionId: string, ask: PendingAsk) => void
  /** Remove um pending ask (respondido). */
  removePendingAsk: (sessionId: string, requestId: string) => void
  /** Define os pending asks de uma sessão (usado ao carregar cache). */
  setPendingAsks: (sessionId: string, asks: PendingAsk[]) => void
  /** Responde a um pending ask via WS. */
  replyToAsk: (requestId: string, value: unknown) => Promise<void>
  /** Retorna todos os asks de uma sessão. */
  getAsks: (sessionId: string) => PendingAsk[]
}

// ─── Store ──────────────────────────────────────────────────────────────────

export const useChatStore = create<ChatState>((set, get) => ({
  pendingAsks: {},
  activeAskSessionId: null,

  addPendingAsk: (sessionId, ask) => {
    set((state) => {
      const current = state.pendingAsks[sessionId] ?? []
      // Deduplica por requestId
      if (current.some((a) => a.requestId === ask.requestId)) return state
      const next = [...current, ask]
      void cacheAsks(sessionId, next)
      return {
        pendingAsks: { ...state.pendingAsks, [sessionId]: next },
        activeAskSessionId: sessionId,
      }
    })
  },

  removePendingAsk: (sessionId, requestId) => {
    set((state) => {
      const current = state.pendingAsks[sessionId]
      if (!current?.some((a) => a.requestId === requestId)) return state
      const next = current.filter((a) => a.requestId !== requestId)
      const pendingAsks = { ...state.pendingAsks }
      if (next.length === 0) {
        delete pendingAsks[sessionId]
        void Storage.removeItem(CACHE_ASKS_PREFIX + sessionId)
      } else {
        pendingAsks[sessionId] = next
        void cacheAsks(sessionId, next)
      }
      // Atualiza activeAskSessionId
      const activeAskSessionId = Object.keys(pendingAsks).length > 0
        ? Object.keys(pendingAsks)[0]
        : null
      return { pendingAsks, activeAskSessionId }
    })
  },

  setPendingAsks: (sessionId, asks) => {
    set((state) => ({
      pendingAsks: { ...state.pendingAsks, [sessionId]: asks },
      activeAskSessionId: state.activeAskSessionId ?? sessionId,
    }))
  },

  replyToAsk: async (requestId, value) => {
    const { wsClient } = useConnectionStore.getState()
    try {
      await wsClient.send({ type: 'ask:reply', requestId, value })
    } catch {
      // Silently fail
    }
  },

  getAsks: (sessionId) => {
    return get().pendingAsks[sessionId] ?? []
  },
}))
