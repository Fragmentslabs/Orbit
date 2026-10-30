import { create } from 'zustand'
import type {
  Catalog,
  CatalogModel,
  ReasoningConfig,
  WorkerConfigSnapshot,
  WorkerModelConfig,
} from '@orbit/shared'
import { Storage } from '~/lib/storage'
import { useConnectionStore } from './connection-store'

/** Stores or clears the key according to the value — the three fields of the
 *  workers/vision config are nullable ("use the main model"). */
async function persistOrRemove(key: string, value: unknown): Promise<void> {
  if (value) await Storage.setItem(key, JSON.stringify(value))
  else await Storage.removeItem(key)
}

/** Sends the whole config to the desktop, which is what really stores it and
 *  passes it on to the other devices. */
function pushWorkerConfig(state: {
  workerModel: WorkerModelConfig | null
  workerReasoning: ReasoningConfig | null
  visionModel: WorkerModelConfig | null
}): void {
  const { wsClient } = useConnectionStore.getState()
  void wsClient
    .send({
      type: 'worker-config:set',
      config: {
        workerModel: state.workerModel,
        workerReasoning: state.workerReasoning,
        visionModel: state.visionModel,
      },
    })
    .catch(() => {})
}

/** Becomes true as soon as the workers/vision config of the desktop arrives (fetch on
 *  connection or event). While it is false, the device cache fills in. */
let configDoDesktopAplicada = false

const CATALOG_CACHE_KEY = 'orbit_catalog_cache'
const PROVIDERS_CACHE_KEY = 'orbit_providers_cache'
const SELECTED_MODEL_CACHE_KEY = 'orbit_selected_model_cache'
const WORKER_MODEL_KEY = 'orbit_worker_model'
const WORKER_REASONING_KEY = 'orbit_worker_reasoning'
const VISION_MODEL_KEY = 'orbit_vision_model'
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
  /** Model active on the desktop. */
  selectedModel: SelectedModel | null
  /** Model catalog of the desktop. */
  catalog: Catalog | null
  /** Providers connected on the desktop. */
  connectedProviders: string[]
  /** Preferences of the desktop. */
  preferences: Record<string, unknown> | null
  /** Loading state. */
  loading: boolean

  /** Fetches the selected model via HTTP. */
  fetchSelectedModel: () => Promise<void>
  /** Selects a model via HTTP. */
  selectModel: (providerId: string, modelId: string) => Promise<void>
  /** Fetches the catalog via HTTP. */
  fetchCatalog: () => Promise<void>
  /** Fetches the connected providers via HTTP. */
  fetchConnectedProviders: () => Promise<void>
  /** Fetches the preferences via HTTP. */
  fetchPreferences: () => Promise<void>
  /** Fetches the workers/vision config of the desktop (source of truth). */
  fetchWorkerConfig: () => Promise<void>
  /** Updates the preferences via HTTP. */
  updatePreferences: (patch: Record<string, unknown>) => Promise<void>
  /** Loads the catalog from the cache (if any) — paints the UI instantly
   *   while the real fetchCatalog() runs underneath. */
  hydrateCatalogCache: () => Promise<void>

  /** Model of the workers (subagents/orchestration) — configured in the app. */
  workerModel: WorkerModelConfig | null
  /** Sets (or clears) the model of the workers. */
  setWorkerModel: (model: WorkerModelConfig | null) => Promise<void>

  /** Thinking configuration of the workers. */
  workerReasoning: ReasoningConfig | null
  /** Sets (or clears) the thinking of the workers. */
  setWorkerReasoning: (reasoning: ReasoningConfig | null) => Promise<void>

  /** Applies the workers/vision config coming from the desktop (without sending it back there). */
  applyWorkerConfigSync: (config: WorkerConfigSnapshot) => void

  /** Delegated vision model (Vision mode) — describes images on the desktop. */
  visionModel: WorkerModelConfig | null
  /** Sets (or clears) the vision model. */
  setVisionModel: (model: WorkerModelConfig | null) => Promise<void>
  /** Vision model configuration modal open. */
  visionConfigOpen: boolean
  /** Opens/closes the configuration modal of the Vision mode. */
  setVisionConfigOpen: (open: boolean) => void

  /** Configuration of the loop mode. */
  loopConfig: LoopConfig
  /** Sets the loop configuration. */
  setLoopConfig: (config: LoopConfig) => Promise<void>

  /** Automatic folders: groups code sessions by directory. */
  autoCreateFolders: boolean
  /** Sets the automatic folders toggle. */
  setAutoCreateFolders: (value: boolean) => Promise<void>

  /** Returns the model as a flat list (catalog). */
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
  visionModel: null,
  visionConfigOpen: false,
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
      // Catalog + connected providers + selected model: without the three the
      // cached picker opens empty (the filter requires a connected provider).
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
      // Worker/vision only come from the cache while the desktop has not answered: it is
      // the source of truth and may have cleared the config (see applyWorkerConfigSync).
      if (!configDoDesktopAplicada) {
        const rawWorker = await Storage.getItem(WORKER_MODEL_KEY)
        if (rawWorker && !get().workerModel) {
          set({ workerModel: JSON.parse(rawWorker) as WorkerModelConfig })
        }
        const rawReasoning = await Storage.getItem(WORKER_REASONING_KEY)
        if (rawReasoning && !get().workerReasoning) {
          set({ workerReasoning: JSON.parse(rawReasoning) as ReasoningConfig })
        }
        const rawVisionModel = await Storage.getItem(VISION_MODEL_KEY)
        if (rawVisionModel && !get().visionModel) {
          set({ visionModel: JSON.parse(rawVisionModel) as WorkerModelConfig })
        }
      }
      const rawAutoFolders = await Storage.getItem(AUTO_FOLDERS_KEY)
      if (rawAutoFolders) {
        set({ autoCreateFolders: JSON.parse(rawAutoFolders) as boolean })
      }
    } catch {
      // Corrupted or missing cache — ignore it, the real fetches resolve it
    }
  },

  setWorkerModel: async (model) => {
    set({ workerModel: model })
    if (model) {
      await Storage.setItem(WORKER_MODEL_KEY, JSON.stringify(model))
    } else {
      await Storage.removeItem(WORKER_MODEL_KEY)
    }
    pushWorkerConfig(get())
  },

  setWorkerReasoning: async (reasoning) => {
    set({ workerReasoning: reasoning })
    if (reasoning) {
      await Storage.setItem(WORKER_REASONING_KEY, JSON.stringify(reasoning))
    } else {
      await Storage.removeItem(WORKER_REASONING_KEY)
    }
    pushWorkerConfig(get())
  },

  setVisionModel: async (model) => {
    set({ visionModel: model })
    if (model) {
      await Storage.setItem(VISION_MODEL_KEY, JSON.stringify(model))
    } else {
      await Storage.removeItem(VISION_MODEL_KEY)
    }
    pushWorkerConfig(get())
  },

  applyWorkerConfigSync: (config) => {
    if (!config || typeof config !== 'object') return
    // From here on the desktop config is the truth: the local cache can no
    // longer resurrect a worker/vision that the desktop cleared, even if the
    // disk hydration finishes after the connection.
    configDoDesktopAplicada = true
    const { workerModel, workerReasoning, visionModel } = get()
    const next = {
      workerModel: config.workerModel ?? null,
      workerReasoning: config.workerReasoning ?? null,
      visionModel: config.visionModel ?? null,
    }
    if (
      JSON.stringify({ workerModel, workerReasoning, visionModel }) === JSON.stringify(next)
    ) {
      return
    }
    set(next)
    void persistOrRemove(WORKER_MODEL_KEY, next.workerModel)
    void persistOrRemove(WORKER_REASONING_KEY, next.workerReasoning)
    void persistOrRemove(VISION_MODEL_KEY, next.visionModel)
  },

  setVisionConfigOpen: (open) => {
    set({ visionConfigOpen: open })
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

  fetchWorkerConfig: async () => {
    const { http } = useConnectionStore.getState()
    if (!http) return
    try {
      const res = await http.getWorkerConfig()
      if (res.ok && res.data) {
        const config = (res.data as { config?: WorkerConfigSnapshot }).config
        if (config) get().applyWorkerConfigSync(config)
      }
    } catch {
      // Offline — goes on with what is stored on the device.
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
      // Updates locally (merge)
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
