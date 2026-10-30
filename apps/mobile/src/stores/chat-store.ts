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

/** Pending request displayed as a card in the chat. */
export interface PendingAsk extends AskItem {
  title?: string
  batchId?: string
}

interface ChatState {
  /** Permission/question requests pending, per session. */
  pendingAsks: Record<string, PendingAsk[]>
  /** ID of the session that has a pending ask (shortcut for the UI). */
  activeAskSessionId: string | null

  /** Adds a pending ask received via WS. */
  addPendingAsk: (sessionId: string, ask: PendingAsk) => void
  /** Removes a pending ask (answered). */
  removePendingAsk: (sessionId: string, requestId: string) => void
  /** Sets the pending asks of a session (used when loading the cache). */
  setPendingAsks: (sessionId: string, asks: PendingAsk[]) => void
  /**
   * Applies the authoritative list coming from the desktop (session:state) on opening the
   * chat: shows what the desktop shows and discards a card already answered while
   * the phone was away. `knownIds` are the requestIds that existed when the
   * fetch left — a request that arrived live after it is not yet on the desktop
   * disk and is preserved.
   */
  syncPendingAsks: (sessionId: string, serverAsks: PendingAsk[], knownIds: Set<string>) => void
  /** Answers a pending ask via WS. */
  replyToAsk: (requestId: string, value: unknown) => Promise<void>
  /** Returns all the asks of a session. */
  getAsks: (sessionId: string) => PendingAsk[]
}

/**
 * Writes the list of a session to the state + cache and keeps activeAskSessionId
 * consistent (pointing to some session with a request, or null when there are none left).
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
      // Deduplicates by requestId
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
      // Updates activeAskSessionId
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
      // ok:false = the desktop no longer has that request open (answered somewhere
      // else, or the app restarted and the card survived only on disk). It does not
      // become 'ask:done', so the card would be eternal — it disappears right here.
      if (!res.ok) {
        const sessionId = Object.keys(get().pendingAsks).find((id) =>
          get().pendingAsks[id]?.some((a) => a.requestId === requestId),
        )
        if (sessionId) get().removePendingAsk(sessionId, requestId)
      }
    } catch {
      // No network: keeps the card to try again after reconnecting
    }
  },

  getAsks: (sessionId) => {
    return get().pendingAsks[sessionId] ?? []
  },
}))
