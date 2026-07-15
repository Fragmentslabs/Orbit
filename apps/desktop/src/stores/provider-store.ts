import { create } from "zustand"
import type { Catalog, CatalogModel, CatalogProvider, ReasoningConfig } from "@shared/chat"
import { authApi, catalogApi, customProvidersApi } from "@/src/lib/ipc"

const SELECTED_MODEL_KEY = "orbit-selected-model"
const WORKER_MODEL_KEY = "orbit-worker-model"
const WORKER_REASONING_KEY = "orbit-worker-reasoning"

export interface SelectedModel {
  providerId: string
  modelId: string
}

function loadJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function loadSelectedModel(): SelectedModel | null {
  return loadJson<SelectedModel>(SELECTED_MODEL_KEY)
}

interface ProviderState {
  catalog: Catalog
  customProviders: CatalogProvider[]
  connectedProviders: string[]
  selectedModel: SelectedModel | null
  workerModel: SelectedModel | null
  workerReasoning: ReasoningConfig | null
  loading: boolean
  /** Mensagem de erro da última inicialização */
  error: string | null

  initialize: () => Promise<void>
  setApiKey: (providerId: string, key: string) => Promise<void>
  removeApiKey: (providerId: string) => Promise<void>
  selectModel: (providerId: string, modelId: string) => void
  setWorkerModel: (model: SelectedModel | null) => void
  setWorkerReasoning: (reasoning: ReasoningConfig | null) => void
  getModel: (providerId: string, modelId: string) => CatalogModel | undefined
  addCustomProvider: (id: string, name: string, baseURL: string, apiKey?: string) => Promise<void>
  updateCustomProvider: (id: string, patch: { name?: string; baseURL?: string; apiKey?: string }) => Promise<void>
  removeCustomProvider: (id: string) => Promise<void>
  refreshCustomProviders: () => Promise<void>
}

function mergeIntoCatalog(catalog: Catalog, custom: CatalogProvider[]): Catalog {
  const merged = { ...catalog }
  for (const provider of custom) {
    merged[provider.id] = provider
  }
  return merged
}

export const useProviderStore = create<ProviderState>((set, get) => ({
  catalog: {},
  customProviders: [],
  connectedProviders: [],
  selectedModel: loadSelectedModel(),
  workerModel: loadJson<SelectedModel>(WORKER_MODEL_KEY),
  workerReasoning: loadJson<ReasoningConfig>(WORKER_REASONING_KEY),
  loading: true,
  error: null,

  initialize: async () => {
    try {
      const [catalog, connectedProviders, customProviders] = await Promise.all([
        catalogApi.get(),
        authApi.list(),
        customProvidersApi.list(),
      ])
      const merged = mergeIntoCatalog(catalog, customProviders)
      set({ catalog: merged, customProviders, connectedProviders, loading: false, error: null })

      const { workerModel, workerReasoning } = get()
      if (workerModel) {
        const workerCatalogModel = merged[workerModel.providerId]?.models[workerModel.modelId]
        if (!workerCatalogModel || !connectedProviders.includes(workerModel.providerId)) {
          get().setWorkerModel(null)
          get().setWorkerReasoning(null)
        } else if (workerReasoning && !workerCatalogModel.reasoning) {
          get().setWorkerReasoning(null)
        }
      }

      const { selectedModel } = get()
      const isValid =
        selectedModel &&
        merged[selectedModel.providerId]?.models[selectedModel.modelId] !== undefined
      if (!isValid) {
        const providerId = connectedProviders.find((id) => merged[id])
        const modelId = providerId ? Object.keys(merged[providerId].models)[0] : undefined
        if (providerId && modelId) get().selectModel(providerId, modelId)
      }
    } catch (err) {
      console.error("[provider-store] initialize failed:", err)
      set({ loading: false, error: "Falha ao carregar provedores. Verifique sua conexão e tente novamente." })
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
    const { selectedModel } = get()
    if (selectedModel?.providerId === providerId) {
      localStorage.removeItem(SELECTED_MODEL_KEY)
      set({ selectedModel: null })
    }
  },

  selectModel: (providerId, modelId) => {
    const selected = { providerId, modelId }
    localStorage.setItem(SELECTED_MODEL_KEY, JSON.stringify(selected))
    set({ selectedModel: selected })
  },

  setWorkerModel: (model) => {
    if (model) localStorage.setItem(WORKER_MODEL_KEY, JSON.stringify(model))
    else localStorage.removeItem(WORKER_MODEL_KEY)
    set({ workerModel: model })
  },

  setWorkerReasoning: (reasoning) => {
    if (reasoning) localStorage.setItem(WORKER_REASONING_KEY, JSON.stringify(reasoning))
    else localStorage.removeItem(WORKER_REASONING_KEY)
    set({ workerReasoning: reasoning })
  },

  getModel: (providerId, modelId) => get().catalog[providerId]?.models[modelId],

  addCustomProvider: async (id, name, baseURL, apiKey) => {
    const provider = await customProvidersApi.add(id, name, baseURL, apiKey)
    set((state) => {
      const custom = [...state.customProviders, provider]
      return {
        customProviders: custom,
        catalog: { ...state.catalog, [provider.id]: provider },
        connectedProviders: apiKey
          ? state.connectedProviders.includes(provider.id)
            ? state.connectedProviders
            : [...state.connectedProviders, provider.id]
          : state.connectedProviders,
      }
    })
  },

  updateCustomProvider: async (id, patch) => {
    const provider = await customProvidersApi.update(id, patch)
    set((state) => ({
      customProviders: state.customProviders.map((p) => (p.id === provider.id ? provider : p)),
      catalog: { ...state.catalog, [provider.id]: provider },
    }))
  },

  removeCustomProvider: async (id) => {
    await customProvidersApi.remove(id)
    const providerId = `custom:${id}`
    set((state) => {
      const custom = state.customProviders.filter((p) => p.id !== providerId)
      const catalog = { ...state.catalog }
      delete catalog[providerId]
      return {
        customProviders: custom,
        catalog,
        connectedProviders: state.connectedProviders.filter((p) => p !== providerId),
      }
    })
    const { selectedModel } = get()
    if (selectedModel?.providerId === providerId) {
      localStorage.removeItem(SELECTED_MODEL_KEY)
      set({ selectedModel: null })
    }
  },

  refreshCustomProviders: async () => {
    const custom = await customProvidersApi.list()
    set((state) => ({
      customProviders: custom,
      catalog: mergeIntoCatalog(state.catalog, custom),
    }))
  },
}))
