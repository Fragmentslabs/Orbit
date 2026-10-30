import i18n from "@/src/i18n"
import { create } from "zustand"
import type { Catalog, CatalogModel, CatalogProvider, CustomProviderInput, CustomProviderPatch, OrchestrationSettings, ReasoningConfig } from "@shared/chat"
import { modelSupportsVision, normalizeOrchestrationSettings } from "@shared/chat"
import { authApi, catalogApi, customProvidersApi } from "@/src/lib/ipc"

const SELECTED_MODEL_KEY = "orbit-selected-model"
const WORKER_MODEL_KEY = "orbit-worker-model"
const WORKER_REASONING_KEY = "orbit-worker-reasoning"
const ORCHESTRATOR_MODEL_KEY = "orbit-orchestrator-model"
const ORCHESTRATOR_REASONING_KEY = "orbit-orchestrator-reasoning"
/** Orchestrator behavior (Orchestrate only / Supervise / Rigorous, adjustments, worktrees) */
const ORCHESTRATION_SETTINGS_KEY = "orbit-orchestration-settings"
/** The Preferences' "orchestra model" before it actually conducts the orchestra. */
const LEGACY_ORCHESTRA_MODEL_KEY = "orbit-orchestra-model"
const VISION_MODEL_KEY = "orbit-vision-model"

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

/**
 * Vision model saved RIGHT NOW, read straight from storage.
 *
 * The overlay is another window: its in-memory copy does not follow what the
 * main window writes into localStorage. Without this read, changing the vision
 * model in the Preferences would only apply on the next turn after restarting.
 */
export function readVisionModel(): SelectedModel | null {
  return loadJson<SelectedModel>(VISION_MODEL_KEY)
}

const storedVisionModel = loadJson<SelectedModel>(VISION_MODEL_KEY)

interface ProviderState {
  catalog: Catalog
  customProviders: CatalogProvider[]
  connectedProviders: string[]
  selectedModel: SelectedModel | null
  workerModel: SelectedModel | null
  workerReasoning: ReasoningConfig | null
  /** Model that conducts the orchestra (planning and synthesis). null = the chat's model. */
  orchestratorModel: SelectedModel | null
  orchestratorReasoning: ReasoningConfig | null
  orchestrationSettings: OrchestrationSettings
  /** Delegated vision model (Vision mode) — describes images/screenshots
   * for models without vision; null = no model configured.
   * ACTIVATION is per chat (mode-overrides): the model is global, the toggle is
   * persisted per session with the default in the preferences (model-mode-prefs) */
  visionModel: SelectedModel | null
  /** Vision mode settings dialog (opened by the toggle, by the gear or by the warning card) */
  visionConfigOpen: boolean
  loading: boolean
  /** Error message from the last initialization */
  error: string | null

  initialize: () => Promise<void>
  setApiKey: (providerId: string, key: string) => Promise<void>
  removeApiKey: (providerId: string) => Promise<void>
  selectModel: (providerId: string, modelId: string) => void
  setWorkerModel: (model: SelectedModel | null) => void
  setWorkerReasoning: (reasoning: ReasoningConfig | null) => void
  setOrchestratorModel: (model: SelectedModel | null) => void
  setOrchestratorReasoning: (reasoning: ReasoningConfig | null) => void
  setOrchestrationSettings: (settings: Partial<OrchestrationSettings>) => void
  setVisionModel: (model: SelectedModel | null) => void
  setVisionConfigOpen: (open: boolean) => void
  getModel: (providerId: string, modelId: string) => CatalogModel | undefined
  addCustomProvider: (input: CustomProviderInput) => Promise<void>
  updateCustomProvider: (id: string, patch: CustomProviderPatch) => Promise<void>
  removeCustomProvider: (id: string) => Promise<void>
  /** Asks main to query the provider's /models and write the result. */
  refreshProviderModels: (id: string) => Promise<void>
  refreshCustomProviders: () => Promise<void>
  /** Reloads the catalog from main (e.g.: after the background update) */
  reloadCatalog: () => Promise<void>
}

function mergeIntoCatalog(catalog: Catalog, custom: CatalogProvider[]): Catalog {
  const merged = { ...catalog }
  for (const provider of custom) {
    merged[provider.id] = provider
  }
  return merged
}

/**
 * A custom provider has no "connect": it exists because the user
 * created it. What enables it in the selector is having a model — the selector drops a group
 * without models. Before, only whoever had a saved key got into the list, so Ollama
 * and LM Studio (keyless by nature) never showed up, even after being
 * detected. The empty seeds stay out and do not get in the way of the first
 * run (useNoProviderConnected).
 */
function connectedWithCustom(credentialProviders: string[], custom: CatalogProvider[]): string[] {
  const withModels = custom.filter((p) => Object.keys(p.models).length > 0).map((p) => p.id)
  return [...new Set([...credentialProviders, ...withModels])]
}

export const useProviderStore = create<ProviderState>((set, get) => ({
  catalog: {},
  customProviders: [],
  connectedProviders: [],
  selectedModel: loadSelectedModel(),
  workerModel: loadJson<SelectedModel>(WORKER_MODEL_KEY),
  workerReasoning: loadJson<ReasoningConfig>(WORKER_REASONING_KEY),
  orchestratorModel: loadJson<SelectedModel>(ORCHESTRATOR_MODEL_KEY) ?? loadJson<SelectedModel>(LEGACY_ORCHESTRA_MODEL_KEY),
  orchestratorReasoning: loadJson<ReasoningConfig>(ORCHESTRATOR_REASONING_KEY),
  orchestrationSettings: normalizeOrchestrationSettings(loadJson(ORCHESTRATION_SETTINGS_KEY)),
  visionModel: storedVisionModel,
  visionConfigOpen: false,
  loading: true,
  error: null,

  initialize: async () => {
    try {
      const [catalog, credentialProviders, customProviders] = await Promise.all([
        catalogApi.get(),
        authApi.list(),
        customProvidersApi.list(),
      ])
      const merged = mergeIntoCatalog(catalog, customProviders)
      const connectedProviders = connectedWithCustom(credentialProviders, customProviders)
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

      // Same validation for the orchestra conductor: without the model, back to the chat's.
      const { orchestratorModel, orchestratorReasoning } = get()
      if (orchestratorModel) {
        const conductor = merged[orchestratorModel.providerId]?.models[orchestratorModel.modelId]
        if (!conductor || !connectedProviders.includes(orchestratorModel.providerId)) {
          get().setOrchestratorModel(null)
          get().setOrchestratorReasoning(null)
        } else if (orchestratorReasoning && !conductor.reasoning) {
          get().setOrchestratorReasoning(null)
        }
      }

      // Vision mode: the configured model has to exist, be connected and have
      // vision — otherwise the mode turns itself off (avoids broken delegation).
      const { visionModel } = get()
      if (visionModel) {
        const visionProvider = merged[visionModel.providerId]
        const visionCatalogModel = visionProvider?.models[visionModel.modelId]
        const valid =
          visionCatalogModel &&
          connectedProviders.includes(visionModel.providerId) &&
          modelSupportsVision(visionProvider, visionModel.modelId)
        if (!valid) {
          get().setVisionModel(null)
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
      set({ loading: false, error: i18n.t("providers.loadError") })
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
      // A custom one connected by model stays connected without a key
      // (local server); only the catalog ones drop from the list.
      connectedProviders: connectedWithCustom(
        state.connectedProviders.filter((id) => id !== providerId),
        state.customProviders,
      ),
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

  setOrchestratorModel: (model) => {
    if (model) localStorage.setItem(ORCHESTRATOR_MODEL_KEY, JSON.stringify(model))
    else localStorage.removeItem(ORCHESTRATOR_MODEL_KEY)
    // The old key only served as the source of the migration.
    localStorage.removeItem(LEGACY_ORCHESTRA_MODEL_KEY)
    set({ orchestratorModel: model })
  },

  setOrchestratorReasoning: (reasoning) => {
    if (reasoning) localStorage.setItem(ORCHESTRATOR_REASONING_KEY, JSON.stringify(reasoning))
    else localStorage.removeItem(ORCHESTRATOR_REASONING_KEY)
    set({ orchestratorReasoning: reasoning })
  },

  setOrchestrationSettings: (patch) => {
    const next = normalizeOrchestrationSettings({ ...get().orchestrationSettings, ...patch })
    localStorage.setItem(ORCHESTRATION_SETTINGS_KEY, JSON.stringify(next))
    set({ orchestrationSettings: next })
  },

  setVisionModel: (model) => {
    if (model) localStorage.setItem(VISION_MODEL_KEY, JSON.stringify(model))
    else localStorage.removeItem(VISION_MODEL_KEY)
    set({ visionModel: model })
  },

  setVisionConfigOpen: (open) => set({ visionConfigOpen: open }),

  getModel: (providerId, modelId) => get().catalog[providerId]?.models[modelId],

  addCustomProvider: async (input) => {
    const provider = await customProvidersApi.add(input)
    set((state) => {
      const custom = [...state.customProviders, provider]
      return {
        customProviders: custom,
        catalog: { ...state.catalog, [provider.id]: provider },
        connectedProviders: connectedWithCustom(state.connectedProviders, custom),
      }
    })
  },

  updateCustomProvider: async (id, patch) => {
    const provider = await customProvidersApi.update(id, patch)
    set((state) => {
      const custom = state.customProviders.map((p) => (p.id === provider.id ? provider : p))
      return {
        customProviders: custom,
        catalog: { ...state.catalog, [provider.id]: provider },
        connectedProviders: connectedWithCustom(state.connectedProviders, custom),
      }
    })
  },

  refreshProviderModels: async (id) => {
    const provider = await customProvidersApi.refreshModels(id)
    set((state) => {
      const custom = state.customProviders.map((p) => (p.id === provider.id ? provider : p))
      return {
        customProviders: custom,
        catalog: { ...state.catalog, [provider.id]: provider },
        connectedProviders: connectedWithCustom(state.connectedProviders, custom),
      }
    })
    // The chosen model may have left the server — it falls back to the first one
    // left instead of leaving the chat pointing to a nonexistent model.
    const { selectedModel } = get()
    if (selectedModel?.providerId === provider.id && !provider.models[selectedModel.modelId]) {
      const modelId = Object.keys(provider.models)[0]
      if (modelId) get().selectModel(provider.id, modelId)
      else {
        localStorage.removeItem(SELECTED_MODEL_KEY)
        set({ selectedModel: null })
      }
    }
  },

  removeCustomProvider: async (id) => {
    await customProvidersApi.remove(id)
    const providerId = id.startsWith("custom:") ? id : `custom:${id}`
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

  reloadCatalog: async () => {
    try {
      const catalog = await catalogApi.get()
      set((state) => ({ catalog: mergeIntoCatalog(catalog, state.customProviders) }))
    } catch (err) {
      console.error("[provider-store] reloadCatalog failed:", err)
    }
  },

  refreshCustomProviders: async () => {
    const custom = await customProvidersApi.list()
    set((state) => ({
      customProviders: custom,
      catalog: mergeIntoCatalog(state.catalog, custom),
      connectedProviders: connectedWithCustom(state.connectedProviders, custom),
    }))
  },
}))

/**
 * Pre-configuration: no provider connected (first run) and the initialization
 * state is already known (no loading/failure). While loading/error,
 * it returns false so the UI does not wrongly report a missing provider.
 * Used by the model selector (attention highlight) and by the send block (card).
 */
/** Short "model · provider" label for compact rows (e.g.: rotation
 *  slots). Returns null when the model is not in the catalog. */
export function useCatalogModelLabel(model: { providerId: string; modelId: string } | null): string | null {
  const catalog = useProviderStore((s) => s.catalog)
  if (!model) return null
  const provider = catalog[model.providerId]
  const catalogModel = provider?.models[model.modelId]
  if (!catalogModel) return null
  return `${catalogModel.name} · ${provider?.name ?? model.providerId}`
}

export function useNoProviderConnected(): boolean {
  const loading = useProviderStore((s) => s.loading)
  const error = useProviderStore((s) => s.error)
  const connectedProviders = useProviderStore((s) => s.connectedProviders)
  return !loading && !error && connectedProviders.length === 0
}

/**
 * Are the providers still loading? While they are, it is not known
 * whether one is missing — the UI that decides between "first entry" and "normal use"
 * has to wait for this so it does not flicker.
 */
export function useProvidersLoading(): boolean {
  return useProviderStore((s) => s.loading)
}
