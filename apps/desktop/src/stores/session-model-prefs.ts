import { create } from "zustand"

import type { SessionInfo } from "@shared/chat"
import type { SelectedModel } from "@/src/stores/provider-store"
import { useProviderStore } from "@/src/stores/provider-store"
import { useSessionStore } from "@/src/stores/session-store"
import { sessionModelsApi } from "@/src/lib/ipc"

/**
 * Modelo selecionado POR CHAT (padrão do opencode: o modelo segue a sessão,
 * não o app inteiro). `overrides` guarda o modelo escolhido de cada sessão;
 * chats novos usam a chave DRAFT até o primeiro envio (adopt), quando o
 * override vira da sessão. Sem override, vale o default global do provider.
 * `recents` é global (últimos 5 modelos escolhidos em qualquer chat).
 */

const STORAGE_KEY = "orbit-session-models"
const RECENTS_KEY = "orbit-recent-models"
const DRAFT_KEY = "draft"
const MAX_RECENTS = 5

function loadRecord(): Record<string, SelectedModel> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as Record<string, SelectedModel>
  } catch {
    // prefs corrompidas — recomeça sem overrides
  }
  return {}
}

function persistRecord(overrides: Record<string, SelectedModel>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides))
}

function loadRecents(): SelectedModel[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as SelectedModel[]
      if (Array.isArray(parsed)) return parsed.slice(0, MAX_RECENTS)
    }
  } catch {
    // recents corrompidos — recomeça vazio
  }
  return []
}

function persistRecents(recents: SelectedModel[]) {
  localStorage.setItem(RECENTS_KEY, JSON.stringify(recents))
}

interface SessionModelPrefsState {
  overrides: Record<string, SelectedModel>
  /** Últimos modelos usados (global, mais recente primeiro, máx. 5) */
  recents: SelectedModel[]
  selectModel: (sessionId: string | null | undefined, providerId: string, modelId: string) => void
  /** Move o override do draft (chat novo) para a sessão criada no 1º envio */
  adopt: (sessionId: string, fallback?: SelectedModel) => void
  /** Registra um modelo como "usado" (entra nos recentes). Chamado apenas
   *  quando o agente concluiu uma resposta de fato — nunca em falha. */
  markUsed: (providerId?: string, modelId?: string) => void
  /** Remove um modelo dos recentes (botão "x" no seletor). */
  removeRecent: (providerId: string, modelId: string) => void
  clear: (sessionId: string) => void
}

export const useSessionModelPrefs = create<SessionModelPrefsState>((set, get) => ({
  overrides: loadRecord(),
  recents: loadRecents(),

selectModel: (sessionId, providerId, modelId) => {
    const selected: SelectedModel = { providerId, modelId }
    const key = sessionId ?? DRAFT_KEY
    const overrides = { ...get().overrides, [key]: selected }
    persistRecord(overrides)

    // NOTA: escolher não mexe em `recents` — um modelo só entra nos recentes
    // quando é realmente usado (markUsed, no fim de uma resposta do agente).
    set({ overrides })

    // Empurra o mapa para o main (cache HTTP + repasse aos companions)
    sessionModelsApi.sync(overrides)

    // Chat novo (draft): o modelo escolhido vira também o default global,
    // para o próximo chat novo já abrir nele.
    if (!sessionId) useProviderStore.getState().selectModel(providerId, modelId)
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
    persistRecord(overrides)
    set({ overrides })
    sessionModelsApi.sync(overrides)
  },

  markUsed: (providerId, modelId) => {
    if (!providerId || !modelId) return
    if (get().recents.some((r) => r.providerId === providerId && r.modelId === modelId)) return
    const recents = [{ providerId, modelId }, ...get().recents].slice(0, MAX_RECENTS)
    persistRecents(recents)
    set({ recents })
  },

  removeRecent: (providerId, modelId) => {
    const recents = get().recents.filter((r) => !(r.providerId === providerId && r.modelId === modelId))
    persistRecents(recents)
    set({ recents })
  },

  clear: (sessionId) => {
    const overrides = { ...get().overrides }
    delete overrides[sessionId]
    persistRecord(overrides)
    set({ overrides })
    sessionModelsApi.sync(overrides)
  },
}))

// Sincronização com companions (mobile): empurra o estado inicial para o main
// (após reload do renderer o cache do main precisa ser repopulado) e aplica
// seleções feitas pelos companions via WS 'models:select' / HTTP PUT selected.
if (typeof window !== "undefined" && window.ipcRenderer) {
  sessionModelsApi.sync(loadRecord())
  sessionModelsApi.onSelect(({ providerId, modelId, sessionId }) => {
    if (providerId && modelId) {
      useSessionModelPrefs.getState().selectModel(sessionId ?? null, providerId, modelId)
    }
  })
}

/** Sessão mais recente não arquivada e não-worker — o modelo dela é o default
 *  do próximo chat novo. */
function latestSession(sessions: SessionInfo[]): SessionInfo | undefined {
  return sessions.filter((s) => !s.archived && !s.parentId).sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

/** Modelo efetivo da sessão: override por chat > default global do provider.
 *  Chat novo (draft) sem escolha explícita herda o modelo do último chat usado
 *  (override da sessão mais recente) antes de cair no default global. */
export function sessionModelFor(sessionId?: string | null): SelectedModel | null {
  const prefs = useSessionModelPrefs.getState()
  const override = prefs.overrides[sessionId ?? DRAFT_KEY]
  if (override) return override
  if (!sessionId) {
    const latest = latestSession(useSessionStore.getState().sessions)
    const latestOverride = latest ? prefs.overrides[latest.id] : undefined
    if (latestOverride) return latestOverride
  }
  return useProviderStore.getState().selectedModel
}

/** Hook reativo do modelo efetivo da sessão (reage a override, a default e à
 *  sessão mais recente — para o chat novo acompanhar o último modelo usado). */
export function useSessionModel(sessionId?: string | null): SelectedModel | null {
  const overrides = useSessionModelPrefs((s) => s.overrides)
  const globalModel = useProviderStore((s) => s.selectedModel)
  const sessions = useSessionStore((s) => s.sessions)
  const override = sessionId ? overrides[sessionId] : overrides[DRAFT_KEY]
  if (override) return override
  if (sessionId) return globalModel
  const latest = latestSession(sessions)
  return (latest && overrides[latest.id]) ?? globalModel
}
