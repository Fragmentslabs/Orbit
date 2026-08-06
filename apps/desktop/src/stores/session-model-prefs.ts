import { create } from "zustand"

import type { SelectedModel } from "@/src/stores/provider-store"
import { useProviderStore } from "@/src/stores/provider-store"

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
  adopt: (sessionId: string) => void
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

    const recents = [
      selected,
      ...get().recents.filter((r) => !(r.providerId === providerId && r.modelId === modelId)),
    ].slice(0, MAX_RECENTS)
    persistRecents(recents)

    set({ overrides, recents })

    // Chat novo (draft): o modelo escolhido vira também o default global,
    // para o próximo chat novo já abrir nele.
    if (!sessionId) useProviderStore.getState().selectModel(providerId, modelId)
  },

  adopt: (sessionId) => {
    const overrides = { ...get().overrides }
    if (overrides[DRAFT_KEY] === undefined) return
    overrides[sessionId] = overrides[DRAFT_KEY]
    delete overrides[DRAFT_KEY]
    persistRecord(overrides)
    set({ overrides })
  },

  clear: (sessionId) => {
    const overrides = { ...get().overrides }
    delete overrides[sessionId]
    persistRecord(overrides)
    set({ overrides })
  },
}))

/** Modelo efetivo da sessão: override por chat > default global do provider. */
export function sessionModelFor(sessionId?: string | null): SelectedModel | null {
  const override = useSessionModelPrefs.getState().overrides[sessionId ?? DRAFT_KEY]
  if (override) return override
  return useProviderStore.getState().selectedModel
}

/** Hook reativo do modelo efetivo da sessão (reage a override e a default). */
export function useSessionModel(sessionId?: string | null): SelectedModel | null {
  const override = useSessionModelPrefs((s) => s.overrides[sessionId ?? DRAFT_KEY] ?? null)
  const globalModel = useProviderStore((s) => s.selectedModel)
  return override ?? globalModel
}
