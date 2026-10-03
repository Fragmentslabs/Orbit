import { useCallback } from "react"
import { create } from "zustand"
import type { ModelReasoningPref } from "@shared/companion"

/**
 * Preferências de reasoning por modelo (toggle + variant selecionada),
 * persistidas em localStorage e compartilhadas entre os inputs de chat/código.
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
 * Copia a preferência de cada chave velha para a nova (renomeação no catálogo).
 * A velha fica: outro chat ainda salvo com o id antigo continua achando o nível.
 * Uma preferência já existente sob a chave nova vence — é escolha mais recente.
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

/** Chaves "provedor/modelo" com preferência salva. */
export function reasoningPrefKeys(): string[] {
  return Object.keys(useReasoningPrefsStore.getState().prefs)
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
