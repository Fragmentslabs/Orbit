import { create } from "zustand"

import type { ModelsSnapshot, OrbitModel, PriceTier, SpeedTier } from "@/shared/models"
import { modelsApi } from "@/src/lib/ipc"

/** Estado da aba Models: snapshot do catálogo unificado, busca, filtros e seleção. */

export type ContextFilter = "any" | "32k" | "128k" | "1m"

export interface ModelFilters {
  providers: string[]
  capabilities: string[]
  prices: PriceTier[]
  speeds: SpeedTier[]
  context: ContextFilter
  availability: string[]
}

const EMPTY_FILTERS: ModelFilters = {
  providers: [],
  capabilities: [],
  prices: [],
  speeds: [],
  context: "any",
  availability: [],
}

const CONTEXT_MIN: Record<ContextFilter, number> = {
  any: 0,
  "32k": 32_000,
  "128k": 128_000,
  "1m": 1_000_000,
}

interface ModelsState {
  snapshot: ModelsSnapshot | null
  loading: boolean
  search: string
  filters: ModelFilters
  /** IDs marcados para comparação */
  selected: string[]
  compareOpen: boolean
  /** Modelo aberto no painel de detalhe */
  detailId: string | null

  initialize: () => Promise<void>
  refresh: () => Promise<void>
  setSearch: (search: string) => void
  toggleFilter: (key: Exclude<keyof ModelFilters, "context">, value: string) => void
  setContext: (context: ContextFilter) => void
  clearFilters: () => void
  toggleSelected: (id: string) => void
  clearSelected: () => void
  setCompareOpen: (open: boolean) => void
  setDetailId: (id: string | null) => void
}

export const useModelsStore = create<ModelsState>((set, get) => ({
  snapshot: null,
  loading: false,
  search: "",
  filters: EMPTY_FILTERS,
  selected: [],
  compareOpen: false,
  detailId: null,

  initialize: async () => {
    if (get().snapshot || get().loading) return
    set({ loading: true })
    try {
      set({ snapshot: await modelsApi.list() })
    } finally {
      set({ loading: false })
    }
  },

  refresh: async () => {
    set({ loading: true })
    try {
      set({ snapshot: await modelsApi.refresh() })
    } finally {
      set({ loading: false })
    }
  },

  setSearch: (search) => set({ search }),

  toggleFilter: (key, value) =>
    set((state) => {
      const current = state.filters[key] as string[]
      const next = current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value]
      return { filters: { ...state.filters, [key]: next } }
    }),

  setContext: (context) => set((state) => ({ filters: { ...state.filters, context } })),

  clearFilters: () => set({ filters: EMPTY_FILTERS, search: "" }),

  toggleSelected: (id) =>
    set((state) => ({
      selected: state.selected.includes(id)
        ? state.selected.filter((s) => s !== id)
        : [...state.selected, id],
    })),

  clearSelected: () => set({ selected: [], compareOpen: false }),

  setCompareOpen: (compareOpen) => set({ compareOpen }),

  setDetailId: (detailId) => set({ detailId }),
}))

export function hasActiveFilters(filters: ModelFilters): boolean {
  return (
    filters.providers.length > 0 ||
    filters.capabilities.length > 0 ||
    filters.prices.length > 0 ||
    filters.speeds.length > 0 ||
    filters.availability.length > 0 ||
    filters.context !== "any"
  )
}

/** Aplica busca (nome/provider/tags) + filtros — usada com useMemo nos componentes. */
export function filterModels(models: OrbitModel[], search: string, filters: ModelFilters): OrbitModel[] {
  const query = search.trim().toLowerCase()
  return models.filter((model) => {
    if (query) {
      const haystack = `${model.name} ${model.provider} ${model.providerName} ${model.tags.join(" ")}`.toLowerCase()
      if (!haystack.includes(query)) return false
    }
    if (filters.providers.length && !filters.providers.includes(model.provider)) return false
    if (filters.capabilities.length && !filters.capabilities.every((c) => model.tags.includes(c))) return false
    if (filters.prices.length && !filters.prices.includes(model.priceTier)) return false
    if (filters.speeds.length && !filters.speeds.includes(model.speedTier)) return false
    if (model.contextWindow < CONTEXT_MIN[filters.context]) return false
    if (filters.availability.length && !filters.availability.some((a) => model.availability.includes(a))) return false
    return true
  })
}
