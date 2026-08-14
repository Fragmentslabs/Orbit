import { create } from 'zustand'
import { Storage } from '~/lib/storage'

/**
 * Preferência do modo Brain (memória persistente): ativo por padrão em todo
 * chat, nos dois modos; o usuário pode desativar por chat. Só as desativações
 * são persistidas (Storage) — ausência de override = ativo.
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
      // prefs corrompidas — volta ao default (tudo ativo)
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
  },

  adopt: (sessionId) => {
    const overrides = { ...get().overrides }
    if (overrides[DRAFT_KEY] === undefined) return
    overrides[sessionId] = overrides[DRAFT_KEY]
    delete overrides[DRAFT_KEY]
    void Storage.setItem(STORAGE_KEY, JSON.stringify(overrides))
    set({ overrides })
  },
}))

export function useBrainEnabled(sessionId?: string | null, fallback = true): boolean {
  return useBrainPrefs((s) => s.overrides[sessionId ?? DRAFT_KEY] ?? fallback)
}

/** Leitura fora de componentes React (callbacks de envio) */
export function brainEnabledFor(sessionId?: string | null, fallback = true): boolean {
  return useBrainPrefs.getState().overrides[sessionId ?? DRAFT_KEY] ?? fallback
}
