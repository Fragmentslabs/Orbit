import { create } from 'zustand'
import { Storage } from '~/lib/storage'
import { pushModeSelect } from '~/lib/mode-sync'

/**
 * Ativação por chat dos modos que antes eram estado local dos inputs
 * (pesquisa, navegador, plano, subagentes, orquestração e visão) — espelho do
 * mode-overrides do desktop.
 *
 * Semântica igual a brain-prefs/simple-prefs: o valor efetivo é
 * `override ?? default`, onde o default vem das preferências
 * (model-mode-prefs, separado por modo chat/code). Chats novos (sem sessão)
 * usam a chave "draft"; quando a sessão é criada no primeiro envio, o
 * session-store chama adopt() para transferir os overrides.
 */

export type OverridableMode =
  | 'search'
  | 'browser'
  | 'plan'
  | 'subagents'
  | 'orchestra'
  | 'vision'

const STORAGE_KEY = 'orbit_mode_overrides'
const DRAFT_KEY = 'draft'

type OverrideMap = Partial<Record<OverridableMode, Record<string, boolean>>>

function normalize(parsed: unknown): OverrideMap {
  if (!parsed || typeof parsed !== 'object') return {}
  return parsed as OverrideMap
}

interface ModeOverridesState {
  overrides: OverrideMap
  hydrated: boolean
  hydrate: () => Promise<void>
  setMode: (
    mode: OverridableMode,
    sessionId: string | null | undefined,
    value: boolean,
  ) => void
  /** Aplica o mapa vindo do desktop (sem devolver o toggle para lá). */
  applySync: (overrides: OverrideMap) => void
  /** Transfere os overrides do rascunho para a sessão recém-criada */
  adopt: (sessionId: string) => void
}

export const useModeOverrides = create<ModeOverridesState>((set, get) => ({
  overrides: {},
  hydrated: false,

  hydrate: async () => {
    try {
      const raw = await Storage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = normalize(JSON.parse(raw))
        set({ overrides: parsed, hydrated: true })
        return
      }
    } catch {
      // prefs corrompidas → sem overrides
    }
    set({ hydrated: true })
  },

  setMode: (mode, sessionId, value) => {
    const key = sessionId ?? DRAFT_KEY
    const bySession = { ...get().overrides[mode], [key]: value }
    const overrides = { ...get().overrides, [mode]: bySession }
    void Storage.setItem(STORAGE_KEY, JSON.stringify(overrides))
    set({ overrides })
    pushModeSelect(mode, sessionId, value)
  },

  applySync: (overrides) => {
    void Storage.setItem(STORAGE_KEY, JSON.stringify(overrides))
    set({ overrides })
  },

  adopt: (sessionId) => {
    const current = get().overrides
    const overrides: OverrideMap = {}
    let changed = false
    for (const mode of Object.keys(current) as OverridableMode[]) {
      const bySession = current[mode]
      if (!bySession || bySession[DRAFT_KEY] === undefined) {
        overrides[mode] = bySession
        continue
      }
      changed = true
      const next = { ...bySession, [sessionId]: bySession[DRAFT_KEY] }
      delete next[DRAFT_KEY]
      overrides[mode] = next
    }
    if (!changed) return
    void Storage.setItem(STORAGE_KEY, JSON.stringify(overrides))
    set({ overrides })
    // A sessão acabou de nascer no desktop sem modo nenhum: manda os do
    // rascunho, senão o chat abre lá nos defaults.
    for (const mode of Object.keys(overrides) as OverridableMode[]) {
      const value = overrides[mode]?.[sessionId]
      if (value !== undefined) pushModeSelect(mode, sessionId, value)
    }
  },
}))

export function useModeActive(
  mode: OverridableMode,
  sessionId?: string | null,
  fallback = false,
): boolean {
  return useModeOverrides((s) => s.overrides[mode]?.[sessionId ?? DRAFT_KEY] ?? fallback)
}

/** Leitura fora de componentes React (callbacks de envio) */
export function modeActiveFor(
  mode: OverridableMode,
  sessionId?: string | null,
  fallback = false,
): boolean {
  return useModeOverrides.getState().overrides[mode]?.[sessionId ?? DRAFT_KEY] ?? fallback
}
