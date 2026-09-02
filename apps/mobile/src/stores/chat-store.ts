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
  /**
   * Aplica a lista autoritativa vinda do desktop (session:state) ao abrir o
   * chat: mostra o que o desktop mostra e descarta card já respondido enquanto
   * o celular estava fora. `knownIds` são os requestIds que existiam quando a
   * busca saiu — pedido que chegou ao vivo depois dela ainda não está no disco
   * do desktop e é preservado.
   */
  syncPendingAsks: (sessionId: string, serverAsks: PendingAsk[], knownIds: Set<string>) => void
  /** Responde a um pending ask via WS. */
  replyToAsk: (requestId: string, value: unknown) => Promise<void>
  /** Retorna todos os asks de uma sessão. */
  getAsks: (sessionId: string) => PendingAsk[]
}

/**
 * Grava a lista de uma sessão no estado + cache e mantém activeAskSessionId
 * coerente (aponta para alguma sessão com pedido, ou null quando não há mais).
 */
function applyAsks(
  state: ChatState,
  sessionId: string,
  asks: PendingAsk[],
): Pick<ChatState, 'pendingAsks' | 'activeAskSessionId'> {
  const pendingAsks = { ...state.pendingAsks }
  if (asks.length === 0) {
    delete pendingAsks[sessionId]
    void Storage.removeItem(CACHE_ASKS_PREFIX + sessionId)
  } else {
    pendingAsks[sessionId] = asks
    void cacheAsks(sessionId, asks)
  }
  const activeAskSessionId =
    asks.length > 0
      ? sessionId
      : state.activeAskSessionId === sessionId
        ? (Object.keys(pendingAsks)[0] ?? null)
        : state.activeAskSessionId
  return { pendingAsks, activeAskSessionId }
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
    set((state) => applyAsks(state, sessionId, asks))
  },

  syncPendingAsks: (sessionId, serverAsks, knownIds) => {
    set((state) => {
      const current = state.pendingAsks[sessionId] ?? []
      const serverIds = new Set(serverAsks.map((a) => a.requestId))
      const recemChegados = current.filter(
        (a) => !serverIds.has(a.requestId) && !knownIds.has(a.requestId),
      )
      return applyAsks(state, sessionId, [...serverAsks, ...recemChegados])
    })
  },

  replyToAsk: async (requestId, value) => {
    const { wsClient } = useConnectionStore.getState()
    try {
      const res = await wsClient.send({ type: 'ask:reply', requestId, value })
      // ok:false = o desktop nao tem mais esse pedido em aberto (respondido em
      // outro lugar, ou o app reiniciou e o card sobreviveu so no disco). Nao
      // vira 'ask:done', entao o card seria eterno — some aqui mesmo.
      if (!res.ok) {
        const sessionId = Object.keys(get().pendingAsks).find((id) =>
          get().pendingAsks[id]?.some((a) => a.requestId === requestId),
        )
        if (sessionId) get().removePendingAsk(sessionId, requestId)
      }
    } catch {
      // Sem rede: mantem o card para tentar de novo depois de reconectar
    }
  },

  getAsks: (sessionId) => {
    return get().pendingAsks[sessionId] ?? []
  },
}))
