import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { AlertTriangleIcon, CheckCircle2Icon, ClockIcon, GitCommitIcon, Loader2Icon } from "lucide-react"
import type { Pipeline, Task } from "@shared/pipeline"
import { formatCost, formatDuration } from "./task-card"

/**
 * Pipeline report in the board footer (§14): one line, without stealing space
 * from the kanban. Computed in the renderer from the tasks the store already
 * has — asking the main process on every change would mean a round trip per
 * phase event.
 */
export function PipelineFooter({ pipeline, tasks }: { pipeline: Pipeline; tasks: Task[] }) {
  const { t } = useTranslation()

  const summary = useMemo(() => {
    const commits = new Set<string>()
    let tokens = 0
    let cost = 0
    let time = 0
    for (const task of tasks) {
      tokens += task.tokens
      cost += task.cost
      time += task.workTimeMs
      for (const note of task.notes) if (note.commitHash) commits.add(note.commitHash)
      // Final commits from the engine (current round and previous ones), as in the report
      if (task.finalCommitHash) commits.add(task.finalCommitHash)
      for (const hash of task.previousCommits ?? []) commits.add(hash)
    }
    return {
      completed: tasks.filter((t) => t.status === "completed").length,
      failed: tasks.filter((t) => t.pauseReason === "error").length,
      inProgress: tasks.filter((t) => t.status === "in_progress").length,
      total: tasks.length,
      commits: [...commits],
      tokens,
      cost,
      time,
    }
  }, [tasks])

  if (tasks.length === 0) return null

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
      <span className="font-medium text-foreground">{pipeline.name}</span>
      <Item icon={<CheckCircle2Icon className="size-3 text-emerald-500" />} value={`${summary.completed}/${summary.total}`} title={t("pipeline.completedPlural")} />
      {summary.inProgress > 0 && (
        <Item icon={<Loader2Icon className="size-3 animate-spin text-primary" />} value={String(summary.inProgress)} title={t("pipeline.inProgress")} />
      )}
      {summary.failed > 0 && (
        <Item icon={<AlertTriangleIcon className="size-3 text-destructive" />} value={String(summary.failed)} title={t("pipeline.failures")} />
      )}
      {summary.commits.length > 0 && (
        <Item
          icon={<GitCommitIcon className="size-3" />}
          value={summary.commits.slice(0, 3).map((c) => c.slice(0, 7)).join(", ") + (summary.commits.length > 3 ? "…" : "")}
          title={t("pipeline.commits")}
        />
      )}
      <Item icon={<ClockIcon className="size-3" />} value={formatDuration(summary.time)} title={t("pipeline.totalTime")} />
      <span title={t("pipeline.tokens")}>{summary.tokens.toLocaleString()} tok</span>
      <span title={t("pipeline.cost")}>{formatCost(summary.cost)}</span>
    </div>
  )
}

function Item({ icon, value, title }: { icon: React.ReactNode; value: string; title: string }) {
  return (
    <span className="flex items-center gap-1" title={title}>
      {icon}
      {value}
    </span>
  )
}
