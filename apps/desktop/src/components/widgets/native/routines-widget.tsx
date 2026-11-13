import { useEffect, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { CheckCircle2, Clock3, Loader2, TimerReset, XCircle } from "lucide-react"
import { nextRoutineRun, type RoutineRun } from "@shared/routines"
import { formatDuration } from "@/src/lib/format"
import { useRoutinesStore } from "@/src/stores/routines-store"
import {
  NativeWidgetEmpty,
  NativeWidgetShell,
  relativeMoment,
  useNow,
  type NativeWidgetProps,
} from "./widget-bits"

/** A run that ended this long ago is still "the recent one" worth showing. */
const RECENT_MS = 24 * 60 * 60 * 1000

interface Upcoming {
  id: string
  title: string
  at: number
}

/**
 * Routines: the next one on the clock, plus whatever is running or just finished. The
 * store is fed by `routines:event` from the main process, so the widget moves on its own —
 * nothing here polls the scheduler.
 */
export function RoutinesWidget({ compact, preview }: NativeWidgetProps) {
  const { t, i18n } = useTranslation()
  const routines = useRoutinesStore((s) => s.routines)
  const runs = useRoutinesStore((s) => s.runs)
  const loaded = useRoutinesStore((s) => s.loaded)
  const load = useRoutinesStore((s) => s.load)
  const now = useNow(15_000)

  useEffect(() => {
    if (!preview && !loaded) void load()
  }, [load, loaded, preview])

  const titleOf = useMemo(() => new Map(routines.map((routine) => [routine.id, routine.title])), [routines])

  const upcoming = useMemo<Upcoming[]>(() => {
    return routines
      .map((routine) => ({ id: routine.id, title: routine.title, at: nextRoutineRun(routine, now) }))
      .filter((item): item is Upcoming => item.at !== null)
      .sort((a, b) => a.at - b.at)
  }, [routines, now])

  const running = useMemo(
    () => runs.filter((run) => run.status === "running").sort((a, b) => b.startedAt - a.startedAt),
    [runs],
  )

  const recent = useMemo(() => {
    return runs
      .filter((run): run is RoutineRun & { completedAt: number } => run.status !== "running" && typeof run.completedAt === "number")
      .sort((a, b) => b.completedAt - a.completedAt)[0]
  }, [runs])

  const activeCount = routines.filter((routine) => routine.active).length
  const recentFresh = recent !== undefined && now - recent.completedAt < RECENT_MS

  if (!loaded && routines.length === 0) {
    return (
      <NativeWidgetShell title={t("widgets.nativeWidgets.routines.name")} icon={TimerReset}>
        <NativeWidgetEmpty>{t("widgets.nativeWidgets.routines.loading")}</NativeWidgetEmpty>
      </NativeWidgetShell>
    )
  }

  if (routines.length === 0) {
    return (
      <NativeWidgetShell title={t("widgets.nativeWidgets.routines.name")} icon={TimerReset}>
        <NativeWidgetEmpty>{t("widgets.nativeWidgets.routines.none")}</NativeWidgetEmpty>
      </NativeWidgetShell>
    )
  }

  const runningRow = running[0]
  const next = upcoming[0]
  const second = upcoming[1]

  return (
    <NativeWidgetShell
      title={t("widgets.nativeWidgets.routines.name")}
      icon={TimerReset}
      badge={
        running.length > 0 ? (
          <span className="inline-flex items-center gap-0.5 text-primary">
            <Loader2 className="size-2.5 animate-spin" />
            {running.length}
          </span>
        ) : (
          t("widgets.nativeWidgets.routines.active", { count: activeCount })
        )
      }
    >
      {compact ? (
        <div className="flex h-full flex-col justify-center gap-1.5">
          {runningRow ? (
            <WidgetRow
              tone="running"
              title={titleOf.get(runningRow.routineId) ?? t("widgets.nativeWidgets.routines.unknown")}
              when={formatDuration(now - runningRow.startedAt)}
            />
          ) : next ? (
            <WidgetRow tone="next" title={next.title} when={relativeMoment(next.at, now, i18n.language)} />
          ) : recentFresh ? (
            <WidgetRow
              tone={recent.status === "error" ? "error" : "ok"}
              title={titleOf.get(recent.routineId) ?? t("widgets.nativeWidgets.routines.unknown")}
              when={relativeMoment(recent.completedAt, now, i18n.language)}
            />
          ) : (
            <WidgetRow tone="idle" title={t("widgets.nativeWidgets.routines.none")} when="" />
          )}
          {runningRow ? (
            next ? (
              <WidgetRow tone="next" title={next.title} when={relativeMoment(next.at, now, i18n.language)} />
            ) : recentFresh ? (
              <WidgetRow
                tone={recent.status === "error" ? "error" : "ok"}
                title={titleOf.get(recent.routineId) ?? t("widgets.nativeWidgets.routines.unknown")}
                when={relativeMoment(recent.completedAt, now, i18n.language)}
              />
            ) : second ? (
              <WidgetRow tone="next" title={second.title} when={relativeMoment(second.at, now, i18n.language)} />
            ) : null
          ) : recentFresh ? (
            <WidgetRow
              tone={recent.status === "error" ? "error" : "ok"}
              title={titleOf.get(recent.routineId) ?? t("widgets.nativeWidgets.routines.unknown")}
              when={relativeMoment(recent.completedAt, now, i18n.language)}
            />
          ) : second ? (
            <WidgetRow tone="next" title={second.title} when={relativeMoment(second.at, now, i18n.language)} />
          ) : null}
        </div>
      ) : (
        <div className="flex h-full flex-col gap-1.5">
          <div className="rounded-md bg-muted/40 p-1.5">
            {runningRow ? (
              <WidgetRow
                tone="running"
                title={titleOf.get(runningRow.routineId) ?? t("widgets.nativeWidgets.routines.unknown")}
                when={formatDuration(now - runningRow.startedAt)}
              />
            ) : recentFresh ? (
              <WidgetRow
                tone={recent.status === "error" ? "error" : "ok"}
                title={titleOf.get(recent.routineId) ?? t("widgets.nativeWidgets.routines.unknown")}
                when={relativeMoment(recent.completedAt, now, i18n.language)}
              />
            ) : (
              <WidgetRow tone="idle" title={t("widgets.nativeWidgets.routines.nothingRunning")} when="" />
            )}
          </div>

          <p className="text-[8px] uppercase tracking-wide text-muted-foreground">
            {t("widgets.nativeWidgets.routines.upcoming")}
          </p>
          <div className="flex flex-col gap-1">
            {upcoming.length === 0 ? (
              <p className="text-[9px] leading-tight text-muted-foreground">{t("widgets.nativeWidgets.routines.noneUpcoming")}</p>
            ) : (
              upcoming.slice(0, 2).map((item) => (
                <WidgetRow key={item.id} tone="next" title={item.title} when={relativeMoment(item.at, now, i18n.language)} />
              ))
            )}
          </div>
        </div>
      )}
    </NativeWidgetShell>
  )
}

function WidgetRow({ tone, title, when }: { tone: "running" | "next" | "ok" | "error" | "idle"; title: string; when: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {tone === "running" ? (
        <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
      ) : tone === "ok" ? (
        <CheckCircle2 className="size-3 shrink-0 text-primary" />
      ) : tone === "error" ? (
        <XCircle className="size-3 shrink-0 text-destructive" />
      ) : tone === "next" ? (
        <Clock3 className="size-3 shrink-0 text-muted-foreground" />
      ) : (
        <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/30" />
      )}
      <span className="truncate text-[10px] font-medium leading-tight">{title}</span>
      {when && <span className="ml-auto shrink-0 text-[8px] tabular-nums text-muted-foreground">{when}</span>}
    </div>
  )
}
