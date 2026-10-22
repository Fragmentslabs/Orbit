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
/** Comportamento do orquestrador (Só orquestrar / Acompanhar / Rigoroso, ajustes, worktrees) */
const ORCHESTRATION_SETTINGS_KEY = "orbit-orchestration-settings"
/** "Modelo de orquestra" das Preferências antes de ele conduzir a orquestra de fato. */
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

const storedVisionModel = loadJson<SelectedModel>(VISION_MODEL_KEY)

interface ProviderState {
  catalog: Catalog
  customProviders: CatalogProvider[]
  connectedProviders: string[]
  selectedModel: SelectedModel | null
  workerModel: SelectedModel | null
  workerReasoning: ReasoningConfig | null
  /** Modelo que conduz a orquestra (planejamento e síntese). null = o modelo do chat. */
  orchestratorModel: SelectedModel | null
  orchestratorReasoning: ReasoningConfig | null
  orchestrationSettings: OrchestrationSettings
  /** Modelo de visão delegado (modo Visão) — descreve imagens/screenshots
   * para modelos sem visão; null = sem modelo configurado.
   * A ATIVAÇÃO é por chat (mode-overrides): o modelo é global, o toggle é
   * persistido por sessão com default nas preferências (model-mode-prefs) */
  visionModel: SelectedModel | null
  /** Dialog de configuração do modo Visão (aberto pelo toggle, pelo gear ou pelo card de aviso) */
  visionConfigOpen: boolean
  loading: boolean
  /** Mensagem de erro da última inicialização */
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
  /** Pede ao main para consultar o /models do provedor e gravar o resultado. */
  refreshProviderModels: (id: string) => Promise<void>
  refreshCustomProviders: () => Promise<void>
  /** Recarrega o catálogo do main (ex: depois da atualização em segundo plano) */
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
 * Provedor personalizado não tem "conectar": ele existe porque o usuário o
 * criou. O que o habilita no seletor é ter modelo — o seletor descarta grupo
 * sem modelos. Antes só quem tinha chave salva entrava na lista, então Ollama
 * e LM Studio (sem chave por natureza) nunca apareciam, mesmo depois de
 * detectados. Os seeds vazios ficam de fora e não atrapalham a primeira
 * execução (useNoProviderConnected).
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

      // Mesma validação para o condutor da orquestra: sem o modelo, volta ao do chat.
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

      // Modo Visão: modelo configurado precisa existir, estar conectado e ter
      // visão — senão o modo desliga sozinho (evita delegação quebrada).
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
      // Personalizado conectado por modelo continua conectado sem chave
      // (servidor local); só os do catálogo caem da lista.
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
    // A chave antiga só servia de origem da migração.
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
    // O modelo escolhido pode ter saído do servidor — cai para o primeiro que
    // restou em vez de deixar o chat apontando para um modelo inexistente.
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
 * Pré-configuração: nenhum provedor conectado (primeira execução) e o estado
 * de inicialização já é conhecido (sem loading/falha). Enquanto loading/erro,
 * retorna false para a UI não acusar falta de provedor indevidamente.
 * Usado pelo seletor de modelo (destaque de atenção) e pelo bloqueio de envio (card).
 */
/** Rótulo curto "modelo · provedor" para linhas compactas (ex.: slots de
 *  rotação). Retorna null quando o modelo não está no catálogo. */
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
 * Os provedores ainda estão sendo carregados? Enquanto estão, não se sabe
 * se falta algum — a UI que decide entre "primeira entrada" e "uso normal"
 * precisa esperar por isso para não piscar.
 */
export function useProvidersLoading(): boolean {
  return useProviderStore((s) => s.loading)
}
