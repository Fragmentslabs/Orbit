import { useCallback } from 'react'
import { create } from 'zustand'
import { Storage } from '~/lib/storage'

const STORAGE_KEY = 'orbit-reasoning-prefs'

export interface ModelReasoningPref {
  enabled: boolean
  variantId?: string
}

type ReasoningPrefs = Record<string, ModelReasoningPref>

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
}

const useReasoningPrefsStore = create<ReasoningPrefsState>((set, get) => ({
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
      if (key) setPref(key, next)
    },
    [key, setPref],
  )

  return {
    enabled: pref?.enabled ?? false,
    variantId: pref?.variantId,
    update,
    hydrate,
    hydrated,
  }
}
