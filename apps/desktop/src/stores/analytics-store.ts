import { create } from "zustand"
import { analyticsApi } from "@/src/lib/ipc"
import type { AnalyticsSummary, AnalyticsRange } from "@shared/analytics"

interface AnalyticsState {
  data: AnalyticsSummary | null
  range: AnalyticsRange
  loading: boolean
  setRange: (range: AnalyticsRange) => void
  load: () => Promise<void>
}

export const useAnalyticsStore = create<AnalyticsState>((set, get) => ({
  data: null,
  range: "total",
  loading: false,

  setRange: (range) => {
    set({ range })
    void get().load()
  },

  load: async () => {
    set({ loading: true })
    try {
      const data = await analyticsApi.summary(get().range)
      set({ data, loading: false })
    } catch (err) {
      console.error("[analytics] falha ao carregar:", err)
      set({ loading: false })
    }
  },
}))
