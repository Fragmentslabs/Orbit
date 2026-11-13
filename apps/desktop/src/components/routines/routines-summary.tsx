import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { CheckIcon, ChevronRightIcon, Loader2, XIcon } from "lucide-react"
import type { Routine, RoutineRun } from "@shared/routines"
import { upcomingRuns } from "@shared/routines"
import { cn } from "@/lib/utils"
import { formatDuration, formatTime, formatWhen } from "@/src/lib/format"
import { useRoutinesStore } from "@/src/stores/routines-store"

const DAY_MS = 86_400_000
/** Rows of each list: enough to read at a glance, the rest is in the agenda. */
const MAX_UPCOMING = 10
const MAX_RECENT = 6

function startOfDay(ts: number): number {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** "today"/"tomorrow" from Intl; the weekday for the rest of the week. */
function dayLabel(ts: number, locale: string, now: number): string {
  const diff = Math.round((startOfDay(ts) - startOfDay(now)) / DAY_MS)
  if (diff <= 1) return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(diff, "day")
  return new Date(ts).toLocaleDateString(locale, { weekday: "long" })
}

function Stat({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className="min-w-0 rounded-[9px] border bg-card px-2 py-1.5">
      <div className="truncate text-[9px] leading-tight text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 text-[13px] font-semibold leading-tight", bad && "text-destructive")}>{value}</div>
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="px-0.5 text-[9.5px] uppercase tracking-[0.09em] text-muted-foreground/60">{children}</p>
}

function StatusIcon({ run }: { run: RoutineRun }) {
  if (run.status === "running") return <Loader2 className="size-3 shrink-0 animate-spin text-primary" />
  if (run.status === "error") return <XIcon className="size-3 shrink-0 text-destructive" />
  return <CheckIcon className="size-3 shrink-0 text-emerald-500" />
}

/**
 * What the Routines page shows on the right: how the routines are doing (total, active, failed
 * today), what is coming in the next week and what just ran. Every row opens its routine.
 */
export function RoutinesSummary({ routines, onSelect, onShowAll }: {
  routines: Routine[]
  onSelect: (id: string) => void
  /** Opens the agenda, where the whole week is visible. */
  onShowAll?: () => void
}) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language
  const runs = useRoutinesStore((s) => s.runs)

  const data = useMemo(() => {
    const now = Date.now()
    const byId = new Map(routines.map((r) => [r.id, r]))
    const mine = runs.filter((r) => byId.has(r.routineId))
    const active = routines.filter((r) => r.active).length

    const marks = routines
      .flatMap((routine) =>
        upcomingRuns(routine, now, now + 7 * DAY_MS, { limit: 4, includeInactive: true }).map((at) => ({ routine, at })),
      )
      .sort((a, b) => a.at - b.at)
      .slice(0, MAX_UPCOMING)

    const groups: { label: string; rows: { routine: Routine; at: number }[] }[] = []
    for (const item of marks) {
      const label = dayLabel(item.at, locale, now)
      const last = groups[groups.length - 1]
      if (last && last.label === label) last.rows.push(item)
      else groups.push({ label, rows: [item] })
    }

    const recent = [...mine].sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_RECENT)
    return { now, byId, active, groups, recent }
  }, [routines, runs, locale])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pb-3 pr-0.5">
      <div className="grid grid-cols-2 gap-1.5">
        <Stat label={t("routines.summary.total")} value={String(routines.length)} />
        <Stat label={t("routines.summary.active")} value={String(data.active)} />
      </div>

      <section className="flex flex-col gap-1.5">
        <SectionLabel>{t("routines.summary.next")}</SectionLabel>
        {data.groups.length === 0 ? (
          <p className="px-2 py-1 text-[11px] text-muted-foreground">{t("routines.summary.nothingNext")}</p>
        ) : (
          <div className="flex flex-col">
            {data.groups.map((group) => (
              <div key={group.label} className="flex flex-col">
                <p className="px-2 pb-1 pt-1.5 text-[9px] uppercase tracking-[0.08em] text-muted-foreground/60">
                  {group.label}
                </p>
                {group.rows.map(({ routine, at }) => {
                  const members = routine.team?.members.length ?? 0
                  return (
                    <button
                      key={`${routine.id}:${at}`}
                      type="button"
                      onClick={() => onSelect(routine.id)}
                      className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[11.5px] transition-colors hover:bg-accent/60"
                    >
                      <span className="w-10 shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                        {formatTime(at, locale)}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-medium">{routine.title}</span>
                      <span className="shrink-0 text-[9.5px] text-muted-foreground/60">
                        {!routine.active
                          ? t("routines.list.paused")
                          : members > 0
                            ? t("routines.chat.agentCount", { count: members })
                            : "—"}
                      </span>
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-1.5">
        <SectionLabel>{t("routines.summary.recent")}</SectionLabel>
        {data.recent.length === 0 ? (
          <p className="px-2 py-1 text-[11px] text-muted-foreground">{t("routines.runs.empty")}</p>
        ) : (
          <div className="flex flex-col">
            {data.recent.map((run) => {
              const routine = data.byId.get(run.routineId)
              if (!routine) return null
              return (
                <button
                  key={run.sessionId}
                  type="button"
                  onClick={() => onSelect(routine.id)}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent/60"
                >
                  <StatusIcon run={run} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11.5px] font-medium">{routine.title}</div>
                    <div className="mt-0.5 truncate text-[9.5px] text-muted-foreground/60">
                      {formatWhen(run.startedAt, locale)}
                      {run.reason && ` · ${t(`routines.card.reason.${run.reason}`)}`}
                    </div>
                  </div>
                  <span
                    className={cn(
                      "shrink-0 text-[9.5px] text-muted-foreground/60",
                      run.status === "error" && "text-destructive",
                      run.status === "running" && "text-primary",
                    )}
                  >
                    {run.status === "running"
                      ? t("routines.summary.now")
                      : run.status === "error"
                        ? t("routines.summary.failedShort")
                        : run.completedAt
                          ? formatDuration(run.completedAt - run.startedAt)
                          : "—"}
                  </span>
                </button>
              )
            })}
          </div>
        )}
        {onShowAll && data.recent.length > 0 && (
          <button
            type="button"
            onClick={onShowAll}
            className="flex items-center gap-1 self-start px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            {t("routines.summary.showAll")}
            <ChevronRightIcon className="size-3" />
          </button>
        )}
      </section>
    </div>
  )
}
