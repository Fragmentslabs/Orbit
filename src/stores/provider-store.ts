import { create } from "zustand"
import type { Catalog, CatalogModel } from "@/shared/chat"
import { authApi, catalogApi } from "@/src/lib/ipc"

/**
 * Store de provedores/modelos: catálogo do models.dev + provedores
 * configurados (com chave de API) + modelo selecionado por modo.
 */

const SELECTED_MODEL_KEY = "orbit-selected-model"

export interface SelectedModel {
  providerId: string
  modelId: string
}

function loadSelectedModel(): SelectedModel | null {
  try {
    const raw = localStorage.getItem(SELECTED_MODEL_KEY)
    return raw ? (JSON.parse(raw) as SelectedModel) : null
  } catch {
    return null
  }
}

interface ProviderState {
  catalog: Catalog
  /** IDs de provedores com chave configurada */
  connectedProviders: string[]
  selectedModel: SelectedModel | null
  loading: boolean

  initialize: () => Promise<void>
  setApiKey: (providerId: string, key: string) => Promise<void>
  removeApiKey: (providerId: string) => Promise<void>
  selectModel: (providerId: string, modelId: string) => void
  getModel: (providerId: string, modelId: string) => CatalogModel | undefined
}

export const useProviderStore = create<ProviderState>((set, get) => ({
  catalog: {},
  connectedProviders: [],
  selectedModel: loadSelectedModel(),
  loading: true,

  initialize: async () => {
    const [catalog, connectedProviders] = await Promise.all([catalogApi.get(), authApi.list()])
    set({ catalog, connectedProviders, loading: false })

    // Garante uma seleção válida: mantém a atual se possível, senão escolhe
    // o primeiro modelo de um provedor conectado.
    const { selectedModel } = get()
    const isValid =
      selectedModel &&
      catalog[selectedModel.providerId]?.models[selectedModel.modelId] !== undefined
    if (!isValid) {
      const providerId = connectedProviders.find((id) => catalog[id])
      const modelId = providerId ? Object.keys(catalog[providerId].models)[0] : undefined
      if (providerId && modelId) get().selectModel(providerId, modelId)
    }
  },

  setApiKey: async (providerId, key) => {
    await authApi.set(providerId, key)
    set((state) => ({
      connectedProviders: state.connectedProviders.includes(providerId)
        ? state.connectedProviders
        : [...state.connectedProviders, providerId],
    }))
  },

  removeApiKey: async (providerId) => {
    await authApi.remove(providerId)
    set((state) => ({
      connectedProviders: state.connectedProviders.filter((id) => id !== providerId),
    }))
  },

  selectModel: (providerId, modelId) => {
    const selected = { providerId, modelId }
    localStorage.setItem(SELECTED_MODEL_KEY, JSON.stringify(selected))
    set({ selectedModel: selected })
  },

  getModel: (providerId, modelId) => get().catalog[providerId]?.models[modelId],
}))
