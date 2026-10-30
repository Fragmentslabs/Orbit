import { useDraggable } from "@dnd-kit/core"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { AlertTriangleIcon, ClockIcon, CornerUpLeftIcon, GitBranchIcon, GlobeIcon, Loader2Icon, MessageSquarePlusIcon, PauseIcon, PlayIcon } from "lucide-react"
import type { Pipeline, Task } from "@shared/pipeline"
import { taskRound } from "@shared/pipeline"
import { cn } from "@/lib/utils"
import { Hint } from "@/components/ui/hint"
import { AGENT_BROWSER_FRESH_MS, usePanelStore } from "@/src/stores/panel-store"
import { Truncate } from "@/components/ui/truncated-text"

/** Formats milliseconds as "12min" / "1h 05min". */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}min`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}min`
}

export function formatCost(value: number): string {
  return value >= 0.01 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`
}

/**
 * Task card on the board. Draggable: dropping it on a phase column starts the
 * task from that phase on (D8) — that is why the card carries the whole task in
 * the drag data, and the column decides what to do.
 */
export function TaskCard({
  task,
  pipeline,
  progress,
  waitingTitle,
  isNext,
  onOpen,
  onStart,
  onPause,
  onResume,
  onReturn,
  onResumeWithInstruction,
}: {
  task: Task
  pipeline: Pipeline
  progress?: string
  /** Title of the dependency that blocks the task (pending, waiting). */
  waitingTitle?: string
  /** Task the automatic queue will fire when the current one completes. */
  isNext?: boolean
  onOpen: () => void
  onStart: () => void
  onPause: () => void
  onResume: () => void
  /** Completed task: opens the return with a comment (a new round) */
  onReturn: () => void
  /** Paused task: resume telling the phase what it must do differently */
  onResumeWithInstruction: () => void
}) {
  const { t } = useTranslation()
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `task:${task.id}`,
    data: { task },
  })

  const running = task.status === "in_progress"
  const failed = task.pauseReason === "error"
  const phaseName = task.currentPhase != null ? pipeline.phases[task.currentPhase]?.name : undefined
  const round = taskRound(task)

  // The task's agent browser in use (in the background) — same mechanics as the
  // chat's "testing…" chip: a 2s tick so the indicator disappears when it expires.
  const browserSessionId = `pipeline_${task.id}`
  const browserEntry = usePanelStore((s) => s.agentBrowser[browserSessionId])
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!browserEntry) return
    const timer = setInterval(() => setTick((v) => v + 1), 2_000)
    return () => clearInterval(timer)
  }, [browserEntry])
  const browserActive = !!browserEntry && Date.now() - browserEntry.at <= AGENT_BROWSER_FRESH_MS

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={onOpen}
      className={cn(
        "group cursor-pointer rounded-lg border bg-card p-2.5 text-left shadow-sm transition-colors hover:border-ring",
        isDragging && "opacity-40",
        failed && "border-destructive/50",
      )}
    >
      <div className="flex items-start gap-2">
        <Truncate text={task.title}>
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{task.title}</span>
        </Truncate>
        {running ? (
          <Hint label={t("pipeline.pause")}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onPause()
              }}
              className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <PauseIcon className="size-3" />
            </button>
          </Hint>
        ) : task.status !== "completed" ? (
          <>
          {task.status === "paused" && (
            <Hint label={t("pipeline.resumeWithInstruction")}>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onResumeWithInstruction()
                }}
                className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <MessageSquarePlusIcon className="size-3" />
              </button>
            </Hint>
          )}
          <Hint label={failed ? t("pipeline.resume") : t("pipeline.start")}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                if (task.status === "paused") onResume()
                else onStart()
              }}
              className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <PlayIcon className="size-3" />
            </button>
          </Hint>
          </>
        ) : (
          <Hint label={t("pipeline.return")}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onReturn()
              }}
              className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <CornerUpLeftIcon className="size-3" />
            </button>
          </Hint>
        )}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
        {task.worktree && (
          <span title={task.worktree.branch} className="flex items-center">
            <GitBranchIcon className="size-2.5" />
          </span>
        )}
        {round > 1 && (
          <span
            title={t("pipeline.roundTitle", { round })}
            className="rounded-full bg-violet-500/10 px-1.5 py-0.5 font-medium text-violet-600 dark:text-violet-400"
          >
            {t("pipeline.roundShort", { round })}
          </span>
        )}
        {waitingTitle && (
          <span
            title={t("pipeline.waitingTitle", { title: waitingTitle })}
            className="flex max-w-full items-center gap-1 rounded-full bg-muted px-1.5 py-0.5"
          >
            <ClockIcon className="size-2.5 shrink-0" />
            <Truncate text={t("pipeline.waiting", { title: waitingTitle })}>
              <span className="truncate">{t("pipeline.waiting", { title: waitingTitle })}</span>
            </Truncate>
          </span>
        )}
        {isNext && (
          <span className="flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-primary">
            <PlayIcon className="size-2.5" />
            {t("pipeline.next")}
          </span>
        )}
        {browserActive && (
          <Hint label={t("pipeline.browserInUse")}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                usePanelStore.getState().openAgentBrowser(browserSessionId)
              }}
              className="flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-emerald-600 transition-colors hover:bg-emerald-500/20 dark:text-emerald-400"
            >
       
               <GlobeIcon className="size-2.5" />
            {t("chat.browser.testing")}
          </button>
          </Hint>
        )}
        {running && (
          <span className="flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-primary">
            <Loader2Icon className="size-2.5 animate-spin" />
            {phaseName}
          </span>
        )}
        {failed && (
          <span className="flex items-center gap-1 rounded-full bg-destructive/10 px-1.5 py-0.5 text-destructive">
            <AlertTriangleIcon className="size-2.5" />
            {t("pipeline.error")}
          </span>
        )}
        {task.pushError && (
          <span
            title={task.pushError}
            className="flex items-center gap-1 rounded-full bg-yellow-500/15 px-1.5 py-0.5 text-yellow-600 dark:text-yellow-400"
          >
            <AlertTriangleIcon className="size-2.5" />
            {t("pipeline.pushFailed")}
          </span>
        )}
        {task.commitError && (
          <span
            title={task.commitError}
            className="flex items-center gap-1 rounded-full bg-yellow-500/15 px-1.5 py-0.5 text-yellow-600 dark:text-yellow-400"
          >
            <AlertTriangleIcon className="size-2.5" />
            {t("pipeline.commitFailed")}
          </span>
        )}
        {task.status === "paused" && !failed && (
          <span className="flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5">
            <PauseIcon className="size-2.5" />
            {phaseName ?? t("pipeline.paused")}
          </span>
        )}
        {task.workTimeMs > 0 && (
          <span className="flex items-center gap-1">
            <ClockIcon className="size-2.5" />
            {formatDuration(task.workTimeMs)}
          </span>
        )}
        {task.tokens > 0 && <span>{task.tokens.toLocaleString()} tok</span>}
        {task.dependsOn.length > 0 && <span>· {t("pipeline.dependencies", { count: task.dependsOn.length })}</span>}
      </div>

      {/* Live feed: only the tail of what the agent is writing */}
      {running && progress && (
        <p className="mt-1.5 line-clamp-2 text-[10px] leading-tight text-muted-foreground/80">{progress.slice(-160)}</p>
      )}
    </div>
  )
}
