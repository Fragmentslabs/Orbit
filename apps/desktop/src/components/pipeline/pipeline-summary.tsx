import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { Loader2 } from "lucide-react"
import type { Pipeline, Task } from "@shared/pipeline"
import { cn } from "@/lib/utils"
import { formatDuration, formatWhen } from "@/src/lib/format"
import { EMPTY_TASKS } from "@/src/stores/pipeline-store"

/** Completed tasks are only the latest ones: they pile up forever, the others are all shown. */
const MAX_DONE = 30

/** Tasks of the pipeline board, not the ones that are a delivery of the merge flow. */
export const realTasks = (tasks: Task[]) => tasks.filter((t) => !t.deliveryId)

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-card p-3.5">
      <p className="text-[13px] font-semibold">{title}</p>
      {subtitle && <p className="mb-1 hidden text-[11px] text-muted-foreground @[24rem]:block">{subtitle}</p>}
      <div className={cn(!subtitle && "mt-1")}>{children}</div>
    </div>
  )
}

function Row({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="-mx-2 flex w-[calc(100%+1rem)] flex-col gap-1.5 rounded-lg px-2 py-[9px] text-left text-xs transition-colors hover:bg-muted/50"
    >
      {children}
    </button>
  )
}

const label = (task: Task) => (task.number ? `#${task.number}` : "")

/**
 * What the pipeline page shows beside the list: what is running now, what needs the user (a
 * failure or a pause) and what was finished lately, across all the pipelines; every row opens
 * that pipeline's board.
 */
export function PipelineSummary({ pipelines, tasksPerPipeline, onOpen }: {
  pipelines: Pipeline[]
  tasksPerPipeline: Record<string, Task[]>
  onOpen: (pipelineId: string) => void
}) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language

  const summary = useMemo(() => {
    const entries = pipelines.flatMap((pipeline) => realTasks(tasksPerPipeline[pipeline.id] ?? EMPTY_TASKS).map((task) => ({ pipeline, task })))
    const phaseOf = (pipeline: Pipeline, task: Task) => {
      const index = task.currentPhase ?? 0
      return { name: pipeline.phases[index]?.name ?? "", index: index + 1, of: pipeline.phases.length }
    }
    return {
      running: entries.filter((e) => e.task.status === "in_progress").map((e) => ({ ...e, phase: phaseOf(e.pipeline, e.task) })),
      attention: entries.filter((e) => e.task.status === "paused").map((e) => ({ ...e, phase: phaseOf(e.pipeline, e.task) })),
      done: entries
        .filter((e) => e.task.status === "completed" && e.task.completedAt)
        .sort((a, b) => Date.parse(b.task.completedAt!) - Date.parse(a.task.completedAt!))
        .slice(0, MAX_DONE),
    }
  }, [pipelines, tasksPerPipeline])

  const showPipeline = pipelines.length > 1

  return (
    <div className="flex flex-col gap-3">
      <Card title={t("pipeline.summary.running")} subtitle={t("pipeline.summary.runningHint")}>
        {summary.running.length === 0 ? (
          <p className="py-2 text-[11px] text-muted-foreground">{t("pipeline.summary.nothingRunning")}</p>
        ) : (
          summary.running.map(({ pipeline, task, phase }) => (
            <Row key={task.id} onClick={() => onOpen(pipeline.id)}>
              <span className="flex w-full items-center gap-2">
                <Loader2 className="size-3 shrink-0 animate-spin text-blue-400" />
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-muted-foreground">{label(task)}</span> {task.title}
                </span>
                <span className="hidden shrink-0 text-[11px] text-muted-foreground @[24rem]:inline">{formatDuration(task.workTimeMs)}</span>
              </span>
              <span className="flex w-full items-center gap-2 pl-5">
                <span className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-full rounded-full bg-blue-400"
                    style={{ width: `${Math.round(((phase.index - 0.5) / Math.max(phase.of, 1)) * 100)}%` }}
                  />
                </span>
                <span className="shrink-0 text-right text-[11px] text-muted-foreground">
                  {phase.name} ({phase.index}/{phase.of})
                </span>
              </span>
              {showPipeline && <span className="pl-5 text-[11px] text-muted-foreground">{pipeline.name}</span>}
            </Row>
          ))
        )}
      </Card>

      <Card title={t("pipeline.summary.attention")}>
        {summary.attention.length === 0 ? (
          <p className="py-2 text-[11px] text-muted-foreground">{t("pipeline.summary.nothingStuck")}</p>
        ) : (
          summary.attention.map(({ pipeline, task, phase }) => {
            const failed = task.pauseReason === "error"
            return (
              <Row key={task.id} onClick={() => onOpen(pipeline.id)}>
                <span className="flex w-full items-center gap-2">
                  <span className={cn("size-2 shrink-0 rounded-full", failed ? "bg-destructive" : "bg-amber-400")} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">
                      <span className="text-muted-foreground">{label(task)}</span> {task.title}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {failed
                        ? t("pipeline.summary.failedIn", { phase: phase.name, reason: task.error ?? "" })
                        : t("pipeline.summary.pausedIn", { phase: phase.name })}
                    </span>
                  </span>
                </span>
              </Row>
            )
          })
        )}
      </Card>

      <Card title={t("pipeline.summary.done")}>
        {summary.done.length === 0 ? (
          <p className="py-2 text-[11px] text-muted-foreground">{t("pipeline.summary.nothingDone")}</p>
        ) : (
          summary.done.map(({ pipeline, task }) => (
            <Row key={task.id} onClick={() => onOpen(pipeline.id)}>
              <span className="flex w-full items-center gap-2">
                <span className="size-2 shrink-0 rounded-full bg-emerald-500" aria-hidden />
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-muted-foreground">{label(task)}</span> {task.title}
                </span>
                <span className="hidden shrink-0 text-[11px] tabular-nums text-muted-foreground @[24rem]:inline">
                  {formatWhen(Date.parse(task.completedAt!), locale)}
                </span>
              </span>
            </Row>
          ))
        )}
      </Card>
    </div>
  )
}
