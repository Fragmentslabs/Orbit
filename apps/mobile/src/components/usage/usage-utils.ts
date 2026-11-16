import type { AnalyticsDay, AnalyticsSummary, ProjectBreakdown } from '@orbit/shared'
import { formatCost, formatTokens } from '~/lib/format'

/** What the charts and the rankings are read by — one choice rules the whole overview. */
export type Metric = 'hours' | 'tokens' | 'cost'
export type UsageSection = 'overview' | 'models' | 'projects' | 'sessions' | 'rhythm'

/** Same colors as the desktop's usage page, readable in both themes. */
export const SERIES_COLORS = ['#6ea8fe', '#a78bfa', '#fbbf24', '#34d399', '#f472b6', '#fb923c']
export const OTHERS_COLOR = '#71717a'

export const modelKeyOf = (m: { providerId: string; modelId: string }) => `${m.providerId}::${m.modelId}`

/** Same model → same color on every card of the screen. */
export function colorsByModel(byModel: AnalyticsSummary['byModel']): Map<string, string> {
  const map = new Map<string, string>()
  byModel.forEach((m, i) => map.set(modelKeyOf(m), SERIES_COLORS[i % SERIES_COLORS.length]))
  return map
}

/** "48min", "1h 12min", "14h". */
export function formatHours(hours: number): string {
  const minutes = Math.round(hours * 60)
  if (minutes < 60) return `${Math.max(minutes, 0)}min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h}h` : `${h}h ${m}min`
}

export function formatMetric(value: number, metric: Metric): string {
  if (metric === 'hours') return formatHours(value)
  if (metric === 'tokens') return formatTokens(Math.round(value))
  return formatCost(value)
}

export function pickMetric(x: { hours?: number; tokens?: number; cost?: number }, metric: Metric): number {
  return (metric === 'hours' ? x.hours : metric === 'tokens' ? x.tokens : x.cost) ?? 0
}

/** Percent change; null when there is nothing to compare with (a division by zero says nothing). */
export function deltaPercent(current: number, previous: number | undefined): number | null {
  if (previous === undefined || previous <= 0) return null
  return Math.round(((current - previous) / previous) * 100)
}

export function percent(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0
}

export function projectLabel(p: Pick<ProjectBreakdown, 'name' | 'directory'>, noProject: string): string {
  return p.directory ? p.name : noProject
}

/** YYYY-MM-DD → Date at local midnight (new Date("YYYY-MM-DD") would be UTC and shift the day). */
export function parseDay(date: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export interface SeriesPoint {
  date: string
  hours: number
  tokens: number
  cost: number
  orbitHours: number
  userHours: number
  value: number
}

/**
 * The days of the period as a CONTINUOUS series (a day without work is a gap, not a skip) —
 * by week when it gets long, so a "total" does not turn into a thousand slivers.
 */
export function buildSeries(days: AnalyticsDay[], metric: Metric): SeriesPoint[] {
  if (days.length === 0) return []
  const byDate = new Map(days.map((d) => [d.date, d]))
  const first = parseDay(days[0].date)
  const last = parseDay(days[days.length - 1].date)
  const span = Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1
  const weekly = span > 120
  const bucketOf = (d: Date) => {
    if (!weekly) return dateKey(d)
    const monday = new Date(d)
    monday.setDate(d.getDate() - ((d.getDay() + 6) % 7))
    return dateKey(monday)
  }
  const points: SeriesPoint[] = []
  const buckets = new Map<string, SeriesPoint>()
  for (let i = 0; i < span; i++) {
    const d = new Date(first)
    d.setDate(first.getDate() + i)
    const key = bucketOf(d)
    let point = buckets.get(key)
    if (!point) {
      point = { date: key, hours: 0, tokens: 0, cost: 0, orbitHours: 0, userHours: 0, value: 0 }
      buckets.set(key, point)
      points.push(point)
    }
    const day = byDate.get(dateKey(d))
    if (day) {
      point.hours += day.totalHours
      point.tokens += day.totalTokens
      point.cost += day.totalCost
      point.orbitHours += day.orbitHours
      point.userHours += day.userHours
    }
  }
  for (const p of points) p.value = pickMetric(p, metric)
  return points
}

/** `count` evenly spaced points of a series — enough to see the shape of the sparkline. */
export function sample(values: number[], count = 12): number[] {
  if (values.length <= count) return values
  const step = values.length / count
  return Array.from({ length: count }, (_, i) =>
    values.slice(Math.floor(i * step), Math.floor((i + 1) * step)).reduce((sum, v) => sum + v, 0),
  )
}

export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const

/** Hours worked per weekday (0 = Sunday) over the period's days. */
export function hoursByWeekday(days: AnalyticsDay[]): number[] {
  const sums = new Array<number>(7).fill(0)
  for (const d of days) sums[parseDay(d.date).getDay()] += d.totalHours
  return sums
}

/** How many calendar days the period covers (first to last day with work, inclusive). */
export function spanOfDays(days: AnalyticsDay[]): number {
  if (days.length === 0) return 0
  const first = parseDay(days[0].date).getTime()
  const last = parseDay(days[days.length - 1].date).getTime()
  return Math.round((last - first) / 86_400_000) + 1
}

/** "sáb., 8 de nov." — a day of the history. */
export function formatDayLabel(date: string, locale: string): string {
  return parseDay(date).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' })
}

export function formatClock(ts: number, locale: string): string {
  return new Date(ts).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
}
