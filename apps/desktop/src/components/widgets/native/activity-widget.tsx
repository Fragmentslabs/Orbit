import { useTranslation } from "react-i18next"
import { Activity, Flame } from "lucide-react"
import type { AnalyticsDay } from "@shared/analytics"
import { dateKey } from "@/src/components/usage/usage-utils"
import {
  compactHours,
  NativeWidgetShell,
  NativeWidgetSkeleton,
  useUsageSummary,
  type NativeWidgetProps,
} from "./widget-bits"

/** How many calendar weeks fit inside a 2x2 cell at a legible square size. */
const WEEKS = 15
const CELL = 7
const GAP = 2

/** 0 = nothing, 4 = a heavy day. The thresholds are hours worked, not messages. */
function levelOf(hours: number): number {
  if (hours <= 0) return 0
  if (hours < 0.25) return 1
  if (hours < 1) return 2
  if (hours < 3) return 3
  return 4
}

const LEVEL_ALPHA = [0, 18, 35, 62, 100] as const

/**
 * A year of work drawn like a commit graph: one square per day, a column per week, the
 * stronger color for the days that cost more. It is filled from the same days the usage
 * screen reads, so the grid is the app's own history — not a decoration.
 */
export function ActivityWidget({ preview }: NativeWidgetProps) {
  const { t, i18n } = useTranslation()
  const summary = useUsageSummary(!preview)
  if (!summary) return <NativeWidgetSkeleton />

  const byDate = new Map<string, AnalyticsDay>((summary.year ?? summary.days).map((day) => [day.date, day]))
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  // Sunday of the first column; the current week's future days stay empty.
  const start = new Date(today)
  start.setDate(today.getDate() - today.getDay() - (WEEKS - 1) * 7)

  const cells = Array.from({ length: WEEKS * 7 }, (_, index) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)
    const future = date.getTime() > today.getTime()
    const day = future ? undefined : byDate.get(dateKey(date))
    const hours = day?.totalHours ?? 0
    const level = levelOf(hours)
    const label = date.toLocaleDateString(i18n.language, { day: "2-digit", month: "short" })
    const title = future
      ? ""
      : day
        ? `${label} · ${compactHours(hours)} · ${day.totalMessages} ${t("widgets.nativeWidgets.usage.chats")}`
        : `${label} · ${t("widgets.nativeWidgets.activity.nothing")}`
    return {
      key: dateKey(date),
      future,
      title,
      style: future
        ? { backgroundColor: "transparent" }
        : { backgroundColor: level ? `color-mix(in oklab, var(--primary) ${LEVEL_ALPHA[level]}%, transparent)` : "var(--muted)" },
    }
  })

  return (
    <NativeWidgetShell
      title={t("widgets.nativeWidgets.activity.name")}
      icon={Activity}
      badge={
        <span className="inline-flex items-center gap-0.5">
          <Flame className="size-2.5 text-primary" />
          {summary.currentStreak}
        </span>
      }
    >
      <div className="flex h-full flex-col justify-between gap-1.5">
        <div
          className="grid"
          style={{
            gridAutoFlow: "column",
            gridTemplateRows: `repeat(7, ${CELL}px)`,
            gridAutoColumns: `${CELL}px`,
            gap: `${GAP}px`,
          }}
          title={t("widgets.nativeWidgets.activity.streak", { count: summary.currentStreak })}
        >
          {cells.map((cell) => (
            <span key={cell.key} title={cell.title} className="rounded-[1px]" style={cell.style} />
          ))}
        </div>
        <div className="flex items-end justify-between text-[8px] leading-none text-muted-foreground">
          <span>{t("widgets.nativeWidgets.activity.weeks", { count: WEEKS })}</span>
          <span>{t("widgets.nativeWidgets.activity.today")}</span>
        </div>
      </div>
    </NativeWidgetShell>
  )
}
