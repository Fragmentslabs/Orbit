import type { AnalyticsSummary } from "@shared/analytics"
import { formatHours, hoursByWeekday, percent, spanOfDays } from "./usage-utils"

export interface Insight {
  /** i18n key under `usage.insights.` */
  key: string
  params: Record<string, string | number>
}

export interface InsightNames {
  /** Display name of a project (its folder, or "no project"). */
  project: (projectId: string) => string
  /** Weekday name for 0 = Sunday. */
  weekday: (day: number) => string
  cost: (value: number) => string
}

/**
 * The sentences of the "Highlights" card, computed from the period. A sentence only exists
 * when the number behind it says something (a model "most used" among one is not news), so
 * a small period returns few and an empty one returns none.
 */
export function buildInsights(data: AnalyticsSummary, names: InsightNames, locale: string): Insight[] {
  const out: Insight[] = []
  const totalTokens = data.totalTokens
  const totalCost = data.totalCost

  const topModel = data.byModel[0]
  if (topModel && data.byModel.length > 1 && totalTokens > 0) {
    out.push({
      key: "topModel",
      params: { model: topModel.modelId, pct: percent(topModel.tokens, totalTokens) },
    })
  }

  // The model that spends much more than it processes.
  const costly = data.byModel
    .filter(() => totalCost > 0 && totalTokens > 0)
    .map((m) => ({ m, costShare: percent(m.cost, totalCost), tokenShare: percent(m.tokens, totalTokens) }))
    .filter((x) => x.costShare >= 20 && x.costShare >= x.tokenShare * 2)
    .sort((a, b) => b.costShare - a.costShare)[0]
  if (costly) {
    out.push({ key: "costlyModel", params: { model: costly.m.modelId, cost: costly.costShare, tokens: costly.tokenShare } })
  }

  if (data.days.length >= 7) {
    // Average per occurrence of that weekday inside the period.
    const weekdays = hoursByWeekday(data.days)
    const counts = new Array<number>(7).fill(0)
    for (const d of data.days) counts[new Date(`${d.date}T12:00:00`).getDay()]++
    const averages = weekdays.map((h, i) => (counts[i] > 0 ? h / counts[i] : 0))
    const best = averages.indexOf(Math.max(...averages))
    if (averages[best] > 0) {
      out.push({ key: "busiestWeekday", params: { day: names.weekday(best), hours: formatHours(averages[best], locale) } })
    }
  }

  const paying = data.byModel.filter((m) => m.cost > 0 && m.hours > 0)
  const cheapest = paying.map((m) => ({ m, perHour: m.cost / m.hours })).sort((a, b) => a.perHour - b.perHour)[0]
  if (cheapest && paying.length > 1) {
    out.push({ key: "cheapestModel", params: { model: cheapest.m.modelId, cost: names.cost(cheapest.perHour) } })
  }

  const topProject = data.byProject[0]
  if (topProject && data.byProject.length > 1 && data.totalHours > 0) {
    out.push({
      key: "topProject",
      params: { project: names.project(topProject.projectId), pct: percent(topProject.hours, data.totalHours) },
    })
  }

  const span = spanOfDays(data.days)
  if (span > 1 && data.activeDays > 0) {
    out.push({
      key: data.currentStreak > 0 ? "activeDaysStreak" : "activeDays",
      params: { active: data.activeDays, total: span, streak: data.currentStreak },
    })
  }

  return out.slice(0, 6)
}
