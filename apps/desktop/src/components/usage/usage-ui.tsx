import { useLayoutEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import type { AnalyticsDay } from "@shared/analytics"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import {
  type Metric,
  type SeriesPoint,
  dateKey,
  deltaPercent,
  formatDayLabel,
  formatHours,
  formatMetric,
  parseDay,
} from "./usage-utils"
import { formatCost, formatTokens } from "@/src/lib/format"

export function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("rounded-xl border bg-card p-3.5", className)}>{children}</div>
}

export function CardHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold">{title}</p>
        {subtitle && <p className="text-[11px] text-muted-foreground">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}

/** Change against the previous period. `lowerIsBetter`: for the cost, a drop is the good news. */
export function Delta({ current, previous, lowerIsBetter }: { current: number; previous?: number; lowerIsBetter?: boolean }) {
  const { t } = useTranslation()
  const delta = deltaPercent(current, previous)
  if (delta === null) return <span className="text-muted-foreground">{t("usage.noComparison")}</span>
  const good = lowerIsBetter ? delta <= 0 : delta >= 0
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : ""
  return (
    <span className="flex items-center gap-1">
      <span className={cn("font-medium", good ? "text-emerald-500" : "text-red-500")}>
        {sign}
        {Math.abs(delta)}%
      </span>
      <span className="text-muted-foreground">{t("usage.vsPrevious")}</span>
    </span>
  )
}

export function Sparkline({ values, color }: { values: number[]; color: string }) {
  const max = Math.max(...values, Number.EPSILON)
  return (
    <div className="flex h-7 items-end gap-0.5" aria-hidden>
      {values.map((v, i) => (
        <span
          key={i}
          className="w-[5px] rounded-sm"
          style={{ height: `${Math.max(8, Math.round((v / max) * 100))}%`, backgroundColor: color, opacity: v === 0 ? 0.25 : 1 }}
        />
      ))}
    </div>
  )
}

export function StatCard({ label, value, footer, spark, color }: {
  label: string
  value: string
  footer: React.ReactNode
  spark?: number[]
  color: string
}) {
  return (
    <Card className="flex items-end justify-between gap-2 px-3.5 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[11px] text-muted-foreground">{label}</span>
        <span className="text-lg font-semibold tabular-nums">{value}</span>
        <span className="text-[11px]">{footer}</span>
      </div>
      {spark && spark.length > 1 && <Sparkline values={spark} color={color} />}
    </Card>
  )
}

/** A row of a ranking: name, share of the total as a bar, value. */
export function ShareRow({ name, sub, value, pct, color, onClick }: {
  name: string
  sub?: string
  value: string
  pct: number
  color: string
  onClick?: () => void
}) {
  const body = (
    <>
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate font-medium">{name}</span>
            {sub && <span className="shrink-0 text-[11px] text-muted-foreground">{sub}</span>}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{pct}%</span>
        </span>
        <span className="h-1.5 overflow-hidden rounded-full bg-muted">
          <span className="block h-full rounded-full" style={{ width: `${Math.max(pct, 2)}%`, backgroundColor: color }} />
        </span>
      </span>
      <span className="w-16 shrink-0 text-right font-semibold tabular-nums">{value}</span>
    </>
  )
  const cls = "flex items-center gap-3 border-b py-2 text-xs last:border-b-0"
  return onClick ? (
    <button type="button" onClick={onClick} className={cn(cls, "w-full text-left transition-colors hover:bg-muted/40")}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  )
}

/** The small number card of every section: label, value, a line of context. */
export function KpiCard({ label, value, meta }: { label: string; value: string; meta?: string }) {
  return (
    <Card className="flex flex-col gap-0.5 px-3.5 py-3">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
      {meta && <span className="text-[11px] text-muted-foreground">{meta}</span>}
    </Card>
  )
}

export function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">{children}</p>
}

/** Bars of one value per day (or per week, when the period is long). */
export function DayBars({ points, metric, height = 110, color }: {
  points: SeriesPoint[]
  metric: Metric
  height?: number
  color?: string
}) {
  const { i18n } = useTranslation()
  const max = Math.max(...points.map((p) => p.value), Number.EPSILON)
  const peak = points.reduce((best, p) => (p.value > best.value ? p : best), points[0])
  return (
    <div>
      <div className="flex items-end gap-[3px] border-b" style={{ height }}>
        {points.map((p) => (
          <div
            key={p.date}
            title={`${p.label} — ${formatMetric(p.value, metric, i18n.language)}`}
            className={cn("min-w-0 flex-1 rounded-t-sm", !color && (p === peak && p.value > 0 ? "bg-primary" : "bg-primary/55"))}
            style={{
              height: `${Math.max(2, Math.round((p.value / max) * 100))}%`,
              ...(color ? { backgroundColor: color, opacity: p === peak ? 1 : 0.7 } : {}),
              ...(p.value === 0 ? { backgroundColor: "var(--muted)", opacity: 1 } : {}),
            }}
          />
        ))}
      </div>
      {points.length > 1 && (
        <div className="mt-1.5 flex justify-between text-[11px] text-muted-foreground">
          <span>{points[0].label}</span>
          <span>{points[points.length - 1].label}</span>
        </div>
      )}
    </div>
  )
}

/** Cell size and gaps of the grid, in px — the width that decides how many weeks fit. */
const CELL = 10
const CELL_GAP = 2
const MAX_WEEKS = 53
const WEEKDAY_COLUMN = 26
const COLUMN_GAP = 6

const LEVELS = ["bg-muted", "bg-primary/20", "bg-primary/40", "bg-primary/65", "bg-primary"]

/**
 * Activity of the last year, one square per day, like the contribution graph: weeks in
 * columns (Sunday on top), months along the top. The square's intensity is relative to the
 * most intense day of the metric chosen; clicking a day opens its detail below.
 */
export function ActivityCard({ year, projects, metric }: {
  year: AnalyticsDay[]
  /** Names of the projects that appear in the year (the day opens as badges). */
  projects?: Array<{ projectId: string; name: string; directory?: string }>
  metric: Metric
}) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language
  const [selected, setSelected] = useState<string | null>(null)
  // As many weeks as fit in the card, the most recent on the right: the card never scrolls,
  // it shows less history when it is narrow.
  const [weeks, setWeeks] = useState(26)
  const fitRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = fitRef.current
    if (!el) return
    const measure = () => {
      const available = el.clientWidth - WEEKDAY_COLUMN - COLUMN_GAP
      setWeeks(Math.max(4, Math.min(MAX_WEEKS, Math.floor((available + CELL_GAP) / (CELL + CELL_GAP)))))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const grid = useMemo(() => {
    const byDate = new Map(year.map((d) => [d.date, d]))
    const end = new Date()
    end.setHours(0, 0, 0, 0)
    const start = new Date(end)
    start.setDate(end.getDate() - end.getDay() - (weeks - 1) * 7)
    const cells: { date: string; day?: AnalyticsDay; value: number; inFuture: boolean }[] = []
    const pick = (d?: AnalyticsDay) =>
      !d ? 0 : metric === "hours" ? d.totalHours : metric === "tokens" ? d.totalTokens : d.totalCost
    for (let i = 0; i < weeks * 7; i++) {
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      const key = dateKey(d)
      const day = byDate.get(key)
      cells.push({ date: key, day, value: pick(day), inFuture: d > end })
    }
    const max = Math.max(...cells.map((c) => c.value), Number.EPSILON)
    const months: string[] = []
    for (let w = 0; w < weeks; w++) {
      const cur = parseDay(cells[w * 7].date)
      const prev = w > 0 ? parseDay(cells[(w - 1) * 7].date) : null
      months.push(!prev || prev.getMonth() !== cur.getMonth() ? cur.toLocaleDateString(locale, { month: "short" }) : "")
    }
    const total = cells.reduce((s, c) => s + c.value, 0)
    const active = cells.filter((c) => c.value > 0).length
    return { cells, max, months, total, active, today: dateKey(end) }
  }, [year, metric, locale, weeks])

  const weekdayLabels = useMemo(
    () =>
      [0, 1, 2, 3, 4, 5, 6].map((i) =>
        i % 2 === 1 ? new Date(2026, 0, 4 + i).toLocaleDateString(locale, { weekday: "short" }) : "",
      ),
    [locale],
  )

  const shownKey = selected ?? grid.today
  const shown = grid.cells.find((c) => c.date === shownKey)
  const day = shown?.day
  const projectLabel = (id: string) => {
    const p = projects?.find((x) => x.projectId === id)
    return p && p.directory ? p.name : t("analytics.noProject")
  }
  const topProjects = day ? [...day.byProject].sort((a, b) => b.hours - a.hours) : []
  const topModels = day ? [...day.byModel].filter((m) => m.messages > 0 || m.hours > 0).sort((a, b) => b.hours - a.hours) : []

  return (
    <Card className="flex min-w-0 flex-col gap-2.5">
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-[13px] font-semibold">
            {t("usage.activity.title", { total: formatMetric(grid.total, metric, locale) })}
          </p>
          <p className="shrink-0 text-[11px] text-muted-foreground">
            {t("usage.activity.subtitle", { count: grid.active, weeks })}
          </p>
        </div>
        <p className="text-[11px] capitalize text-muted-foreground">
          {parseDay(shownKey).toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
        </p>
      </div>
      <div ref={fitRef} className="flex gap-1.5 overflow-hidden pb-0.5">
        <div className="flex shrink-0 flex-col gap-0.5 pt-4" style={{ width: WEEKDAY_COLUMN }}>
          {weekdayLabels.map((label, i) => (
            <span key={i} className="h-2.5 text-[9px] leading-[10px] text-muted-foreground">
              {label}
            </span>
          ))}
        </div>
        <div className="flex shrink-0 flex-col gap-0.5">
          <div className="grid h-3.5 auto-cols-[10px] grid-flow-col gap-0.5">
            {grid.months.map((label, i) => (
              <span key={i} className="whitespace-nowrap text-[9px] text-muted-foreground">
                {label}
              </span>
            ))}
          </div>
          <div className="grid auto-cols-[10px] grid-flow-col grid-rows-[repeat(7,10px)] gap-0.5">
            {grid.cells.map((c) => {
              const level = c.value === 0 ? 0 : Math.min(4, Math.ceil((c.value / grid.max) * 4))
              if (c.inFuture) return <span key={c.date} className="size-2.5" />
              return (
                <button
                  key={c.date}
                  type="button"
                  title={`${formatDayLabel(c.date, locale)} — ${c.value === 0 ? t("usage.activity.none") : formatMetric(c.value, metric, locale)}`}
                  aria-label={formatDayLabel(c.date, locale)}
                  onClick={() => setSelected(c.date)}
                  className={cn("size-2.5 rounded-[2px] p-0", LEVELS[level], c.date === shownKey && "ring-2 ring-foreground")}
                />
              )
            })}
          </div>
        </div>
      </div>

      <div className="flex items-end gap-3 border-t pt-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {day ? (
            <>
              <div className="flex flex-wrap gap-1">
                <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                  {t("usage.activity.sessions", { count: day.sessions })}
                </Badge>
                <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                  {t("usage.legend.orbit")} {formatHours(day.orbitHours, locale)}
                </Badge>
                <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                  {t("usage.activity.you")} {formatHours(day.userHours, locale)}
                </Badge>
                <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                  {formatTokens(day.totalTokens)} {t("analytics.tokens").toLowerCase()}
                </Badge>
                <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                  {formatCost(day.totalCost)}
                </Badge>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <BadgeGroup label={t("usage.activity.projects")} items={topProjects.map((p) => projectLabel(p.projectId))} />
                <BadgeGroup label={t("usage.activity.models")} items={topModels.map((m) => m.modelId)} />
              </div>
            </>
          ) : (
            <span className="text-[11px] text-muted-foreground">{t("usage.activity.noActivity")}</span>
          )}
        </div>
        <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
          {t("usage.activity.less")}
          {LEVELS.map((cls) => (
            <span key={cls} className={cn("size-2.5 rounded-[2px]", cls)} />
          ))}
          {t("usage.activity.more")}
        </span>
      </div>
    </Card>
  )
}

/** A label followed by small badges; what does not fit the first few folds into "+N". */
function BadgeGroup({ label, items, max = 3 }: { label: string; items: string[]; max?: number }) {
  if (items.length === 0) return null
  const shown = items.slice(0, max)
  return (
    <span className="flex flex-wrap items-center gap-1">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      {shown.map((item) => (
        <Badge key={item} variant="outline" className="max-w-40 px-1.5 py-0 text-[10px]">
          <span className="truncate">{item}</span>
        </Badge>
      ))}
      {items.length > shown.length && <span className="text-[10px] text-muted-foreground">+{items.length - shown.length}</span>}
    </span>
  )
}
