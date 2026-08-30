import { create } from 'zustand'
import { Storage } from '~/lib/storage'
import { pushModeSelect } from '~/lib/mode-sync'

/**
 * Preferência do modo Brain (memória persistente): o valor efetivo é
 * `override ?? default` — o default fica ativo para novos usuários
 * vem do model-mode-prefs; só os overrides por chat são persistidos aqui
 * (Storage) — ausência de override = segue o default.
 *
 * Chats novos (sem sessão) usam a chave "draft"; quando a sessão é criada no
 * primeiro envio, o session-store chama adopt() para transferir o override.
 */

const STORAGE_KEY = 'orbit_brain_prefs'
const DRAFT_KEY = 'draft'

type Overrides = Record<string, boolean>

interface BrainPrefsState {
  overrides: Overrides
  hydrated: boolean
  hydrate: () => Promise<void>
  setEnabled: (sessionId: string | null | undefined, enabled: boolean) => void
  /** Aplica o mapa vindo do desktop (sem devolver o toggle para lá). */
  applySync: (overrides: Overrides) => void
  /** Transfere o override do rascunho para a sessão recém-criada */
  adopt: (sessionId: string) => void
}

export const useBrainPrefs = create<BrainPrefsState>((set, get) => ({
  overrides: {},
  hydrated: false,

  hydrate: async () => {
    try {
      const raw = await Storage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as Overrides
        if (parsed && typeof parsed === 'object') {
          set({ overrides: parsed, hydrated: true })
          return
        }
      }
    } catch {
      // prefs corrompidas — volta ao default (vem do model-mode-prefs)
    }
    set({ hydrated: true })
  },

  setEnabled: (sessionId, enabled) => {
    const key = sessionId ?? DRAFT_KEY
    const overrides = { ...get().overrides }
    if (enabled) delete overrides[key]
    else overrides[key] = false
    void Storage.setItem(STORAGE_KEY, JSON.stringify(overrides))
    set({ overrides })
    pushModeSelect('brain', sessionId, enabled)
  },

  applySync: (overrides) => {
    void Storage.setItem(STORAGE_KEY, JSON.stringify(overrides))
    set({ overrides })
  },

  adopt: (sessionId) => {
    const overrides = { ...get().overrides }
    if (overrides[DRAFT_KEY] === undefined) return
    const value = overrides[DRAFT_KEY]
    overrides[sessionId] = value
    delete overrides[DRAFT_KEY]
    void Storage.setItem(STORAGE_KEY, JSON.stringify(overrides))
    set({ overrides })
    pushModeSelect('brain', sessionId, value ?? true)
  },
}))

export function useBrainEnabled(sessionId?: string | null, fallback = true): boolean {
  return useBrainPrefs((s) => s.overrides[sessionId ?? DRAFT_KEY] ?? fallback)
}

/** Leitura fora de componentes React (callbacks de envio) */
export function brainEnabledFor(sessionId?: string | null, fallback = true): boolean {
  return useBrainPrefs.getState().overrides[sessionId ?? DRAFT_KEY] ?? fallback
}
