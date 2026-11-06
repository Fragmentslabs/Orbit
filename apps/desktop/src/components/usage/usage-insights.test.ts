import { describe, expect, it } from "vitest"
import type { AnalyticsDay, AnalyticsSummary } from "@shared/analytics"
import { buildInsights } from "./usage-insights"

const names = { project: (id: string) => id, weekday: (d: number) => `wd${d}`, cost: (v: number) => `$${v.toFixed(2)}` }

function day(date: string, hours: number): AnalyticsDay {
  return {
    date,
    totalTokens: 0,
    totalHours: hours,
    orbitHours: hours,
    userHours: 0,
    sessions: 1,
    totalMessages: 1,
    totalCost: 0,
    byModel: [],
    byProject: [],
  }
}

function summary(over: Partial<AnalyticsSummary>): AnalyticsSummary {
  return {
    days: [],
    byModel: [],
    byProject: [],
    totalSessions: 0,
    totalMessages: 0,
    totalTokens: 0,
    totalHours: 0,
    totalCost: 0,
    orbitHours: 0,
    userHours: 0,
    activeDays: 0,
    currentStreak: 0,
    longestStreak: 0,
    peakHour: 0,
    ...over,
  }
}

const model = (modelId: string, tokens: number, hours: number, cost: number) => ({
  providerId: "p",
  modelId,
  tokens,
  hours,
  messages: 1,
  cost,
})

describe("buildInsights", () => {
  it("says nothing for an empty period", () => {
    expect(buildInsights(summary({}), names, "en")).toEqual([])
  })

  it("does not name a 'most used' model when there is only one", () => {
    const out = buildInsights(summary({ totalTokens: 100, byModel: [model("a", 100, 1, 1)] }), names, "en")
    expect(out.find((i) => i.key === "topModel")).toBeUndefined()
  })

  it("names the most used model with its share of the tokens, and the one that spends more than it processes", () => {
    const out = buildInsights(
      summary({ totalTokens: 100, totalCost: 10, byModel: [model("a", 75, 3, 2), model("b", 25, 1, 8)] }),
      names,
      "en",
    )
    expect(out.find((i) => i.key === "topModel")?.params).toEqual({ model: "a", pct: 75 })
    // b spends 80% of the money with 25% of the tokens
    expect(out.find((i) => i.key === "costlyModel")?.params).toEqual({ model: "b", cost: 80, tokens: 25 })
  })

  it("picks the cheapest model per hour among the ones that cost", () => {
    const out = buildInsights(
      summary({ totalTokens: 100, totalCost: 10, byModel: [model("a", 50, 2, 8), model("b", 40, 4, 2), model("free", 10, 1, 0)] }),
      names,
      "en",
    )
    expect(out.find((i) => i.key === "cheapestModel")?.params.model).toBe("b")
  })

  it("finds the busiest weekday by average, needing at least a week of days", () => {
    // 2026-03-02 is a Monday; two Mondays and five other days
    const days = [
      day("2026-03-02", 1),
      day("2026-03-03", 1),
      day("2026-03-04", 1),
      day("2026-03-05", 1),
      day("2026-03-06", 1),
      day("2026-03-07", 1),
      day("2026-03-09", 5),
    ]
    const out = buildInsights(summary({ days, totalHours: 11, activeDays: 7 }), names, "en")
    expect(out.find((i) => i.key === "busiestWeekday")?.params.day).toBe("wd1")
    expect(buildInsights(summary({ days: days.slice(0, 3) }), names, "en").find((i) => i.key === "busiestWeekday")).toBeUndefined()
  })

  it("uses the streak sentence only when there is a streak", () => {
    const days = [day("2026-03-02", 1), day("2026-03-04", 1)]
    expect(buildInsights(summary({ days, activeDays: 2, currentStreak: 0 }), names, "en").map((i) => i.key)).toContain("activeDays")
    expect(buildInsights(summary({ days, activeDays: 2, currentStreak: 3 }), names, "en").map((i) => i.key)).toContain("activeDaysStreak")
  })
})
