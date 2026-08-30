import { create } from 'zustand'
import { Storage } from '~/lib/storage'
import { pushModeSelect } from '~/lib/mode-sync'

/**
 * Preferência do modo Simples (resposta em texto puro): desativado por padrão
 * em todo chat; o usuário pode ligar por chat. Só as ativações são persistidas
 * (Storage) — ausência de override = desativado.
 *
 * Chats novos (sem sessão) usam a chave "draft"; quando a sessão é criada no
 * primeiro envio, o session-store chama adopt() para transferir o override.
 */

const STORAGE_KEY = 'orbit_simple_prefs'
const DRAFT_KEY = 'draft'

type Overrides = Record<string, boolean | undefined>

interface SimplePrefsState {
  overrides: Overrides
  hydrated: boolean
  hydrate: () => Promise<void>
  setEnabled: (sessionId: string | null | undefined, value: boolean) => void
  /** Aplica o mapa vindo do desktop (sem devolver o toggle para lá). */
  applySync: (overrides: Overrides) => void
  adopt: (sessionId: string) => void
  clear: (sessionId: string) => void
}

export const useSimplePrefs = create<SimplePrefsState>((set, get) => ({
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
      // prefs corrompidas — volta ao default (desativado)
    }
    set({ hydrated: true })
  },

  setEnabled: (sessionId, value) => {
    const key = sessionId ?? DRAFT_KEY
    const overrides = { ...get().overrides }
    if (value) overrides[key] = true
    else delete overrides[key]
    void Storage.setItem(STORAGE_KEY, JSON.stringify(overrides))
    set({ overrides })
    pushModeSelect('simple', sessionId, value)
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
    pushModeSelect('simple', sessionId, value ?? false)
  },

  clear: (sessionId) => {
    const overrides = { ...get().overrides }
    delete overrides[sessionId]
    void Storage.setItem(STORAGE_KEY, JSON.stringify(overrides))
    set({ overrides })
  },
}))

export function useSimpleMode(sessionId?: string | null, fallback = false): boolean {
  return useSimplePrefs((s) => s.overrides[sessionId ?? DRAFT_KEY] ?? fallback)
}

export function simpleModeFor(sessionId?: string | null, fallback = false): boolean {
  return useSimplePrefs.getState().overrides[sessionId ?? DRAFT_KEY] ?? fallback
}
