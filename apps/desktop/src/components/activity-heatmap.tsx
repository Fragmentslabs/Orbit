import { useMemo, useState } from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import type { AnalyticsDay } from "@shared/analytics"
import { ModelSelectorLogo } from "@/src/components/ai/model-selector"
import { formatCost, formatTokens } from "@/src/lib/format"

interface HeatmapProps {
  days: AnalyticsDay[]
  className?: string
  cellSize?: string
}

const TOTAL_WEEKS = 30

export function ActivityHeatmap({ days, className, cellSize = "size-3" }: HeatmapProps) {
  const { t, i18n } = useTranslation()
  const [tooltip, setTooltip] = useState<{
    day: AnalyticsDay
    x: number
    y: number
  } | null>(null)

  const { weeks, maxScore } = useMemo(() => {
    const dayMap = new Map<string, AnalyticsDay>()
    for (const d of days) dayMap.set(d.date, d)

    const today = new Date()
    const monday = new Date(today)
    monday.setDate(monday.getDate() - ((today.getDay() + 6) % 7))

    const start = new Date(monday)
    start.setDate(start.getDate() - (TOTAL_WEEKS - 1) * 7)

    let mx = 1
    const weekData: { date: string; day: AnalyticsDay | null }[][] = []
    const current = new Date(start)

    for (let w = 0; w < TOTAL_WEEKS; w++) {
      const week: { date: string; day: AnalyticsDay | null }[] = []
      for (let d = 0; d < 7; d++) {
        const ds = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, "0")}-${String(current.getDate()).padStart(2, "0")}`
        week.push({ date: ds, day: dayMap.get(ds) ?? null })
        if (dayMap.get(ds)) {
          const day = dayMap.get(ds)!
          const s = day.totalTokens + day.totalMessages * 50
          if (s > mx) mx = s
        }
        current.setDate(current.getDate() + 1)
      }
      weekData.push(week)
    }
    return { weeks: weekData, maxScore: mx }
  }, [days])

  const level = (day: AnalyticsDay | null): number => {
    if (!day || day.totalMessages === 0) return 0
    const score = day.totalTokens + day.totalMessages * 50
    const ratio = score / maxScore
    if (ratio <= 0.25) return 1
    if (ratio <= 0.5) return 2
    if (ratio <= 0.75) return 3
    return 4
  }

  const OPACITIES = ["0.18", "0.38", "0.62", "0.92"]

  return (
    <div className={cn("w-fit ", className)}>
      <div className="flex justify-center gap-px">
        <div className="flex gap-px">
          {weeks.map((week, wi) => (
            <div key={wi} className="flex flex-col gap-px">
              {week.map((cell) => {
                const lvl = level(cell.day)
                return (
                  <div
                    key={cell.date}
                    className={cn("relative rounded-[1.5px]", cellSize)}
                    style={{
                      backgroundColor:
                        lvl === 0
                          ? "oklch(from var(--muted-foreground) l c h / 0.12)"
                          : `oklch(from var(--primary) l c h / ${OPACITIES[lvl - 1]})`,
                    }}
                    onMouseEnter={(e) => {
                      if (cell.day && cell.day.totalMessages > 0) {
                        const rect = e.currentTarget.getBoundingClientRect()
                        setTooltip({ day: cell.day, x: rect.left, y: rect.top })
                      }
                    }}
                    onFocus={() => {}}
                    onMouseLeave={() => setTooltip(null)}
                  />
                )
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="mt-1 flex items-center justify-center gap-4 text-[9px] text-muted-foreground">
        <div className="flex items-center gap-1">
          <span>{t("analytics.heatmap.less")}</span>
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className={cn("rounded-[1.5px]", cellSize)}
              style={{ backgroundColor: `oklch(from var(--primary) l c h / ${OPACITIES[i]})` }}
            />
          ))}
          <span>{t("analytics.heatmap.more")}</span>
        </div>
        <div className="flex items-center gap-1">
          <div className={cn("rounded-[1.5px]", cellSize)} style={{ backgroundColor: "oklch(from var(--muted-foreground) l c h / 0.12)" }} />
          <span>{t("analytics.heatmap.noActivity")}</span>
        </div>
      </div>

      {/* Tooltip — portaled to body to escape dialog's transform */}
      {tooltip && createPortal(
        <div
          className="pointer-events-none fixed z-[999] w-max min-w-[240px] rounded-lg border bg-popover px-3 py-2 text-xs shadow-md"
          style={{ left: tooltip.x - 120, top: tooltip.y - 150 }}
        >
          <p className="mb-1 font-medium">
            {new Date(tooltip.day.date + "T12:00:00").toLocaleDateString(i18n.language, {
              weekday: "short",
              day: "numeric",
              month: "short",
              year: "numeric",
            })}
          </p>
          {tooltip.day.byModel.map((m) => (
            <p key={`${m.providerId}/${m.modelId}`} className="flex items-center gap-1 text-muted-foreground">
              <ModelSelectorLogo provider={m.providerId} className="size-2.5" />
              {m.modelId}
              <span className="ml-auto tabular-nums">
                {formatTokens(m.tokens)} tok · {m.hours.toFixed(1)}h · {formatCost(m.cost)}
              </span>
            </p>
          ))}
          <div className="mt-1 border-t pt-1 font-medium tabular-nums text-foreground">
            {t("analytics.heatmap.total")}: {formatTokens(tooltip.day.totalTokens)} tok · {tooltip.day.totalHours.toFixed(1)}h · {formatCost(tooltip.day.totalCost)}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
