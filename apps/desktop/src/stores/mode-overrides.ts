import { create } from "zustand"

/**
 * Ativação por chat dos modos que antes eram estado local dos inputs
 * (pesquisa, navegador, plano, subagentes, orquestração e visão).
 *
 * Semântica igual a brain-prefs/simple-prefs: o valor efetivo é
 * `override ?? default`, onde o default vem das preferências
 * (model-mode-prefs, separado por modo chat/code). Chats novos (sem sessão)
 * usam a chave "draft"; quando a sessão é criada no primeiro envio, o
 * session-store chama adopt() para transferir os overrides.
 */

export type OverridableMode = "search" | "browser" | "plan" | "subagents" | "orchestra" | "vision"

const STORAGE_KEY = "orbit-mode-overrides"
const DRAFT_KEY = "draft"

type OverrideMap = Partial<Record<OverridableMode, Record<string, boolean>>>

function load(): OverrideMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as OverrideMap
      if (parsed && typeof parsed === "object") return parsed
    }
  } catch {
    // prefs corrompidas → sem overrides
  }
  return {}
}

function persist(overrides: OverrideMap) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides))
}

interface ModeOverridesState {
  overrides: OverrideMap
  setMode: (mode: OverridableMode, sessionId: string | null | undefined, value: boolean) => void
  /** Transfere os overrides do rascunho para a sessão recém-criada */
  adopt: (sessionId: string) => void
}

export const useModeOverrides = create<ModeOverridesState>((set) => ({
  overrides: load(),
  setMode: (mode, sessionId, value) => {
    const key = sessionId ?? DRAFT_KEY
    set((state) => {
      const bySession = { ...state.overrides[mode], [key]: value }
      const overrides = { ...state.overrides, [mode]: bySession }
      persist(overrides)
      return { overrides }
    })
  },
  adopt: (sessionId) => {
    set((state) => {
      const overrides: OverrideMap = {}
      let changed = false
      for (const mode of Object.keys(state.overrides) as OverridableMode[]) {
        const bySession = state.overrides[mode]
        if (!bySession || bySession[DRAFT_KEY] === undefined) {
          overrides[mode] = bySession
          continue
        }
        changed = true
        overrides[mode] = { ...bySession, [sessionId]: bySession[DRAFT_KEY] }
        delete overrides[mode]![DRAFT_KEY]
      }
      if (!changed) return {}
      persist(overrides)
      return { overrides }
    })
  },
}))

export function useModeActive(mode: OverridableMode, sessionId?: string | null, fallback = false): boolean {
  return useModeOverrides((s) => s.overrides[mode]?.[sessionId ?? DRAFT_KEY] ?? fallback)
}

/** Leitura fora de componentes React (callbacks de envio) */
export function modeActiveFor(mode: OverridableMode, sessionId?: string | null, fallback = false): boolean {
  return useModeOverrides.getState().overrides[mode]?.[sessionId ?? DRAFT_KEY] ?? fallback
}
