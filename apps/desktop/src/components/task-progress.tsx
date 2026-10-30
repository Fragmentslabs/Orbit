"use client"

import { useState } from "react"
import { useTranslation } from "react-i18next"
import { CheckIcon, ChevronDown, ClockIcon, EyeIcon, Loader2Icon, MessageSquareIcon, PlayIcon, TerminalIcon, WrenchIcon, X, XCircleIcon } from "lucide-react"
import type { OrchestrationPlan, OrchestrationTask } from "@shared/chat"
import { cn } from "@/lib/utils"
import { Hint } from "@/components/ui/hint"
import { Truncate } from "@/components/ui/truncated-text"

/** Step of a task in the orchestration follow-up (shared with the plan). */
type TaskPhase = NonNullable<OrchestrationTask["phase"]>

export interface TaskItem {
  id: string
  title: string
  status: "idle" | "submitted" | "streaming" | "cancelling" | "fallback" | "error"
  mode?: "chat" | "code"
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
  const progress = total > 0 ? Math.round((done / total) * 100) : 0
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
            <Loader2Icon className="size-3.5 shrink-0 animate-spin text-primary" />
          ) : hasErrors ? (
            <XCircleIcon className="size-3.5 shrink-0 text-destructive" />
          ) : stopped ? (
            <ClockIcon className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
          )}
          <span className="font-medium text-foreground">
            {running
              ? t("taskProgress.inProgress", { title: title ?? t("taskProgress.title") })
              : hasErrors
                ? t("taskProgress.errors", { title: title ?? t("taskProgress.title") })
                : stopped
                  ? t("taskProgress.interrupted", { title: title ?? t("taskProgress.title") })
                  : t("taskProgress.done", { title: title ?? t("taskProgress.title") })}
          </span>
          <span className="text-muted-foreground">
            {done}/{total}
          </span>
          <div className="ml-auto h-1.5 min-w-16 rounded-full bg-muted overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-500",
                hasErrors ? "bg-destructive" : stopped ? "bg-amber-500" : "bg-primary",
              )}
              style={{ width: `${progress}%` }}
            />
          </div>
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
          {tasks.map((task) => {
            const isDone = task.phase ? task.phase === "accepted" : task.status === "idle"
            return (
              <div
                key={task.id}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1",
                  isDone && "opacity-60",
                )}
                title={task.note}
              >
                {task.phase ? <PhaseIcon phase={task.phase} live={running} /> : <TaskIcon status={task.status} live={running} />}
                {task.mode === "code" ? (
                  <TerminalIcon className="size-3 shrink-0 text-muted-foreground" />
                ) : task.mode === "chat" ? (
                  <MessageSquareIcon className="size-3 shrink-0 text-muted-foreground" />
                ) : null}
                <Truncate text={task.title}>
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      isDone && "line-through text-muted-foreground",
                    )}
                  >
                    {task.title}
                  </span>
                </Truncate>
                {task.extra && (
                  <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">{t("taskProgress.extra")}</span>
                )}
                {/* A step that is open while nothing is running (a plan cut short)
                    says where it stopped instead of staying silent. */}
                {task.phase && task.phase !== "accepted" && (task.phase !== "running" || !running) && (
                  <span className={cn("shrink-0 text-[10px]", task.phase === "failed" ? "text-destructive" : "text-muted-foreground")}>
                    {/* The phase ids and the catalog keys are not the same word
                        ("queued" → phase.queue): map them explicitly instead of
                        building the key from the id. */}
                    {task.phase === "adjustment" && t("taskProgress.phase.adjustment", { n: task.revisions ?? 1 })}
                    {task.phase === "review" && t("taskProgress.phase.review")}
                    {task.phase === "failed" && t("taskProgress.phase.failed")}
                    {task.phase === "queued" && t("taskProgress.phase.queue")}
                    {task.phase === "running" && t("taskProgress.phase.stopped")}
                  </span>
                )}
              </div>
            )
          })}
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

function TaskIcon({ status, live }: { status: TaskItem["status"]; live: boolean }) {
  switch (status) {
    case "submitted":
    case "streaming":
    case "fallback":
      // Not running: the status is what it was when the run was cut, not a turn
      // happening now — so no spinner.
      return live ? (
        <Loader2Icon className="size-3.5 shrink-0 animate-spin text-primary" />
      ) : (
        <ClockIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
      )
    case "error":
      return <XCircleIcon className="size-3.5 shrink-0 text-destructive" />
    case "idle":
      return <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
    default:
      return <div className="size-3.5 shrink-0 rounded-full border border-muted-foreground/30" />
  }
}

function PhaseIcon({ phase, live }: { phase: TaskPhase; live: boolean }) {
  switch (phase) {
    case "queued":
      return <ClockIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
    // The open steps keep their meaning while nothing runs — the worker was
    // running/reviewed when the run was cut — but they stop animating.
    case "running":
      return live ? (
        <Loader2Icon className="size-3.5 shrink-0 animate-spin text-primary" />
      ) : (
        <ClockIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
      )
    case "review":
      return live ? (
        <EyeIcon className="size-3.5 shrink-0 animate-pulse text-primary" />
      ) : (
        <EyeIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
      )
    case "adjustment":
      return live ? (
        <WrenchIcon className="size-3.5 shrink-0 animate-pulse text-amber-500" />
      ) : (
        <WrenchIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
      )
    case "accepted":
      return <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
    case "failed":
      return <XCircleIcon className="size-3.5 shrink-0 text-destructive" />
  }
}
