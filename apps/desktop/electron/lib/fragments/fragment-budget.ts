/**
 * A per-fragment call budget: at most N calls per minute and M at the same time, so a loop
 * in the page cannot drain the person's quota (model calls) or hammer a host/server.
 * One instance per kind of call; state is per fragment id and lives in memory.
 */
export interface FragmentBudget {
  /** A release function when the call may go ahead, or the reason it may not. */
  take(fragmentId: string): { release: () => void } | { refused: string }
}

export function createBudget(options: { label: string; perMinute: number; concurrent: number }): FragmentBudget {
  const windows = new Map<string, number[]>()
  const inFlight = new Map<string, number>()
  return {
    take(fragmentId) {
      if ((inFlight.get(fragmentId) ?? 0) >= options.concurrent) {
        return { refused: `at most ${options.concurrent} ${options.label} calls at the same time` }
      }
      const now = Date.now()
      const recent = (windows.get(fragmentId) ?? []).filter((t) => now - t < 60_000)
      windows.set(fragmentId, recent)
      if (recent.length >= options.perMinute) return { refused: `at most ${options.perMinute} ${options.label} calls per minute` }
      recent.push(now)
      inFlight.set(fragmentId, (inFlight.get(fragmentId) ?? 0) + 1)
      let released = false
      return {
        release() {
          if (released) return
          released = true
          const left = (inFlight.get(fragmentId) ?? 1) - 1
          if (left <= 0) inFlight.delete(fragmentId)
          else inFlight.set(fragmentId, left)
        },
      }
    },
  }
}
