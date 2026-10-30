import { useLayoutEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import { Folder } from "lucide-react"
import { cn } from "@/lib/utils"
import type { AnalyticsDay } from "@shared/analytics"
import { ModelSelectorLogo } from "@/src/components/ai/model-selector"
import { formatCost, formatTokens } from "@/src/lib/format"

interface HeatmapProps {
  days: AnalyticsDay[]
  className?: string
  cellSize?: string
  /** What the day tooltip opens: usage by model or by project. The
   *  squares do not change — the day is the same, only its reading is different. */
  breakdown?: "model" | "project"
  /** projectId → displayable name, for the reading by project. */
  projectNames?: Record<string, string>
}

const TOTAL_WEEKS = 30

export function ActivityHeatmap({
  days,
  className,
  cellSize = "size-3",
  breakdown = "model",
  projectNames,
}: HeatmapProps) {
  const { t, i18n } = useTranslation()
  // We store the rectangle of the CELL; the balloon position comes from a measurement
  // of it once mounted — that is the only way to know whether it fits above and inside the window.
  const [tooltip, setTooltip] = useState<{
    day: AnalyticsDay
    anchor: { left: number; top: number; right: number; bottom: number }
  } | null>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const [tooltipPos, setTooltipPos] = useState<{ left: number; top: number } | null>(null)

  // Measures the balloon after it mounts and pins it to the window: centered on the
  // cell, above it by default, flipping down when there is no room.
  // Without this the offset was fixed and the balloon leaked out of the app at the
  // edges — which is exactly where the first and the last weeks sit.
  useLayoutEffect(() => {
    const el = tooltipRef.current
    if (!tooltip || !el) {
      setTooltipPos(null)
      return
    }
    const MARGIN = 8
    const { width, height } = el.getBoundingClientRect()
    const { left: aLeft, right: aRight, top: aTop, bottom: aBottom } = tooltip.anchor

    let left = (aLeft + aRight) / 2 - width / 2
    left = Math.min(Math.max(MARGIN, left), Math.max(MARGIN, window.innerWidth - width - MARGIN))

    let top = aTop - height - MARGIN
    if (top < MARGIN) {
      top = Math.min(aBottom + MARGIN, Math.max(MARGIN, window.innerHeight - height - MARGIN))
    }

    setTooltipPos({ left, top })
  }, [tooltip])

  // The intensity of the square is HOURS worked on the day — that is what this chart
  // sets out to show. A day with a message but no accounted hours stays
  // painted in the faintest tone, not blanked out.
  //
  // Hours without a reply also count: the time is credited to the day of the
  // PREVIOUS message, so a question at 23:55 answered at 00:03 leaves the first
  // day with hours and no assistant reply. Requiring only the reply
  // erased that day from the chart while its hours stayed in the total.
  const scoreOf = (day: AnalyticsDay | null): number | null =>
    day && (day.totalMessages > 0 || day.totalHours > 0) ? day.totalHours : null

  const { weeks, maxScore } = useMemo(() => {
    const dayMap = new Map<string, AnalyticsDay>()
    for (const d of days) dayMap.set(d.date, d)

    const today = new Date()
    const monday = new Date(today)
    monday.setDate(monday.getDate() - ((today.getDay() + 6) % 7))

    const start = new Date(monday)
    start.setDate(start.getDate() - (TOTAL_WEEKS - 1) * 7)

    // Zero floor on purpose: the scale is now in hours, and a 1h floor
    // would flatten every short day into the faintest tone.
    let mx = 0
    const weekData: { date: string; day: AnalyticsDay | null }[][] = []
    const current = new Date(start)

    for (let w = 0; w < TOTAL_WEEKS; w++) {
      const week: { date: string; day: AnalyticsDay | null }[] = []
      for (let d = 0; d < 7; d++) {
        const ds = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, "0")}-${String(current.getDate()).padStart(2, "0")}`
        week.push({ date: ds, day: dayMap.get(ds) ?? null })
        const score = scoreOf(dayMap.get(ds) ?? null)
        if (score !== null && score > mx) mx = score
        current.setDate(current.getDate() + 1)
      }
      weekData.push(week)
    }
    return { weeks: weekData, maxScore: mx }
  }, [days])

  const level = (day: AnalyticsDay | null): number => {
    const score = scoreOf(day)
    if (score === null) return 0
    const ratio = score / Math.max(maxScore, Number.EPSILON)
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
                      if (cell.day && scoreOf(cell.day) !== null) {
                        const r = e.currentTarget.getBoundingClientRect()
                        setTooltip({
                          day: cell.day,
                          anchor: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
                        })
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
          ref={tooltipRef}
          className="pointer-events-none fixed z-[999] w-max min-w-[240px] max-w-[calc(100vw-16px)] rounded-lg border bg-popover px-3 py-2 text-xs shadow-md"
          style={
            tooltipPos
              ? { left: tooltipPos.left, top: tooltipPos.top }
              : // First frame: no measurement yet. It stays mounted and invisible
                // so it can be measured, instead of blinking in the wrong place.
                { left: 0, top: 0, visibility: "hidden" }
          }
        >
          <p className="mb-1 font-medium">
            {new Date(tooltip.day.date + "T12:00:00").toLocaleDateString(i18n.language, {
              weekday: "short",
              day: "numeric",
              month: "short",
              year: "numeric",
            })}
          </p>
          {breakdown === "model"
            ? tooltip.day.byModel.map((m) => (
                <p key={`${m.providerId}/${m.modelId}`} className="flex items-center gap-1 text-muted-foreground">
                  <ModelSelectorLogo provider={m.providerId} className="size-2.5" />
                  {m.modelId}
                  <span className="ml-auto tabular-nums">
                    {formatTokens(m.tokens)} tok · {m.hours.toFixed(1)}h · {formatCost(m.cost)}
                  </span>
                </p>
              ))
            : [...tooltip.day.byProject]
                .sort((a, b) => b.hours - a.hours)
                .map((p) => (
                  <p key={p.projectId} className="flex items-center gap-1 text-muted-foreground">
                    <Folder className="size-2.5 shrink-0" />
                    {projectNames?.[p.projectId] ?? t("analytics.noProject")}
                    <span className="ml-auto tabular-nums">
                      {formatTokens(p.tokens)} tok · {p.hours.toFixed(1)}h · {formatCost(p.cost)}
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
