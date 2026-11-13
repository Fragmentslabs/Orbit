import { create } from "zustand"
import type { AnalyticsSummary } from "@shared/analytics"
import type { ChatStatus } from "@shared/chat"
import { analyticsApi } from "@/src/lib/ipc"
import { useSessionStore } from "@/src/stores/session-store"

/**
 * One usage summary for every native widget that needs it.
 *
 * `computeAnalytics` walks the whole history once to answer — asking it four times (one per
 * widget) would read the same files four times. The store keeps the last answer and re-reads
 * when a turn ends, which is the only moment the numbers can change.
 */
const FRESH_MS = 45_000
/** A turn that just ended: one re-read after the stream settles, not on every token. */
const AFTER_TURN_MS = 2_500

interface UsageWidgetsState {
  summary: AnalyticsSummary | null
  loading: boolean
  loadedAt: number
  error: string | null
  load: (force?: boolean) => Promise<void>
}

export const useUsageWidgetsStore = create<UsageWidgetsState>((set, get) => ({
  summary: null,
  loading: false,
  loadedAt: 0,
  error: null,
  load: async (force = false) => {
    const { loading, loadedAt, summary } = get()
    if (loading) return
    if (!force && summary && Date.now() - loadedAt < FRESH_MS) return
    set({ loading: true, error: null })
    try {
      const data = await analyticsApi.summary("total")
      set({ summary: data, loadedAt: Date.now(), loading: false })
    } catch (err) {
      console.error("[native-widgets] could not read the usage summary:", err)
      set({ loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },
}))

/** A session is busy while any chat of it is past "idle". */
function anyBusy(status: Record<string, ChatStatus>): boolean {
  return Object.values(status).some((value) => value !== "idle" && value !== "error")
}

let watching = false
let refreshTimer: number | undefined

/** Starts watching the end of turns once — the first widget that mounts wakes it up. */
export function startUsageWidgetsWatch(): void {
  if (watching || typeof window === "undefined") return
  watching = true
  useSessionStore.subscribe((state, previous) => {
    if (!anyBusy(previous.status) || anyBusy(state.status)) return
    window.clearTimeout(refreshTimer)
    refreshTimer = window.setTimeout(() => void useUsageWidgetsStore.getState().load(true), AFTER_TURN_MS)
  })
}
