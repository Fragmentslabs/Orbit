"use client"

import { useState } from "react"
import { useTranslation } from "react-i18next"
import { CheckIcon, ChevronDown, ClockIcon, EyeIcon, Loader2Icon, MessageSquareIcon, TerminalIcon, WrenchIcon, X, XCircleIcon } from "lucide-react"
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
}: {
  tasks: TaskItem[]
  title?: string
  defaultExpanded?: boolean
  onDismiss?: () => void
  /** The orchestrator supervising (orchestra): what it is doing and the budget. */
  followUp?: OrchestrationPlan["review"]
  /** Accepted work left out of the chat: try to merge it again */
  onMergeAgain?: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [merging, setMerging] = useState(false)
  const total = tasks.length
  // With steps (supervising orchestra), "done" means accepted by the
  // orchestrator — finishing a run still goes through the review.
  const done = tasks.filter((t) => (t.phase ? t.phase === "accepted" : t.status === "idle")).length
  const running =
    tasks.some((t) => (t.phase ? OPEN_PHASES.has(t.phase) : t.status === "submitted" || t.status === "streaming" || t.status === "cancelling" || t.status === "fallback")) ||
    !!followUp?.activity
  const hasErrors = tasks.some((t) => (t.phase ? t.phase === "failed" : t.status === "error"))
  const progress = total > 0 ? Math.round((done / total) * 100) : 0
  const allDoneOrError = !running && (done === total || hasErrors)

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
          ) : allDoneOrError && hasErrors ? (
            <XCircleIcon className="size-3.5 shrink-0 text-destructive" />
          ) : (
            <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
          )}
          <span className="font-medium text-foreground">
            {running
              ? t("taskProgress.inProgress", { title: title ?? t("taskProgress.title") })
              : allDoneOrError && hasErrors
                ? t("taskProgress.errors", { title: title ?? t("taskProgress.title") })
                : t("taskProgress.done", { title: title ?? t("taskProgress.title") })}
          </span>
          <span className="text-muted-foreground">
            {done}/{total}
          </span>
          <div className="ml-auto h-1.5 min-w-16 rounded-full bg-muted overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-500",
                hasErrors ? "bg-destructive" : "bg-primary",
              )}
              style={{ width: `${progress}%` }}
            />
          </div>
        </button>
        {allDoneOrError && onDismiss && (
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
                {task.phase ? <PhaseIcon phase={task.phase} /> : <TaskIcon status={task.status} />}
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
                {task.phase && task.phase !== "accepted" && task.phase !== "running" && (
                  <span className={cn("shrink-0 text-[10px]", task.phase === "failed" ? "text-destructive" : "text-muted-foreground")}>
                    {/* The phase ids and the catalog keys are not the same word
                        ("queued" → phase.queue): map them explicitly instead of
                        building the key from the id. */}
                    {task.phase === "adjustment" && t("taskProgress.phase.adjustment", { n: task.revisions ?? 1 })}
                    {task.phase === "review" && t("taskProgress.phase.review")}
                    {task.phase === "failed" && t("taskProgress.phase.failed")}
                    {task.phase === "queued" && t("taskProgress.phase.queue")}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function TaskIcon({ status }: { status: TaskItem["status"] }) {
  switch (status) {
    case "submitted":
    case "streaming":
    case "fallback":
      return <Loader2Icon className="size-3.5 shrink-0 animate-spin text-primary" />
    case "error":
      return <XCircleIcon className="size-3.5 shrink-0 text-destructive" />
    case "idle":
      return <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
    default:
      return <div className="size-3.5 shrink-0 rounded-full border border-muted-foreground/30" />
  }
}

function PhaseIcon({ phase }: { phase: TaskPhase }) {
  switch (phase) {
    case "queued":
      return <ClockIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
    case "running":
      return <Loader2Icon className="size-3.5 shrink-0 animate-spin text-primary" />
    case "review":
      return <EyeIcon className="size-3.5 shrink-0 animate-pulse text-primary" />
    case "adjustment":
      return <WrenchIcon className="size-3.5 shrink-0 animate-pulse text-amber-500" />
    case "accepted":
      return <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
    case "failed":
      return <XCircleIcon className="size-3.5 shrink-0 text-destructive" />
  }
}
