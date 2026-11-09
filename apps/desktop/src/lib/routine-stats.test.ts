import { describe, expect, it } from "vitest"
import type { RoutineRun } from "@shared/routines"
import { routineStats } from "./routine-stats"

const DAY = 24 * 60 * 60 * 1000
const NOW = 100 * DAY

function run(over: Partial<RoutineRun>): RoutineRun {
  return { routineId: "r", sessionId: "s", startedAt: NOW, status: "ok", tokens: 0, cost: 0, ...over }
}

describe("routineStats", () => {
  it("has nothing to say without runs", () => {
    expect(routineStats([], NOW)).toEqual({ successRate: null, averageCost: null, last: null })
  })

  it("rates only finished runs inside the window", () => {
    const stats = routineStats(
      [
        run({ sessionId: "a", status: "ok" }),
        run({ sessionId: "b", status: "error" }),
        run({ sessionId: "c", status: "running" }),
        run({ sessionId: "d", status: "error", startedAt: NOW - 40 * DAY }),
      ],
      NOW,
    )
    expect(stats.successRate).toBe(0.5)
  })

  it("averages only the runs that cost something and finds the newest", () => {
    const stats = routineStats(
      [run({ sessionId: "a", cost: 0.2, startedAt: NOW - DAY }), run({ sessionId: "b", cost: 0.4 }), run({ sessionId: "c" })],
      NOW,
    )
    expect(stats.averageCost).toBeCloseTo(0.3)
    expect(stats.last?.startedAt).toBe(NOW)
  })
})
