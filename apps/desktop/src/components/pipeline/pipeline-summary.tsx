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

/** A block of the right rail: a quiet label and its rows — no card inside a 240px column. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <p className="px-0.5 pb-1 text-[11px] font-medium text-muted-foreground">{title}</p>
      <div className="flex flex-col gap-0.5">{children}</div>
    </section>
  )
}

function Row({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/50"
    >
      {children}
    </button>
  )
}

function Empty({ text }: { text: string }) {
  return <p className="px-2 py-1 text-[11px] text-muted-foreground">{text}</p>
}

const label = (task: Task) => (task.number ? `#${task.number}` : "")

/**
 * The right rail of the pipeline page, the same width and shape as the menu of the Tools and
 * Usage pages: what is running now, what needs the user (a failure or a pause) and what was
 * finished lately, across all the pipelines. Every row opens that pipeline's board.
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
    <div className="flex flex-col gap-4">
      <Section title={t("pipeline.summary.running")}>
        {summary.running.length === 0 ? (
          <Empty text={t("pipeline.summary.nothingRunning")} />
        ) : (
          summary.running.map(({ pipeline, task, phase }) => (
            <Row key={task.id} onClick={() => onOpen(pipeline.id)}>
              <span className="flex w-full items-center gap-2">
                <Loader2 className="size-3 shrink-0 animate-spin text-blue-400" />
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-muted-foreground">{label(task)}</span> {task.title}
                </span>
              </span>
              <span className="truncate pl-5 text-[11px] text-muted-foreground">
                {phase.name} ({phase.index}/{phase.of}) · {formatDuration(task.workTimeMs)}
              </span>
              {showPipeline && <span className="truncate pl-5 text-[11px] text-muted-foreground">{pipeline.name}</span>}
            </Row>
          ))
        )}
      </Section>

      <Section title={t("pipeline.summary.attention")}>
        {summary.attention.length === 0 ? (
          <Empty text={t("pipeline.summary.nothingStuck")} />
        ) : (
          summary.attention.map(({ pipeline, task, phase }) => {
            const failed = task.pauseReason === "error"
            return (
              <Row key={task.id} onClick={() => onOpen(pipeline.id)}>
                <span className="flex w-full items-center gap-2">
                  <span className={cn("size-2 shrink-0 rounded-full", failed ? "bg-destructive" : "bg-amber-400")} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="text-muted-foreground">{label(task)}</span> {task.title}
                  </span>
                </span>
                <span className="truncate pl-4 text-[11px] text-muted-foreground">
                  {failed
                    ? t("pipeline.summary.failedIn", { phase: phase.name, reason: task.error ?? "" })
                    : t("pipeline.summary.pausedIn", { phase: phase.name })}
                </span>
              </Row>
            )
          })
        )}
      </Section>

      <Section title={t("pipeline.summary.done")}>
        {summary.done.length === 0 ? (
          <Empty text={t("pipeline.summary.nothingDone")} />
        ) : (
          summary.done.map(({ pipeline, task }) => (
            <Row key={task.id} onClick={() => onOpen(pipeline.id)}>
              <span className="flex w-full items-center gap-2">
                <span className="size-2 shrink-0 rounded-full bg-emerald-500" aria-hidden />
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-muted-foreground">{label(task)}</span> {task.title}
                </span>
              </span>
              <span className="pl-4 text-[11px] text-muted-foreground">{formatWhen(Date.parse(task.completedAt!), locale)}</span>
            </Row>
          ))
        )}
      </Section>
    </div>
  )
}
