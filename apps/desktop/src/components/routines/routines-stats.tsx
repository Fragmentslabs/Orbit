import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import type { Routine } from "@shared/routines"
import { cn } from "@/lib/utils"
import { formatCost } from "@/src/lib/format"
import { useRoutinesStore } from "@/src/stores/routines-store"

const DAY_MS = 86_400_000

function Badge({ label, value, tone, title }: { label: string; value: string; tone?: "bad"; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-baseline gap-1.5 rounded-md px-2 py-1 text-[11px]",
        tone === "bad" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground",
      )}
    >
      {label}
      <span className={cn("font-semibold tabular-nums", tone !== "bad" && "text-foreground")}>{value}</span>
    </span>
  )
}

/**
 * The numbers of the routines in a fixed footer under the list or the agenda, as small badges:
 * how many are active, how many executions failed in the last 7 days and what they cost in the
 * last 30. It is always there, whatever the width of the page — the summary beside the routines
 * can be compact, these three cannot be missing.
 */
export function RoutinesStatsBar({ routines, separated }: { routines: Routine[]; /** A line under the badges, for when something comes right after them. */ separated?: boolean }) {
  const { t } = useTranslation()
  const runs = useRoutinesStore((s) => s.runs)

  const stats = useMemo(() => {
    const now = Date.now()
    const byId = new Map(routines.map((r) => [r.id, r]))
    const mine = runs.filter((r) => byId.has(r.routineId))
    const failures = mine.filter((r) => r.status === "error" && r.startedAt >= now - 7 * DAY_MS)
    const last30 = mine.filter((r) => r.startedAt >= now - 30 * DAY_MS)
    return {
      active: routines.filter((r) => r.active).length,
      failures: failures.length,
      failedTitles: [...new Set(failures.map((r) => byId.get(r.routineId)?.title).filter((x): x is string => !!x))],
      cost: last30.reduce((sum, r) => sum + r.cost, 0),
      executions: last30.length,
    }
  }, [routines, runs])

  return (
    <div className={cn("flex shrink-0 flex-wrap items-center gap-1.5", separated && "border-b pb-2.5")}>
      <Badge
        label={t("routines.summary.active")}
        value={t("routines.summary.activeOf", { active: stats.active, total: routines.length })}
        title={t("routines.summary.paused", { count: routines.length - stats.active })}
      />
      <Badge
        label={t("routines.summary.failures")}
        value={String(stats.failures)}
        tone={stats.failures > 0 ? "bad" : undefined}
        title={stats.failedTitles.length > 0 ? stats.failedTitles.join(", ") : t("routines.summary.noFailures")}
      />
      <Badge
        label={t("routines.summary.spent")}
        value={formatCost(stats.cost)}
        title={t("routines.summary.executions", { count: stats.executions })}
      />
    </div>
  )
}
