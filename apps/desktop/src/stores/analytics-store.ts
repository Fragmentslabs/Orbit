import { create } from "zustand"
import { analyticsApi } from "@/src/lib/ipc"
import type { AnalyticsSummary, AnalyticsRange } from "@shared/analytics"
import type { ViewScope } from "@/src/stores/view-scope-store"

interface AnalyticsState {
  data: AnalyticsSummary | null
  range: AnalyticsRange
  /** Chat conversations, code conversations or both. */
  scope: ViewScope
  loading: boolean
  setRange: (range: AnalyticsRange) => void
  setScope: (scope: ViewScope) => void
  load: () => Promise<void>
}

export const useAnalyticsStore = create<AnalyticsState>((set, get) => ({
  data: null,
  range: "total",
  scope: "all",
  loading: false,

  setScope: (scope) => {
    set({ scope })
    void get().load()
  },

  setRange: (range) => {
    set({ range })
    void get().load()
  },

  load: async () => {
    set({ loading: true })
    try {
      const { range, scope } = get()
      const data = await analyticsApi.summary(range, scope === "all" ? undefined : scope)
      set({ data, loading: false })
    } catch (err) {
      console.error("[analytics] failed to load:", err)
      set({ loading: false })
    }
  },
}))
