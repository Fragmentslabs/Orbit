import { useCallback } from "react"
import { create } from "zustand"

/**
 * Preferências de reasoning por modelo (toggle + variant selecionada),
 * persistidas em localStorage e compartilhadas entre os inputs de chat/código.
 */

const STORAGE_KEY = "orbit-reasoning-prefs"

export interface ModelReasoningPref {
  enabled: boolean
  variantId?: string
}

type ReasoningPrefs = Record<string, ModelReasoningPref>

function load(): ReasoningPrefs {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as ReasoningPrefs
  } catch {
    return {}
  }
}

interface ReasoningPrefsState {
  prefs: ReasoningPrefs
  setPref: (modelKey: string, pref: ModelReasoningPref) => void
}

const useReasoningPrefsStore = create<ReasoningPrefsState>((set) => ({
  prefs: load(),
  setPref: (modelKey, pref) =>
    set((state) => {
      const prefs = { ...state.prefs, [modelKey]: pref }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
      return { prefs }
    }),
}))

export function useReasoningPrefs(providerId: string | undefined, modelId: string | undefined) {
  const key = providerId && modelId ? `${providerId}/${modelId}` : null
  const pref = useReasoningPrefsStore((s) => (key ? s.prefs[key] : undefined))
  const setPref = useReasoningPrefsStore((s) => s.setPref)

  const update = useCallback(
    (next: ModelReasoningPref) => {
      if (key) setPref(key, next)
    },
    [key, setPref],
  )

  return { enabled: pref?.enabled ?? false, variantId: pref?.variantId, update }
}
