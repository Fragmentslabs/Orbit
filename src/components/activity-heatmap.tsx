import { useMemo, useState } from "react"
import { cn } from "@/lib/utils"
import type { AnalyticsDay } from "@/shared/analytics"
import { ModelSelectorLogo } from "@/src/components/ai/model-selector"
import { formatTokens } from "@/src/lib/format"

interface HeatmapProps {
  days: AnalyticsDay[]
  className?: string
}

function getMaxActivity(days: AnalyticsDay[]): number {
  return Math.max(
    1,
    ...days.map((d) => d.totalTokens + d.totalMessages * 100),
  )
}

function opacityFor(day: AnalyticsDay, max: number): number {
  if (!day || day.totalMessages === 0) return 0
  const score = day.totalTokens + day.totalMessages * 100
  const raw = score / max
  return 0.08 + raw * 0.87
}

const DAY_LABELS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"]

export function ActivityHeatmap({ days, className }: HeatmapProps) {
  const [tooltip, setTooltip] = useState<{
    day: AnalyticsDay
    x: number
    y: number
  } | null>(null)

  const dayMap = useMemo(() => {
    const m = new Map<string, AnalyticsDay>()
    for (const d of days) m.set(d.date, d)
    return m
  }, [days])

  const maxActivity = useMemo(() => getMaxActivity(days), [days])

  // Generate weeks grid: last 365 days
  const weeks = useMemo(() => {
    const grid: { date: string; day: AnalyticsDay | null; dayOfWeek: number }[][] = []
    const start = new Date()
    start.setDate(start.getDate() - 364)
    start.setHours(0, 0, 0, 0)

    // Start from the most recent Sunday (or today)
    const end = new Date()
    const current = new Date(start)

    // Go back to first day of the week (Sunday)
    const dayOfWeek = current.getDay()
    current.setDate(current.getDate() - dayOfWeek)

    while (current <= end) {
      const week: { date: string; day: AnalyticsDay | null; dayOfWeek: number }[] = []
      for (let d = 0; d < 7; d++) {
        const dateStr = formatDate(current)
        const day = dayMap.get(dateStr) ?? null
        week.push({ date: dateStr, day, dayOfWeek: d })
        current.setDate(current.getDate() + 1)
      }
      grid.push(week)
    }
    return grid
  }, [dayMap])

  return (
    <div className={cn("relative", className)}>
      <div className="flex gap-1">
        {/* Day labels */}
        <div className="flex flex-col gap-[3px] pt-5">
          {DAY_LABELS.map((label, i) => (
            <span key={label} className="flex h-3 items-center text-[9px] text-muted-foreground/70">
              {i % 2 === 0 ? label : ""}
            </span>
          ))}
        </div>

        {/* Weeks grid */}
        <div className="flex gap-[3px] overflow-x-auto">
          {weeks.map((week, wi) => (
            <div key={wi} className="flex flex-col gap-[3px]">
              {week.map((cell) => (
                <div
                  key={cell.date}
                  className="relative h-3 w-3 rounded-[3px]"
                  style={{
                    backgroundColor: cell.day
                      ? `hsl(var(--primary) / ${opacityFor(cell.day, maxActivity)})`
                      : "hsl(var(--muted))",
                  }}
                  onMouseEnter={(e) => {
                    if (cell.day) {
                      const rect = e.currentTarget.getBoundingClientRect()
                      setTooltip({ day: cell.day, x: rect.left, y: rect.top })
                    }
                  }}
                  onMouseLeave={() => setTooltip(null)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="pointer-events-none fixed z-50 rounded-lg border bg-popover px-3 py-2 text-xs shadow-md"
          style={{ left: tooltip.x - 120, top: tooltip.y - 140 }}
        >
          <p className="mb-1 font-medium">{formatDateLabel(tooltip.day.date)}</p>
          {tooltip.day.byModel.map((m) => (
            <p key={`${m.providerId}/${m.modelId}`} className="flex items-center gap-1 text-muted-foreground">
              <ModelSelectorLogo provider={m.providerId} className="size-3" />
              {m.modelId}
              <span className="ml-auto tabular-nums">
                {formatTokens(m.tokens)} tokens · {m.hours.toFixed(1)}h
              </span>
            </p>
          ))}
          <div className="mt-1 border-t pt-1 font-medium tabular-nums text-foreground">
            Total: {formatTokens(tooltip.day.totalTokens)} tokens ·{" "}
            {tooltip.day.totalHours.toFixed(1)}h
          </div>
        </div>
      )}
    </div>
  )
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function formatDateLabel(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00")
  return d.toLocaleDateString("pt-BR", { weekday: "short", day: "numeric", month: "short", year: "numeric" })
}
