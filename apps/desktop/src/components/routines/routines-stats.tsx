import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { isFinishedOnce, type Routine } from "@shared/routines"
import { StatBadges } from "@/src/components/stat-badges"
import { formatCost } from "@/src/lib/format"
import { useRoutinesStore } from "@/src/stores/routines-store"

const DAY_MS = 86_400_000

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
      // A finished one-off is inactive but was not paused by anyone: it does not count here.
      paused: routines.filter((r) => !r.active && !isFinishedOnce(r)).length,
      failures: failures.length,
      failedTitles: [...new Set(failures.map((r) => byId.get(r.routineId)?.title).filter((x): x is string => !!x))],
      cost: last30.reduce((sum, r) => sum + r.cost, 0),
      executions: last30.length,
    }
  }, [routines, runs])

  return (
    <StatBadges
      separated={separated}
      items={[
        {
          label: t("routines.summary.active"),
          value: t("routines.summary.activeOf", { active: stats.active, total: routines.length }),
          title: t("routines.summary.paused", { count: stats.paused }),
        },
        {
          label: t("routines.summary.failures"),
          value: String(stats.failures),
          tone: stats.failures > 0 ? "bad" : undefined,
          title: stats.failedTitles.length > 0 ? stats.failedTitles.join(", ") : t("routines.summary.noFailures"),
        },
        {
          label: t("routines.summary.spent"),
          value: formatCost(stats.cost),
          title: t("routines.summary.executions", { count: stats.executions }),
        },
      ]}
    />
  )
}
