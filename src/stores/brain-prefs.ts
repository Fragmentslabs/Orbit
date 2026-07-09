import { create } from "zustand"

/**
 * Preferência do modo Brain (memória persistente): ativo por padrão em todo
 * chat, nos dois modos; o usuário pode desativar por chat. Só as desativações
 * são persistidas (localStorage) — ausência de override = ativo.
 *
 * Chats novos (sem sessão) usam a chave "draft"; quando a sessão é criada no
 * primeiro envio, o session-store chama adopt() para transferir o override.
 */

const STORAGE_KEY = "orbit-brain-prefs"
const DRAFT_KEY = "draft"

function load(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    // prefs corrompidas — volta ao default (tudo ativo)
  }
  return {}
}

function persist(overrides: Record<string, boolean>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides))
}

interface BrainPrefsState {
  overrides: Record<string, boolean>
  setEnabled: (sessionId: string | null | undefined, enabled: boolean) => void
  /** Transfere o override do rascunho para a sessão recém-criada */
  adopt: (sessionId: string) => void
}

export const useBrainPrefs = create<BrainPrefsState>((set, get) => ({
  overrides: load(),
  setEnabled: (sessionId, enabled) => {
    const key = sessionId ?? DRAFT_KEY
    const overrides = { ...get().overrides }
    if (enabled) delete overrides[key]
    else overrides[key] = false
    persist(overrides)
    set({ overrides })
  },
  adopt: (sessionId) => {
    const overrides = { ...get().overrides }
    if (overrides[DRAFT_KEY] === undefined) return
    overrides[sessionId] = overrides[DRAFT_KEY]
    delete overrides[DRAFT_KEY]
    persist(overrides)
    set({ overrides })
  },
}))

export function useBrainEnabled(sessionId?: string | null): boolean {
  return useBrainPrefs((s) => s.overrides[sessionId ?? DRAFT_KEY] ?? true)
}

/** Leitura fora de componentes React (callbacks de envio) */
export function brainEnabledFor(sessionId?: string | null): boolean {
  return useBrainPrefs.getState().overrides[sessionId ?? DRAFT_KEY] ?? true
}
