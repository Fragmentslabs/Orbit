import { useCallback } from 'react'
import { create } from 'zustand'
import type { ModelReasoningPref, ReasoningPrefsMap } from '@orbit/shared'
import { Storage } from '~/lib/storage'
import { useConnectionStore } from '~/stores/connection-store'

const STORAGE_KEY = 'orbit-reasoning-prefs'

type ReasoningPrefs = ReasoningPrefsMap

async function load(): Promise<ReasoningPrefs> {
  try {
    const raw = await Storage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as ReasoningPrefs) : {}
  } catch {
    return {}
  }
}

interface ReasoningPrefsState {
  prefs: ReasoningPrefs
  hydrated: boolean
  hydrate: () => Promise<void>
  setPref: (modelKey: string, pref: ModelReasoningPref) => Promise<void>
  /** Aplica o mapa vindo do desktop. `fillOnly` (snapshot do connect) só
   *  preenche o que o aparelho não tem — preserva toggle feito offline; sem
   *  ele (evento ao vivo) o mapa do desktop substitui, como no session-modes. */
  applySync: (remote: ReasoningPrefsMap, fillOnly?: boolean) => void
}

export const useReasoningPrefsStore = create<ReasoningPrefsState>((set, get) => ({
  prefs: {},
  hydrated: false,

  hydrate: async () => {
    const prefs = await load()
    set({ prefs, hydrated: true })
  },

  setPref: async (modelKey, pref) => {
    const prefs = { ...get().prefs, [modelKey]: pref }
    await Storage.setItem(STORAGE_KEY, JSON.stringify(prefs))
    set({ prefs })
  },

  applySync: (remote, fillOnly = false) => {
    if (!remote || typeof remote !== 'object') return
    const prefs = fillOnly ? { ...get().prefs } : {}
    let changed = false
    for (const [modelKey, pref] of Object.entries(remote)) {
      if (!pref || typeof pref.enabled !== 'boolean') continue
      if (fillOnly && prefs[modelKey] !== undefined) continue
      prefs[modelKey] = pref
      changed = true
    }
    if (!changed) return
    void Storage.setItem(STORAGE_KEY, JSON.stringify(prefs))
    set({ prefs, hydrated: true })
  },
}))

export function useReasoningPrefs(
  providerId: string | undefined,
  modelId: string | undefined,
) {
  const key = providerId && modelId ? `${providerId}/${modelId}` : null
  const pref = useReasoningPrefsStore((s) => (key ? s.prefs[key] : undefined))
  const setPref = useReasoningPrefsStore((s) => s.setPref)
  const hydrate = useReasoningPrefsStore((s) => s.hydrate)
  const hydrated = useReasoningPrefsStore((s) => s.hydrated)

  const update = useCallback(
    (next: ModelReasoningPref) => {
      if (!key) return
      setPref(key, next)
      // O desktop é a fonte da verdade do thinking por modelo: o toggle segue
      // via WS ('reasoning:select'), o renderer de lá persiste e devolve o
      // mapa inteiro a todos os aparelhos pelo broadcast 'reasoning:change'.
      // Desconectado o send fica na fila do wsClient e sai na reconexão.
      const { wsClient } = useConnectionStore.getState()
      if (wsClient && providerId && modelId) {
        void wsClient
          .send({ type: 'reasoning:select', providerId, modelId, pref: next })
          .catch(() => {})
      }
    },
    [key, setPref, providerId, modelId],
  )

  return {
    enabled: pref?.enabled ?? false,
    variantId: pref?.variantId,
    update,
    hydrate,
    hydrated,
  }
}
