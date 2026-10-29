import { create } from 'zustand'
import type { PermissionMode } from '@orbit/shared'
import { Storage } from '~/lib/storage'
import { useConnectionStore } from '~/stores/connection-store'

/**
 * Nível de autonomia POR CHAT, espelho do desktop.
 *
 * `defaultMode` é o padrão de chat novo (e o fallback de quem nunca escolheu);
 * `modes` guarda a escolha de cada sessão — mudar para Irrestrito num chat não
 * afrouxa os outros. Vive fora do PromptInput porque o card de revisão de plano
 * também lê o nível do chat.
 */

const DEFAULT_KEY = 'orbit-permission-mode'
const STORAGE_KEY = 'orbit_session_permission'
export const DRAFT_KEY = 'draft'

function isMode(value: unknown): value is PermissionMode {
  return value === 'ask' || value === 'approve' || value === 'full'
}

interface PermissionPrefsState {
  defaultMode: PermissionMode
  modes: Record<string, PermissionMode>
  hydrated: boolean
  hydrate: () => Promise<void>
  /** Escolha feita aqui: avisa o desktop (fonte da verdade) e espera o mapa
   *  voltar pelo 'session:prefs-change'. O rascunho é por aparelho. */
  setMode: (sessionId: string | null | undefined, mode: PermissionMode) => void
  /** Troca que veio do desktop (snapshot ou evento). */
  applyRemoteMode: (sessionId: string, mode: PermissionMode) => void
  /** Preferência do app vinda do desktop: padrão de chat novo. */
  setDefaultMode: (mode: PermissionMode) => void
  adopt: (sessionId: string) => void
  clear: (sessionId: string) => void
}

async function write(modes: Record<string, PermissionMode>) {
  await Storage.setItem(STORAGE_KEY, JSON.stringify(modes))
}

function normalizar(map: unknown): Record<string, PermissionMode> {
  const out: Record<string, PermissionMode> = {}
  if (!map || typeof map !== 'object') return out
  for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
    if (isMode(value)) out[key] = value
  }
  return out
}

export const usePermissionPrefs = create<PermissionPrefsState>((set, get) => ({
  defaultMode: 'ask',
  modes: {},
  hydrated: false,

  hydrate: async () => {
    try {
      const stored = await Storage.getItem(DEFAULT_KEY)
      if (isMode(stored)) set({ defaultMode: stored })
    } catch {
      // preferência ilegível — segue no padrão mais conservador (ask)
    }
    try {
      const raw = await Storage.getItem(STORAGE_KEY)
      if (raw) set({ modes: normalizar(JSON.parse(raw)) })
    } catch {
      // mapa corrompido — todo chat segue o padrão
    }
    set({ hydrated: true })
  },

  setMode: (sessionId, mode) => {
    if (!isMode(mode)) return
    const key = sessionId ?? DRAFT_KEY
    const modes = { ...get().modes, [key]: mode }
    void write(modes)

    if (sessionId) {
      set({ modes })
      const { wsClient } = useConnectionStore.getState()
      try {
        void wsClient.send({ type: 'session:prefs-select', sessionId, permission: mode }).catch(() => {})
      } catch {
        // Offline: o turno daqui leva o nível desta sessão.
      }
      return
    }

    // Chat novo: vira também o padrão do aparelho (mesmo contrato do desktop).
    void Storage.setItem(DEFAULT_KEY, mode)
    set({ modes, defaultMode: mode })
  },

  applyRemoteMode: (sessionId, mode) => {
    if (!sessionId || !isMode(mode)) return
    const modes = { ...get().modes, [sessionId]: mode }
    void write(modes)
    set({ modes })
  },

  setDefaultMode: (mode) => {
    if (!isMode(mode)) return
    void Storage.setItem(DEFAULT_KEY, mode)
    set({ defaultMode: mode })
  },

  adopt: (sessionId) => {
    const { modes } = get()
    if (!(DRAFT_KEY in modes)) return
    const next = { ...modes, [sessionId]: modes[DRAFT_KEY] }
    delete next[DRAFT_KEY]
    void write(next)
    set({ modes: next })
  },

  clear: (sessionId) => {
    const modes = { ...get().modes }
    delete modes[sessionId]
    void write(modes)
    set({ modes })
  },
}))

/** Nível efetivo do chat: override da sessão > padrão do app. */
export function permissionFor(sessionId?: string | null): PermissionMode {
  const { modes, defaultMode } = usePermissionPrefs.getState()
  return modes[sessionId ?? DRAFT_KEY] ?? defaultMode
}

export function usePermissionMode(sessionId?: string | null): PermissionMode {
  const key = sessionId ?? DRAFT_KEY
  return usePermissionPrefs((s) => s.modes[key] ?? s.defaultMode)
}
