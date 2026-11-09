import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { CheckIcon, TerminalIcon, XCircleIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Truncate } from "@/components/ui/truncated-text"
import { agentView } from "@/src/components/agent-meta"
import type { TaskItem } from "@/src/components/task-progress"
import { workerActivity } from "@/src/lib/worker-activity"
import { useAgentsStore } from "@/src/stores/agents-store"
import { useSessionStore } from "@/src/stores/session-store"

/**
 * One worker in the orchestra's strip: its agent's icon, its name, and the line of what it is
 * doing right now (read from its own chat), with the outcome on the right. Clicking opens the
 * worker's conversation. A worker that waits keeps its icon, muted, and says what it waits for.
 */
export function WorkerRow({ task, live }: { task: TaskItem; live: boolean }) {
  const { t } = useTranslation()
  const agents = useAgentsStore((s) => s.agents)
  const messages = useSessionStore((s) => (task.sessionId ? s.messages[task.sessionId] : undefined))
  const activity = useMemo(() => workerActivity(messages), [messages])

  const view = task.agent ? agentView(task.agent, agents, t) : null
  const Icon = view?.icon ?? TerminalIcon
  const done = task.phase ? task.phase === "accepted" : task.status === "idle"
  const failed = task.phase ? task.phase === "failed" : task.status === "error"
  const waiting = task.phase === "queued"
  const working = live && !done && !failed && !waiting

  const line = waiting
    ? task.waitsFor?.length
      ? t("taskProgress.waitsFor", { tasks: task.waitsFor.join(", ") })
      : t("taskProgress.phase.queue")
    : working
      ? activity.text || t("taskProgress.working")
      : activity.text || task.note || ""

  const open = () => {
    if (task.sessionId) void useSessionStore.getState().selectSession("code", task.sessionId)
  }

  return (
    <button
      type="button"
      onClick={open}
      disabled={!task.sessionId}
      title={task.note ?? t("taskProgress.openWorker")}
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent/40 disabled:cursor-default disabled:hover:bg-transparent"
    >
      <Icon className={cn("size-3.5 shrink-0", failed ? "text-destructive" : waiting || !live && !done ? "text-muted-foreground/60" : (view?.color ?? "text-muted-foreground"))} />
      <Truncate text={task.title}>
        <span className={cn("w-32 shrink-0 truncate font-medium", waiting && "text-muted-foreground")}>{task.title}</span>
      </Truncate>
      {task.extra && <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">{t("taskProgress.extra")}</span>}
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-muted-foreground",
          working && activity.kind === "thinking" && "italic",
          working && activity.kind !== "thinking" && "text-foreground/80",
        )}
      >
        {line}
      </span>
      {/* The outcome, or the step the follow-up is in (review, adjustment). */}
      {task.phase === "adjustment" && <span className="shrink-0 text-[10px] text-muted-foreground">{t("taskProgress.phase.adjustment", { n: task.revisions ?? 1 })}</span>}
      {task.phase === "review" && <span className="shrink-0 text-[10px] text-muted-foreground">{t("taskProgress.phase.review")}</span>}
      {task.phase === "running" && !live && <span className="shrink-0 text-[10px] text-muted-foreground">{t("taskProgress.phase.stopped")}</span>}
      {failed && <XCircleIcon className="size-3.5 shrink-0 text-destructive" />}
      {done && <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />}
    </button>
  )
}
