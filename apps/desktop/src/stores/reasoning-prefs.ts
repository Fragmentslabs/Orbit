import { useCallback } from "react"
import { create } from "zustand"
import type { ModelReasoningPref } from "@shared/companion"

/**
 * Reasoning preferences per model (toggle + selected variant),
 * persisted in localStorage and shared between the chat/code inputs.
 */

const STORAGE_KEY = "orbit-reasoning-prefs"

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

export const useReasoningPrefsStore = create<ReasoningPrefsState>((set) => ({
  prefs: load(),
  setPref: (modelKey, pref) =>
    set((state) => {
      const prefs = { ...state.prefs, [modelKey]: pref }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
      return { prefs }
    }),
}))

/**
 * Copies each old key's preference to the new one (rename in the catalog).
 * The old one stays: another chat still saved with the old id keeps finding the level.
 * A preference that already exists under the new key wins — it is the more recent choice.
 */
export function copyReasoningPrefs(pairs: Array<[string, string]>) {
  const { prefs } = useReasoningPrefsStore.getState()
  const next = { ...prefs }
  let changed = false
  for (const [from, to] of pairs) {
    if (prefs[from] && !prefs[to]) {
      next[to] = prefs[from]
      changed = true
    }
  }
  if (!changed) return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  useReasoningPrefsStore.setState({ prefs: next })
}

/** "provider/model" keys with a saved preference. */
export function reasoningPrefKeys(): string[] {
  return Object.keys(useReasoningPrefsStore.getState().prefs)
}

/**
 * A model's preference read straight from storage, on the spot.
 *
 * The overlay is another window: its in-memory copy does not follow what the
 * main window writes. Without this, the thinking level chosen in the
 * Preferences would only apply in the panel after restarting the app.
 */
export function readReasoningPref(
  providerId: string | undefined,
  modelId: string | undefined,
): ModelReasoningPref | undefined {
  if (!providerId || !modelId) return undefined
  try {
    const prefs = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as ReasoningPrefs
    return prefs[`${providerId}/${modelId}`]
  } catch {
    return undefined
  }
}

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
