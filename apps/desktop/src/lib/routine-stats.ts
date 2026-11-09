import type { RoutineRun } from "@shared/routines"

/** How far back the success rate looks. */
export const SUCCESS_WINDOW_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

export interface RoutineStats {
  /** Share of finished executions that succeeded in the window (0–1); null with none finished. */
  successRate: number | null
  /** Average cost over the executions that cost something; null with none. */
  averageCost: number | null
  /** The newest execution, finished or not. */
  last: RoutineRun | null
}

/** Numbers of the detail screen, derived from the runs of ONE routine. */
export function routineStats(runs: readonly RoutineRun[], now: number): RoutineStats {
  const since = now - SUCCESS_WINDOW_DAYS * DAY_MS
  const finished = runs.filter((r) => r.status !== "running" && r.startedAt >= since)
  const paid = runs.filter((r) => r.cost > 0)
  let last: RoutineRun | null = null
  for (const r of runs) if (!last || r.startedAt > last.startedAt) last = r
  return {
    successRate: finished.length > 0 ? finished.filter((r) => r.status === "ok").length / finished.length : null,
    averageCost: paid.length > 0 ? paid.reduce((sum, r) => sum + r.cost, 0) / paid.length : null,
    last,
  }
}
