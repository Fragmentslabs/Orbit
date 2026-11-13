import { useEffect, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { CheckCircle2, ListChecks, Loader2, PauseCircle } from "lucide-react"
import type { Task } from "@shared/pipeline"
import { usePipelineStore } from "@/src/stores/pipeline-store"
import {
  NativeWidgetEmpty,
  NativeWidgetShell,
  relativeMoment,
  useNow,
  type NativeWidgetProps,
} from "./widget-bits"

/** A completion older than this stops being "what just finished". */
const RECENT_MS = 6 * 60 * 60 * 1000

interface RunningTask {
  task: Task
  pipelineName: string
  phaseName: string
}

/**
 * The pipeline as a small board: how many tasks are moving, what each one is doing and the
 * last thing that finished. The store mirrors `pipeline:event`, so a task changing phase
 * updates the card before the person opens the pipeline screen.
 */
export function PipelineWidget({ compact, preview }: NativeWidgetProps) {
  const { t, i18n } = useTranslation()
  const pipelines = usePipelineStore((s) => s.pipelines)
  const tasksPerPipeline = usePipelineStore((s) => s.tasksPerPipeline)
  const loaded = usePipelineStore((s) => s.loaded)
  const load = usePipelineStore((s) => s.load)
  const now = useNow(20_000)

  useEffect(() => {
    if (!preview && !loaded) void load()
  }, [load, loaded, preview])

  const { running, pausedCount, recent } = useMemo(() => {
    const pipelineOf = new Map(pipelines.map((pipeline) => [pipeline.id, pipeline]))
    const tasks = Object.values(tasksPerPipeline).flat()
    const moving: RunningTask[] = []
    let paused = 0
    let last: { task: Task; pipelineName: string } | undefined

    for (const task of tasks) {
      const pipeline = pipelineOf.get(task.pipelineId)
      const pipelineName = pipeline?.name ?? ""
      if (task.status === "in_progress") {
        moving.push({
          task,
          pipelineName,
          phaseName: task.currentPhase !== null ? (pipeline?.phases[task.currentPhase]?.name ?? "") : "",
        })
      } else if (task.status === "paused") {
        paused += 1
      }
      if (task.status === "completed" && task.completedAt) {
        const at = Date.parse(task.completedAt)
        if (!Number.isNaN(at) && (!last || at > Date.parse(last.task.completedAt ?? ""))) {
          last = { task, pipelineName }
        }
      }
    }

    moving.sort((a, b) => Date.parse(a.task.startedAt ?? "") - Date.parse(b.task.startedAt ?? ""))
    return { running: moving, pausedCount: paused, recent: last }
  }, [pipelines, tasksPerPipeline])

  if (!loaded) {
    return (
      <NativeWidgetShell title={t("widgets.nativeWidgets.pipeline.name")} icon={ListChecks}>
        <NativeWidgetEmpty>{t("widgets.nativeWidgets.pipeline.loading")}</NativeWidgetEmpty>
      </NativeWidgetShell>
    )
  }

  if (pipelines.length === 0) {
    return (
      <NativeWidgetShell title={t("widgets.nativeWidgets.pipeline.name")} icon={ListChecks}>
        <NativeWidgetEmpty>{t("widgets.nativeWidgets.pipeline.none")}</NativeWidgetEmpty>
      </NativeWidgetShell>
    )
  }

  const recentAt = recent?.task.completedAt ? Date.parse(recent.task.completedAt) : NaN
  const recentFresh = !Number.isNaN(recentAt) && now - recentAt < RECENT_MS
  const first = running[0]

  return (
    <NativeWidgetShell
      title={t("widgets.nativeWidgets.pipeline.name")}
      icon={ListChecks}
      badge={
        running.length > 0 ? (
          <span className="inline-flex items-center gap-0.5 text-primary">
            <Loader2 className="size-2.5 animate-spin" />
            {running.length}
          </span>
        ) : pausedCount > 0 ? (
          <span className="inline-flex items-center gap-0.5 text-destructive">
            <PauseCircle className="size-2.5" />
            {pausedCount}
          </span>
        ) : null
      }
    >
      {compact ? (
        <div className="flex h-full flex-col justify-center gap-1.5">
          <div className="flex items-center gap-1.5">
            {running.length > 0 ? (
              <span className="size-1.5 animate-pulse rounded-full bg-primary" />
            ) : (
              <PauseCircle className="size-3 text-muted-foreground" />
            )}
            <span className="truncate text-[15px] font-semibold leading-none">
              {running.length > 0
                ? t("widgets.nativeWidgets.pipeline.running", { count: running.length })
                : pausedCount > 0
                  ? t("widgets.nativeWidgets.pipeline.paused", { count: pausedCount })
                  : t("widgets.nativeWidgets.pipeline.idle")}
            </span>
          </div>
          {first ? (
            <p className="truncate text-[9px] text-muted-foreground">
              {first.task.number ? `#${first.task.number} ` : ""}
              {first.task.title}
            </p>
          ) : recentFresh && recent ? (
            <div className="flex min-w-0 items-center gap-1.5">
              <CheckCircle2 className="size-3 shrink-0 text-primary" />
              <span className="truncate text-[9px]">{recent.task.title}</span>
              <span className="ml-auto shrink-0 text-[8px] text-muted-foreground">
                {relativeMoment(recentAt, now, i18n.language)}
              </span>
            </div>
          ) : (
            <p className="truncate text-[9px] text-muted-foreground">{t("widgets.nativeWidgets.pipeline.nothingRecent")}</p>
          )}
        </div>
      ) : (
        <div className="flex h-full flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            {running.length > 0 ? (
              <span className="size-2 animate-pulse rounded-full bg-primary" />
            ) : (
              <PauseCircle className="size-3.5 text-muted-foreground" />
            )}
            <span className="text-[17px] font-semibold leading-none">
              {running.length > 0
                ? t("widgets.nativeWidgets.pipeline.running", { count: running.length })
                : pausedCount > 0
                  ? t("widgets.nativeWidgets.pipeline.paused", { count: pausedCount })
                  : t("widgets.nativeWidgets.pipeline.idle")}
            </span>
          </div>

          {running.length > 0 && (
            <div className="flex flex-col gap-1">
              {running.slice(0, 2).map((item) => (
                <div key={item.task.id} className="min-w-0">
                  <p className="truncate text-[10px] font-medium leading-tight">
                    {item.task.number ? `#${item.task.number} ` : ""}
                    {item.task.title}
                  </p>
                  <p className="truncate text-[8px] text-muted-foreground">
                    {[item.pipelineName, item.phaseName].filter(Boolean).join(" · ")}
                  </p>
                </div>
              ))}
            </div>
          )}

          <div className="mt-auto border-t border-border/60 pt-1.5">
            {recentFresh && recent ? (
              <div className="flex min-w-0 items-center gap-1.5">
                <CheckCircle2 className="size-3 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[9px] font-medium leading-tight">{recent.task.title}</p>
                  <p className="truncate text-[8px] text-muted-foreground">
                    {t("widgets.nativeWidgets.pipeline.finished")} · {relativeMoment(recentAt, now, i18n.language)}
                  </p>
                </div>
              </div>
            ) : (
              <p className="truncate text-[9px] text-muted-foreground">{t("widgets.nativeWidgets.pipeline.nothingRecent")}</p>
            )}
          </div>
        </div>
      )}
    </NativeWidgetShell>
  )
}
