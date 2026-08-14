import { create } from 'zustand'
import type { SessionInfo } from '@orbit/shared'
import { Storage } from '~/lib/storage'
import { useConnectionStore } from './connection-store'
import { useSessionStore } from './session-store'
import { useSettingsStore } from './settings-store'

/**
 * Modelo selecionado POR CHAT (mesmo padrão do desktop: o modelo segue a
 * sessão, não o app inteiro). `overrides` guarda o modelo escolhido de cada
 * sessão; chat novo usa a chave DRAFT até a criação da sessão (adopt). Sem
 * override, vale o último chat usado e, por fim, o default global (que é o
 * modelo selecionado no desktop, sincronizado via HTTP).
 *
 * Sincronização com o desktop: o desktop é a fonte de verdade dos overrides —
 * o renderer dele empurra o mapa para o main (que repassa aos companions via
 * WS 'session:model-change' e expõe em GET /api/session-models). O mobile
 * aplica o snapshot na hidratação e em eventos ao vivo; escolhas feitas no
 * mobile são enviadas via WS 'models:select' (com sessionId) e o desktop
 * aplica no store dele.
 */

const STORAGE_KEY = 'orbit_session_models'
const DRAFT_KEY = 'draft'

export interface SelectedModel {
  providerId: string
  modelId: string
}

export type SessionModelOverrides = Record<string, SelectedModel>

interface SessionModelPrefsState {
  overrides: SessionModelOverrides
  hydrated: boolean
  /** Aplica um snapshot vindo do desktop (HTTP ou WS). Só entra chave que o
   *  mobile não tem localmente — escolha local vence em conflito. */
  applySync: (remote: SessionModelOverrides) => void
  hydrate: () => Promise<void>
  selectModel: (sessionId: string | null | undefined, providerId: string, modelId: string) => void
  /** Move o override do draft (chat novo) para a sessão criada no 1º envio */
  adopt: (sessionId: string, fallback?: SelectedModel) => void
  clear: (sessionId: string) => void
}

export const useSessionModelPrefs = create<SessionModelPrefsState>((set, get) => ({
  overrides: {},
  hydrated: false,

  applySync: (remote) => {
    if (!remote || typeof remote !== 'object') return
    let changed = false
    const next = { ...get().overrides }
    for (const [key, value] of Object.entries(remote)) {
      if (next[key] === undefined && value && typeof value === 'object') {
        next[key] = { providerId: value.providerId, modelId: value.modelId }
        changed = true
      }
    }
    if (changed) {
      void Storage.setItem(STORAGE_KEY, JSON.stringify(next))
      set({ overrides: next })
    }
  },

  hydrate: async () => {
    try {
      const raw = await Storage.getItem(STORAGE_KEY)
      if (raw) set({ overrides: JSON.parse(raw) as SessionModelOverrides })
    } catch {
      // prefs corrompidas — segue vazio
    } finally {
      set({ hydrated: true })
    }

    // Snapshot dos overrides por sessão do desktop (renderer → main → HTTP)
    const { http } = useConnectionStore.getState()
    if (!http) return
    try {
      const res = await http.getSessionModels()
      if (res.ok && res.data) {
        const remote = (res.data as { overrides?: SessionModelOverrides }).overrides
        if (remote) get().applySync(remote)
      }
    } catch {
      // Offline — fica com o cache local
    }
  },

  selectModel: (sessionId, providerId, modelId) => {
    const selected: SelectedModel = { providerId, modelId }
    const key = sessionId ?? DRAFT_KEY
    const overrides = { ...get().overrides, [key]: selected }
    void Storage.setItem(STORAGE_KEY, JSON.stringify(overrides))
    set({ overrides })

    if (!sessionId) {
      // Chat novo: o modelo escolhido vira também o default global (mesmo
      // comportamento do desktop) — o desktop é avisado via HTTP.
      void useSettingsStore.getState().selectModel(providerId, modelId)
    } else {
      // Sessão existente: avisa o desktop para atualizar o override no
      // renderer (que repassa aos demais companions).
      const { wsClient } = useConnectionStore.getState()
      try {
        void wsClient.send({ type: 'models:select', providerId, modelId, sessionId } as any)
      } catch {
        // Offline: o envio explícito do modelo em cada mensagem mantém o
        // comportamento mesmo sem o desktop saber do override.
      }
    }
  },

  adopt: (sessionId, fallback) => {
    const overrides = { ...get().overrides }
    if (overrides[DRAFT_KEY] !== undefined) {
      overrides[sessionId] = overrides[DRAFT_KEY]
      delete overrides[DRAFT_KEY]
    } else if (fallback) {
      // Sem escolha explícita no draft, fixa o modelo efetivamente usado
      // (herdado do último chat) para a sessão continuar nele.
      overrides[sessionId] = fallback
    } else {
      return
    }
    void Storage.setItem(STORAGE_KEY, JSON.stringify(overrides))
    set({ overrides })
  },

  clear: (sessionId) => {
    const overrides = { ...get().overrides }
    delete overrides[sessionId]
    void Storage.setItem(STORAGE_KEY, JSON.stringify(overrides))
    set({ overrides })
  },
}))

/** Sessão mais recente não arquivada e não-worker — o modelo dela é o default
 *  do próximo chat novo. */
function latestSession(sessions: SessionInfo[]): SessionInfo | undefined {
  return sessions.filter((s) => !s.archived && !s.parentId).sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

/** Modelo efetivo da sessão: override por chat > default global. Chat novo
 *  (draft) sem escolha explícita herda o modelo do último chat usado antes de
 *  cair no default global. */
export function sessionModelFor(sessionId?: string | null): SelectedModel | null {
  const prefs = useSessionModelPrefs.getState()
  const override = prefs.overrides[sessionId ?? DRAFT_KEY]
  if (override) return override
  if (!sessionId) {
    const latest = latestSession(useSessionStore.getState().sessions)
    const latestOverride = latest ? prefs.overrides[latest.id] : undefined
    if (latestOverride) return latestOverride
  }
  return useSettingsStore.getState().selectedModel
}

/** Hook reativo do modelo efetivo da sessão (reage a override, a default e à
 *  sessão mais recente — para o chat novo acompanhar o último modelo usado). */
export function useSessionModel(sessionId?: string | null): SelectedModel | null {
  const overrides = useSessionModelPrefs((s) => s.overrides)
  const globalModel = useSettingsStore((s) => s.selectedModel)
  const sessions = useSessionStore((s) => s.sessions)
  const override = sessionId ? overrides[sessionId] : overrides[DRAFT_KEY]
  if (override) return override
  if (sessionId) return globalModel
  const latest = latestSession(sessions)
  return (latest && overrides[latest.id]) ?? globalModel
}
