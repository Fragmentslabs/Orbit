import { create } from 'zustand'
import type { Catalog, CatalogModel } from '@orbit/shared'
import { useConnectionStore } from './connection-store'

// ─── Types ──────────────────────────────────────────────────────────────────

interface SelectedModel {
  providerId: string
  modelId: string
  workerModelId?: string
}

interface SettingsState {
  /** Modelo ativo no desktop. */
  selectedModel: SelectedModel | null
  /** Catálogo de modelos do desktop. */
  catalog: Catalog | null
  /** Preferências do desktop. */
  preferences: Record<string, unknown> | null
  /** Loading state. */
  loading: boolean

  /** Busca modelo selecionado via HTTP. */
  fetchSelectedModel: () => Promise<void>
  /** Seleciona modelo via HTTP. */
  selectModel: (providerId: string, modelId: string) => Promise<void>
  /** Busca catálogo via HTTP. */
  fetchCatalog: () => Promise<void>
  /** Busca preferências via HTTP. */
  fetchPreferences: () => Promise<void>
  /** Atualiza preferências via HTTP. */
  updatePreferences: (patch: Record<string, unknown>) => Promise<void>

  /** Retorna modelo como lista plana (catálogo). */
  getModelList: () => CatalogModel[]
}

// ─── Store ──────────────────────────────────────────────────────────────────

export const useSettingsStore = create<SettingsState>((set, get) => ({
  selectedModel: null,
  catalog: null,
  preferences: null,
  loading: false,

  fetchSelectedModel: async () => {
    const { http } = useConnectionStore.getState()
    if (!http) return

    const res = await http.getSelectedModel()
    if (res.ok && res.data) {
      set({ selectedModel: res.data as SelectedModel })
    }
  },

  selectModel: async (providerId, modelId) => {
    const { http } = useConnectionStore.getState()
    if (!http) return

    const res = await http.selectModel(providerId, modelId)
    if (res.ok) {
      set({ selectedModel: { providerId, modelId } })
    }
  },

  fetchCatalog: async () => {
    const { http } = useConnectionStore.getState()
    if (!http) return

    set({ loading: true })
    try {
      const res = await http.getCatalog()
      if (res.ok && res.data) {
        set({ catalog: res.data as Catalog })
      }
    } finally {
      set({ loading: false })
    }
  },

  fetchPreferences: async () => {
    const { http } = useConnectionStore.getState()
    if (!http) return

    const res = await http.getPreferences()
    if (res.ok && res.data) {
      set({ preferences: res.data as Record<string, unknown> })
    }
  },

  updatePreferences: async (patch) => {
    const { http } = useConnectionStore.getState()
    if (!http) return

    const res = await http.updatePreferences(patch)
    if (res.ok) {
      // Atualiza localmente (merge)
      set((state) => ({
        preferences: { ...state.preferences, ...patch },
      }))
    }
  },

  getModelList: () => {
    const { catalog } = get()
    if (!catalog) return []

    const models: CatalogModel[] = []
    for (const provider of Object.values(catalog)) {
      for (const model of Object.values(provider.models)) {
        models.push(model)
      }
    }
    return models
  },
}))
