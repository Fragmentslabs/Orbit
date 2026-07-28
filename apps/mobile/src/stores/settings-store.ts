import { create } from 'zustand'
import type { Catalog, CatalogModel, ReasoningConfig, WorkerModelConfig } from '@orbit/shared'
import { Storage } from '~/lib/storage'
import { useConnectionStore } from './connection-store'

const CATALOG_CACHE_KEY = 'orbit_catalog_cache'
const PROVIDERS_CACHE_KEY = 'orbit_providers_cache'
const SELECTED_MODEL_CACHE_KEY = 'orbit_selected_model_cache'
const WORKER_MODEL_KEY = 'orbit_worker_model'
const WORKER_REASONING_KEY = 'orbit_worker_reasoning'
const LOOP_CONFIG_KEY = 'orbit_loop_config'
const AUTO_FOLDERS_KEY = 'orbit_auto_folders'

export interface LoopConfig {
  maxIterations: number
  autoReview: boolean
}

const DEFAULT_LOOP_CONFIG: LoopConfig = {
  maxIterations: 3,
  autoReview: true,
}

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
  /** Provedores conectados no desktop. */
  connectedProviders: string[]
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
  /** Busca provedores conectados via HTTP. */
  fetchConnectedProviders: () => Promise<void>
  /** Busca preferências via HTTP. */
  fetchPreferences: () => Promise<void>
  /** Atualiza preferências via HTTP. */
  updatePreferences: (patch: Record<string, unknown>) => Promise<void>
  /** Carrega o catálogo em cache (se houver) — pinta a UI instantaneamente
   *  enquanto o fetchCatalog() real roda por baixo. */
  hydrateCatalogCache: () => Promise<void>

  /** Modelo dos workers (subagentes/orquestração) — configurado no app. */
  workerModel: WorkerModelConfig | null
  /** Define (ou limpa) o modelo dos workers. */
  setWorkerModel: (model: WorkerModelConfig | null) => Promise<void>

  /** Configuração de thinking dos workers. */
  workerReasoning: ReasoningConfig | null
  /** Define (ou limpa) o thinking dos workers. */
  setWorkerReasoning: (reasoning: ReasoningConfig | null) => Promise<void>

  /** Configuração do modo loop. */
  loopConfig: LoopConfig
  /** Define a configuração do loop. */
  setLoopConfig: (config: LoopConfig) => Promise<void>

  /** Pastas automáticas: agrupa sessions de código por diretório. */
  autoCreateFolders: boolean
  /** Define o toggle de pastas automáticas. */
  setAutoCreateFolders: (value: boolean) => Promise<void>

  /** Retorna modelo como lista plana (catálogo). */
  getModelList: () => CatalogModel[]
}

// ─── Store ──────────────────────────────────────────────────────────────────

export const useSettingsStore = create<SettingsState>((set, get) => ({
  selectedModel: null,
  catalog: null,
  connectedProviders: [],
  preferences: null,
  loading: false,
  workerModel: null,
  workerReasoning: null,
  loopConfig: DEFAULT_LOOP_CONFIG,
  autoCreateFolders: false,

  fetchSelectedModel: async () => {
    const { http } = useConnectionStore.getState()
    if (!http) return

    const res = await http.getSelectedModel()
    if (res.ok && res.data) {
      set({ selectedModel: res.data as SelectedModel })
      void Storage.setItem(SELECTED_MODEL_CACHE_KEY, JSON.stringify(res.data))
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
        void Storage.setItem(CATALOG_CACHE_KEY, JSON.stringify(res.data))
      }
    } finally {
      set({ loading: false })
    }
  },

  hydrateCatalogCache: async () => {
    try {
      // Catálogo + provedores conectados + modelo selecionado: sem os três o
      // picker cacheado abre vazio (o filtro exige provider conectado).
      const [rawCatalog, rawProviders, rawSelected] = await Promise.all([
        Storage.getItem(CATALOG_CACHE_KEY),
        Storage.getItem(PROVIDERS_CACHE_KEY),
        Storage.getItem(SELECTED_MODEL_CACHE_KEY),
      ])
      if (rawCatalog && !get().catalog) {
        set({ catalog: JSON.parse(rawCatalog) as Catalog })
      }
      if (rawProviders && get().connectedProviders.length === 0) {
        set({ connectedProviders: JSON.parse(rawProviders) as string[] })
      }
      if (rawSelected && !get().selectedModel) {
        set({ selectedModel: JSON.parse(rawSelected) as SelectedModel })
      }
      const rawWorker = await Storage.getItem(WORKER_MODEL_KEY)
      if (rawWorker && !get().workerModel) {
        set({ workerModel: JSON.parse(rawWorker) as WorkerModelConfig })
      }
      const rawReasoning = await Storage.getItem(WORKER_REASONING_KEY)
      if (rawReasoning && !get().workerReasoning) {
        set({ workerReasoning: JSON.parse(rawReasoning) as ReasoningConfig })
      }
      const rawAutoFolders = await Storage.getItem(AUTO_FOLDERS_KEY)
      if (rawAutoFolders) {
        set({ autoCreateFolders: JSON.parse(rawAutoFolders) as boolean })
      }
    } catch {
      // Cache corrompido ou ausente — ignora, os fetches reais resolvem
    }
  },

  setWorkerModel: async (model) => {
    set({ workerModel: model })
    if (model) {
      await Storage.setItem(WORKER_MODEL_KEY, JSON.stringify(model))
    } else {
      await Storage.removeItem(WORKER_MODEL_KEY)
    }
  },

  setWorkerReasoning: async (reasoning) => {
    set({ workerReasoning: reasoning })
    if (reasoning) {
      await Storage.setItem(WORKER_REASONING_KEY, JSON.stringify(reasoning))
    } else {
      await Storage.removeItem(WORKER_REASONING_KEY)
    }
  },

  setLoopConfig: async (config) => {
    set({ loopConfig: config })
    await Storage.setItem(LOOP_CONFIG_KEY, JSON.stringify(config))
  },

  setAutoCreateFolders: async (value) => {
    set({ autoCreateFolders: value })
    if (value) {
      await Storage.setItem(AUTO_FOLDERS_KEY, JSON.stringify(value))
    } else {
      await Storage.removeItem(AUTO_FOLDERS_KEY)
    }
  },

  fetchConnectedProviders: async () => {
    const { http } = useConnectionStore.getState()
    if (!http) return

    try {
      const res = await http.getConnectedProviders()
      if (res.ok && res.data) {
        set({ connectedProviders: res.data as string[] })
        void Storage.setItem(PROVIDERS_CACHE_KEY, JSON.stringify(res.data))
      }
    } catch {
      // Silently fail
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

// Load persisted loop config
Storage.getItem(LOOP_CONFIG_KEY).then((raw) => {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as LoopConfig
      useSettingsStore.setState({ loopConfig: { ...DEFAULT_LOOP_CONFIG, ...parsed } })
    } catch { /* ignore */ }
  }
}).catch(() => {})
