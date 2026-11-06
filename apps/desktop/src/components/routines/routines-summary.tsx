import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { Loader2 } from "lucide-react"
import type { Routine } from "@shared/routines"
import { upcomingRuns } from "@shared/routines"
import { cn } from "@/lib/utils"
import { formatCost, formatWhen } from "@/src/lib/format"
import { useRoutinesStore } from "@/src/stores/routines-store"
import { useOpenRun } from "./use-open-run"

const DAY_MS = 86_400_000
/** Rows of each list: enough to read at a glance, the rest is in the list and the agenda. */
const MAX_ROWS = 6

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-card p-3.5">
      <p className="text-[13px] font-semibold">{title}</p>
      {subtitle && <p className="mb-1 text-[11px] text-muted-foreground">{subtitle}</p>}
      <div className={cn(!subtitle && "mt-1")}>{children}</div>
    </div>
  )
}

/**
 * What the page shows on the right while no routine is open: how the routines are doing
 * (active, failures, spend) and what is coming and what just ran. Every row opens its routine.
 */
/**
 * `full` is the column beside the routines; `side` the same column when the page is narrow
 * (numbers in rows, fewer columns per row); `strip` the one that goes below the routines when
 * not even a narrow column fits (the numbers in a line and what runs next).
 */
export type SummaryVariant = "full" | "side" | "strip"

export function RoutinesSummary({ routines, variant = "full", onSelect }: {
  routines: Routine[]
  variant?: SummaryVariant
  onSelect: (id: string) => void
}) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language
  const runs = useRoutinesStore((s) => s.runs)
  const openRun = useOpenRun()

  const summary = useMemo(() => {
    const now = Date.now()
    const byId = new Map(routines.map((r) => [r.id, r]))
    const mine = runs.filter((r) => byId.has(r.routineId))

    const running = mine.filter((r) => r.status === "running")
    const upcoming = routines
      .flatMap((routine) => upcomingRuns(routine, now, now + DAY_MS, { limit: 12 }).map((at) => ({ routine, at })))
      .sort((a, b) => a.at - b.at)

    const recent = [...mine].sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_ROWS)
    const last30 = mine.filter((r) => r.startedAt >= now - 30 * DAY_MS)
    const failures = mine.filter((r) => r.status === "error" && r.startedAt >= now - 7 * DAY_MS)

    return {
      now,
      byId,
      running,
      upcoming: upcoming.slice(0, MAX_ROWS),
      recent,
      active: routines.filter((r) => r.active).length,
      failures: failures.length,
      failedTitles: [...new Set(failures.map((r) => byId.get(r.routineId)?.title).filter((x): x is string => !!x))],
      cost: last30.reduce((s, r) => s + r.cost, 0),
      executions: last30.length,
    }
  }, [routines, runs])

  const kpis = [
    {
      label: t("routines.summary.active"),
      value: t("routines.summary.activeOf", { active: summary.active, total: routines.length }),
      meta: t("routines.summary.paused", { count: routines.length - summary.active }),
    },
    {
      label: t("routines.summary.failures"),
      value: String(summary.failures),
      meta: summary.failedTitles.length === 0
        ? t("routines.summary.noFailures")
        : summary.failedTitles.length === 1
          ? summary.failedTitles[0]
          : t("routines.summary.failuresMeta", { count: summary.failedTitles.length }),
    },
    {
      label: t("routines.summary.spent"),
      value: formatCost(summary.cost),
      meta: t("routines.summary.executions", { count: summary.executions }),
    },
  ]

  const compact = variant !== "full"
  // Rows of "next": the same in every variant, only the columns change.
  const nextRows =
    summary.running.length === 0 && summary.upcoming.length === 0 ? (
      <p className="py-2 text-[11px] text-muted-foreground">{t("routines.summary.nothingNext")}</p>
    ) : (
      <>
        {summary.running.map((run) => {
          const routine = summary.byId.get(run.routineId)
          if (!routine) return null
          return (
            <Row key={`running:${run.sessionId}`} onClick={() => onSelect(routine.id)}>
              <span className={cn("shrink-0 text-primary", compact ? "w-[5.5rem]" : "w-28")}>{t("routines.summary.now")}</span>
              <span className="min-w-0 flex-1 truncate">{routine.title}</span>
              <Loader2 className="size-3 shrink-0 animate-spin text-primary" />
            </Row>
          )
        })}
        {(variant === "strip" ? summary.upcoming.slice(0, 3) : summary.upcoming).map(({ routine, at }) => (
          <Row key={`${routine.id}:${at}`} onClick={() => onSelect(routine.id)}>
            <span className={cn("shrink-0 tabular-nums text-muted-foreground", compact ? "w-[5.5rem]" : "w-28")}>
              {formatWhen(at, locale, summary.now)}
            </span>
            <span className="min-w-0 flex-1 truncate">{routine.title}</span>
            {variant !== "side" && (
              <span className="shrink-0 rounded-md bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {routine.mode === "chat" ? t("viewScope.chat") : t("viewScope.code")}
              </span>
            )}
          </Row>
        ))}
      </>
    )

  // Below the routines: one line with the numbers and what runs next, nothing more.
  if (variant === "strip") {
    return (
      <div className="flex flex-col gap-2 rounded-xl border bg-card p-3">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-xs">
          {kpis.map((k) => (
            <span key={k.label} className="flex items-baseline gap-1.5">
              <span className="text-muted-foreground">{k.label}</span>
              <span className="font-semibold tabular-nums">{k.value}</span>
            </span>
          ))}
        </div>
        <div>
          <p className="text-[11px] font-semibold text-muted-foreground">{t("routines.summary.next")}</p>
          {nextRows}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {variant === "side" ? (
        <div className="flex flex-col rounded-xl border bg-card px-3.5 py-1">
          {kpis.map((k) => (
            <div key={k.label} className="flex items-baseline justify-between gap-3 border-t py-2 text-xs first:border-t-0">
              <span className="text-muted-foreground">{k.label}</span>
              <span className="font-semibold tabular-nums">{k.value}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-3">
          {kpis.map((k) => (
            <div key={k.label} className="flex flex-col gap-0.5 rounded-xl border bg-card px-3.5 py-3">
              <span className="text-[11px] text-muted-foreground">{k.label}</span>
              <span className="text-lg font-semibold tabular-nums">{k.value}</span>
              <span className="text-[11px] text-muted-foreground">{k.meta}</span>
            </div>
          ))}
        </div>
      )}

      <Card title={t("routines.summary.next")} subtitle={variant === "side" ? undefined : t("routines.summary.nextHint")}>
        {nextRows}
      </Card>

      <Card title={t("routines.summary.recent")}>
        {summary.recent.length === 0 ? (
          <p className="py-2 text-[11px] text-muted-foreground">{t("routines.summary.noRuns")}</p>
        ) : (
          summary.recent.map((run) => {
            const routine = summary.byId.get(run.routineId)
            if (!routine) return null
            // The row is an execution: it goes to ITS conversation; when that was deleted, to the routine.
            return (
              <Row key={run.sessionId} onClick={() => (openRun(run.sessionId) ? undefined : onSelect(routine.id))}>
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    run.status === "running" && "bg-blue-400",
                    run.status === "error" && "bg-destructive",
                    run.status !== "running" && run.status !== "error" && "bg-emerald-500",
                  )}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate">{routine.title}</span>
                {variant !== "side" && <span className="w-28 shrink-0 text-muted-foreground">{formatWhen(run.startedAt, locale)}</span>}
                <span className="w-14 shrink-0 text-right font-medium tabular-nums">{formatCost(run.cost)}</span>
              </Row>
            )
          })
        )}
      </Card>
    </div>
  )
}

function Row({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 border-t py-[9px] text-left text-xs transition-colors first:border-t-0 hover:bg-muted/40"
    >
      {children}
    </button>
  )
}
