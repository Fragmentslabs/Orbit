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
  /** Applies the map coming from the desktop. `fillOnly` (connect snapshot) only
   *  fills in what the device does not have — it preserves a toggle made offline; without
   *  it (live event) the desktop map replaces, as in session-modes. */
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
      // The desktop is the source of truth for the thinking per model: the toggle goes
      // via WS ('reasoning:select'), the renderer there persists it and sends the whole
      // map back to all devices through the broadcast 'reasoning:change'.
      // Disconnected, the send stays in the wsClient queue and goes out on reconnection.
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
