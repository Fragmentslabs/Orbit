import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  CheckIcon,
  CheckSquareIcon,
  FileTextIcon,
  GlobeIcon,
  LoaderIcon,
  MessageSquareIcon,
  SearchIcon,
  SquareIcon,
  TerminalIcon,
  XCircleIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { OrchestrationPlan, OrchestrationTask } from "@shared/chat"
import { Shimmer } from "@/src/components/ai/shimmer"
import { formatCost, formatTokens } from "@/src/lib/format"
import { useSessionStore } from "@/src/stores/session-store"

/**
 * Card inline do plano de orquestração no chat principal: lista as tarefas
 * propostas com seus modos, permite excluir tarefas (checkbox) e aprovar ou
 * rejeitar a execução (fluxo semi-auto).
 */

function TaskModeIcon({ task }: { task: OrchestrationTask }) {
  const Icon = task.mode === "code" ? TerminalIcon : MessageSquareIcon
  return <Icon className="size-3.5 shrink-0 text-muted-foreground" />
}

function TaskChips({ task, t }: { task: OrchestrationTask; t: (key: string) => string }) {
  const chips: { icon: typeof SearchIcon; label: string }[] = []
  if (task.options.research) chips.push({ icon: SearchIcon, label: t("orchestration.researchChip") })
  if (task.options.browser) chips.push({ icon: GlobeIcon, label: t("orchestration.browserChip") })
  if (task.options.plan) chips.push({ icon: FileTextIcon, label: t("orchestration.readOnlyChip") })
  if (chips.length === 0) return null
  return (
    <span className="flex items-center gap-1.5">
      {chips.map(({ icon: Icon, label }) => (
        <span key={label} className="flex items-center gap-0.5 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
          <Icon className="size-2.5" />
          {label}
        </span>
      ))}
    </span>
  )
}

function TaskStatusIcon({ status }: { status: OrchestrationTask["status"] }) {
  switch (status) {
    case "submitted":
    case "streaming":
      return <LoaderIcon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
    case "error":
      return <XCircleIcon className="size-3.5 shrink-0 text-destructive" />
    default:
      return <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
  }
}

export function OrchestrationPlanCard({ sessionId, plan }: {
  sessionId: string
  plan: OrchestrationPlan
}) {
  const { t } = useTranslation()
  const approvePlan = useSessionStore((s) => s.approvePlan)
  const rejectPlan = useSessionStore((s) => s.rejectPlan)
  const [excluded, setExcluded] = useState<Set<string>>(new Set())

  const proposed = plan.status === "proposed"
  const running = plan.status === "approved" || plan.status === "running"
  const selectedCount = plan.tasks.length - excluded.size

  return (
    <div className="rounded-xl border-2 border-sidebar-border bg-sidebar/50 p-3 text-sm">
      <div className="mb-2 flex items-center gap-2">
        {running ? (
          <Shimmer className="font-medium">{t("orchestration.runningWorkers")}</Shimmer>
        ) : (
          <p className="font-medium">
            {proposed
              ? t("orchestration.proposedCount", { count: plan.tasks.length })
              : plan.status === "done"
                ? t("orchestration.completed")
                : t("orchestration.rejected")}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        {plan.tasks.map((task) => (
          <div
            key={task.id}
            className={cn(
              "flex items-center gap-2 rounded-md border bg-background/50 px-2 py-1.5",
              excluded.has(task.id) && "opacity-40",
            )}
          >
            {proposed ? (
              <button
                type="button"
                className="flex shrink-0 items-center text-muted-foreground hover:text-foreground"
                onClick={() =>
                  setExcluded((prev) => {
                    const next = new Set(prev)
                    if (next.has(task.id)) next.delete(task.id)
                    else next.add(task.id)
                    return next
                  })
                }
              >
                {excluded.has(task.id) ? (
                  <SquareIcon className="size-3.5" />
                ) : (
                  <CheckSquareIcon className="size-3.5" />
                )}
              </button>
            ) : (
              <TaskStatusIcon status={task.status} />
            )}
            <TaskModeIcon task={task} />
            <span className="min-w-0 flex-1 truncate text-xs" title={task.prompt}>
              {task.title}
            </span>
            <TaskChips task={task} t={t} />
          </div>
        ))}
      </div>
      {plan.usage && (plan.status === "running" || plan.status === "approved" || plan.status === "done") && (
        <p className="mt-2 text-[11px] tabular-nums text-muted-foreground">
          {t("orchestration.cost", {
            cost: plan.usage.cost !== undefined ? formatCost(plan.usage.cost) : "—",
            tokens: formatTokens(plan.usage.input + plan.usage.output),
          })}
        </p>
      )}
      {proposed && (
        <div className="mt-3 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" className="text-xs" onClick={() => rejectPlan(sessionId)}>
            {t("orchestration.reject")}
          </Button>
          <Button
            size="sm"
            className="text-xs"
            disabled={selectedCount === 0}
            onClick={() =>
              approvePlan(
                sessionId,
                plan.id,
                plan.tasks.filter((t) => !excluded.has(t.id)).map((t) => t.id),
              )
            }
          >
            {selectedCount < plan.tasks.length
              ? t("orchestration.approveRunWithCount", { count: selectedCount })
              : t("orchestration.approveRun")}
          </Button>
        </div>
      )}
    </div>
  )
}
