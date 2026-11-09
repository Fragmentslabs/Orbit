"use client"

import { useState } from "react"
import { useTranslation } from "react-i18next"
import { CheckIcon, ChevronDown, ClockIcon, EyeIcon, Loader2Icon, PlayIcon, X, XCircleIcon } from "lucide-react"
import type { OrchestrationPlan, OrchestrationTask, ProfileId } from "@shared/chat"
import { cn } from "@/lib/utils"
import { Hint } from "@/components/ui/hint"
import { Truncate } from "@/components/ui/truncated-text"
import { WorkerRow } from "@/src/components/worker-row"

/** Step of a task in the orchestration follow-up (shared with the plan). */
type TaskPhase = NonNullable<OrchestrationTask["phase"]>

export interface TaskItem {
  id: string
  title: string
  status: "idle" | "submitted" | "streaming" | "cancelling" | "fallback" | "error"
  mode?: "chat" | "code"
  /** The worker's own chat: the strip reads what it is doing from there, and opens it on click. */
  sessionId?: string
  /** The agent that runs this worker (its icon leads the row); absent = the general worker. */
  agent?: ProfileId
  /** Titles of the tasks this one waits for. */
  waitsFor?: string[]
  /** Step in the orchestra follow-up — when present, it rules the icon and "done" */
  phase?: TaskPhase
  /** Worker created by the orchestrator during review */
  extra?: boolean
  /** Adjustments it has already received */
  revisions?: number
  /** Review note (the requested adjustment, or why it failed) — in the tooltip */
  note?: string
}

const OPEN_PHASES = new Set<TaskPhase>(["queued", "running", "review", "adjustment"])

export function TaskProgress({
  tasks,
  title,
  defaultExpanded = true,
  onDismiss,
  followUp,
  onMergeAgain,
  live,
  interrupted,
  onContinue,
}: {
  tasks: TaskItem[]
  title?: string
  defaultExpanded?: boolean
  onDismiss?: () => void
  /** The orchestrator supervising (orchestra): what it is doing and the budget. */
  followUp?: OrchestrationPlan["review"]
  /** Accepted work left out of the chat: try to merge it again */
  onMergeAgain?: () => Promise<void>
  /**
   * Something is running RIGHT NOW. Absent = derived from the items, which is what
   * a card without steps has. A task in an open phase is not proof of it: a plan
   * cut short (app closed, run interrupted) keeps the phases where it stopped, and
   * reading them as "running" made the card spin forever — with no X, because the
   * X only appeared when nothing was running.
   */
  live?: boolean
  /** The run was cut short: the card says so and offers "Continue", even if every
   *  task happens to be resolved (the accepted work that was never merged). */
  interrupted?: boolean
  /** Runs again the tasks that were not accepted */
  onContinue?: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [merging, setMerging] = useState(false)
  const [continuing, setContinuing] = useState(false)
  const total = tasks.length
  // With steps (supervising orchestra), "done" means accepted by the
  // orchestrator — finishing a run still goes through the review.
  const done = tasks.filter((t) => (t.phase ? t.phase === "accepted" : t.status === "idle")).length
  const openTask = tasks.some((t) =>
    t.phase ? OPEN_PHASES.has(t.phase) : t.status === "submitted" || t.status === "streaming" || t.status === "cancelling" || t.status === "fallback",
  )
  const running = live ?? (openTask || !!followUp?.activity)
  const hasErrors = tasks.some((t) => (t.phase ? t.phase === "failed" : t.status === "error"))
  const failedCount = tasks.filter((t) => (t.phase ? t.phase === "failed" : t.status === "error")).length
  // Working right now: open and not just waiting its turn.
  const workingNow = tasks.filter((t) => (t.phase ? t.phase === "running" || t.phase === "review" || t.phase === "adjustment" : t.status === "submitted" || t.status === "streaming" || t.status === "fallback")).length
  // Nothing is running and the work did not end: where the run stopped. The
  // interrupted flag covers the plan whose tasks all closed but whose accepted
  // work was never merged.
  const stopped = !running && !hasErrors && (done < total || !!interrupted)

  if (total === 0) return null

  return (
    <div className="rounded-xl border border-sidebar-border bg-sidebar/50 text-xs">
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex flex-1 items-center gap-2 px-3 py-2 text-left hover:bg-sidebar-accent/30 transition-colors"
        >
          <ChevronDown className={cn("size-3 shrink-0 transition-transform text-muted-foreground", !expanded && "-rotate-90")} />
          {running ? (
            // One bullet while it works: the summary says how many, the rows say what.
            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary ring-4 ring-primary/15" />
          ) : hasErrors ? (
            <XCircleIcon className="size-3.5 shrink-0 text-destructive" />
          ) : stopped ? (
            <ClockIcon className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
          )}
          {running ? (
            <span className="min-w-0 truncate">
              <span className="font-medium text-foreground">{t("taskProgress.workers", { count: total })}</span>
              <span className="text-muted-foreground"> · {t("taskProgress.runningCount", { count: workingNow })}</span>
              {/* A failure must not hide behind a closed strip. */}
              {failedCount > 0 && <span className="text-destructive"> · {t("taskProgress.errorCount", { count: failedCount })}</span>}
            </span>
          ) : (
            <span className="min-w-0 truncate">
              <span className="font-medium text-foreground">
                {hasErrors
                  ? t("taskProgress.errors", { title: title ?? t("taskProgress.title") })
                  : stopped
                    ? t("taskProgress.interrupted", { title: title ?? t("taskProgress.title") })
                    : t("taskProgress.done", { title: title ?? t("taskProgress.title") })}
              </span>
              <span className="text-muted-foreground"> · {done}/{total}</span>
            </span>
          )}
        </button>
        {/* The X exists whenever nothing is running — done, failed OR stopped
            halfway. It used to wait for `allDoneOrError`, so a plan that lost its
            run could not be closed at all. */}
        {!running && onDismiss && (
          <Hint label={t("common.dismiss")}>
            <button
              type="button"
              onClick={onDismiss}
              className="mr-2 flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-sidebar-accent"
            >
              <X className="size-3" />
            </button>
          </Hint>
        )}
      </div>

      {expanded && followUp && (followUp.activity || followUp.maxAdjustments > 0 || followUp.merge) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-sidebar-border px-3 py-1.5 text-[11px] text-muted-foreground">
          {followUp.activity && (
            <span className="flex min-w-0 items-center gap-1.5 text-foreground">
              <EyeIcon className="size-3 shrink-0 text-primary" />
              <Truncate text={followUp.activity}>
                <span className="truncate">{followUp.activity}</span>
              </Truncate>
            </span>
          )}
          {followUp.maxAdjustments > 0 && (
            <span className="ml-auto tabular-nums">
              {t("taskProgress.adjustments", { used: followUp.adjustmentsUsed, cap: followUp.maxAdjustments })}
            </span>
          )}
          {followUp.merge && (
            <span className={cn("basis-full", followUp.merge.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive")}>
              {followUp.merge.detail}
            </span>
          )}
          {followUp.merge?.pending && onMergeAgain && !running && (
            <button
              type="button"
              disabled={merging}
              onClick={() => {
                setMerging(true)
                void onMergeAgain().finally(() => setMerging(false))
              }}
              className="flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] text-foreground transition-colors hover:bg-sidebar-accent disabled:opacity-50"
            >
              {merging && <Loader2Icon className="size-3 animate-spin" />}
              {t("taskProgress.rejoin")}
            </button>
          )}
        </div>
      )}

      {expanded && (
        <div className="border-t border-sidebar-border px-1 pb-1.5 pt-1">
          {tasks.map((task) => (
            <WorkerRow key={task.id} task={task} live={running} />
          ))}
        </div>
      )}

      {/* Interrupted: what is left runs again from where it stopped. The accepted
          work stays as it is — the workers continue in their own sessions. */}
      {!running && onContinue && (openTask || interrupted) && (
        <div className="flex items-center gap-2 border-t border-sidebar-border px-3 py-1.5 text-[11px]">
          <span className="min-w-0 flex-1 text-muted-foreground">{t("taskProgress.interruptedHint")}</span>
          <button
            type="button"
            disabled={continuing}
            onClick={() => {
              setContinuing(true)
              void onContinue().finally(() => setContinuing(false))
            }}
            className="flex shrink-0 items-center gap-1 rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
          >
            {continuing ? <Loader2Icon className="size-3 animate-spin" /> : <PlayIcon className="size-3" />}
            {t("taskProgress.continue")}
          </button>
        </div>
      )}
    </div>
  )
}
