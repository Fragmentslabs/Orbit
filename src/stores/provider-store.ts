import { create } from "zustand"
import type { Catalog, CatalogModel, ReasoningConfig } from "@/shared/chat"
import { authApi, catalogApi } from "@/src/lib/ipc"

/**
 * Store de provedores/modelos: catálogo do models.dev + provedores
 * configurados (com chave de API) + modelo selecionado por modo.
 */

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
  /** IDs de provedores com chave configurada */
  connectedProviders: string[]
  selectedModel: SelectedModel | null
  /** Modelo dos workers (subagents/orchestra) */
  workerModel: SelectedModel | null
  workerReasoning: ReasoningConfig | null
  loading: boolean

  initialize: () => Promise<void>
  setApiKey: (providerId: string, key: string) => Promise<void>
  removeApiKey: (providerId: string) => Promise<void>
  selectModel: (providerId: string, modelId: string) => void
  setWorkerModel: (model: SelectedModel | null) => void
  setWorkerReasoning: (reasoning: ReasoningConfig | null) => void
  getModel: (providerId: string, modelId: string) => CatalogModel | undefined
}

export const useProviderStore = create<ProviderState>((set, get) => ({
  catalog: {},
  connectedProviders: [],
  selectedModel: loadSelectedModel(),
  workerModel: loadJson<SelectedModel>(WORKER_MODEL_KEY),
  workerReasoning: loadJson<ReasoningConfig>(WORKER_REASONING_KEY),
  loading: true,

  initialize: async () => {
    const [catalog, connectedProviders] = await Promise.all([catalogApi.get(), authApi.list()])
    set({ catalog, connectedProviders, loading: false })

    // Valida o modelo worker persistido: provider ainda conectado, modelo no
    // catálogo e reasoning suportado — senão limpa em vez de falhar no envio
    const { workerModel, workerReasoning } = get()
    if (workerModel) {
      const workerCatalogModel = catalog[workerModel.providerId]?.models[workerModel.modelId]
      if (!workerCatalogModel || !connectedProviders.includes(workerModel.providerId)) {
        get().setWorkerModel(null)
        get().setWorkerReasoning(null)
      } else if (workerReasoning && !workerCatalogModel.reasoning) {
        get().setWorkerReasoning(null)
      }
    }

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
}))
