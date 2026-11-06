import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { LayersIcon, PlusIcon } from "lucide-react"
import type { Pipeline } from "@shared/pipeline"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { formatCost } from "@/src/lib/format"
import { ListToolbar } from "@/src/components/list-toolbar"
import { StatBadges } from "@/src/components/stat-badges"
import { useStacked } from "@/src/hooks/use-stacked"
import { EMPTY_TASKS, usePipelineStore } from "@/src/stores/pipeline-store"
import { PipelineCreateDialog } from "./pipeline-create-dialog"
import { PipelineSummary, realTasks } from "./pipeline-summary"

/** Below this width of the page the summary stops sitting beside the pipelines. */
const STACK_BELOW_PX = 640
const DAY_MS = 86_400_000

/**
 * Level 1 of the pipeline page, like the Routines page: the pipelines as cards on the left, and
 * on the right what is running, what needs the user and what was finished lately, with the
 * numbers as badges at the bottom. A click on a card selects it (the summary follows it) and
 * "Open board" goes to its phases. When the page is narrow the summary goes under the list.
 */
export function PipelineList({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useTranslation()
  const pipelines = usePipelineStore((s) => s.pipelines)
  const projects = usePipelineStore((s) => s.projects)
  const tasksPerPipeline = usePipelineStore((s) => s.tasksPerPipeline)
  const [createOpen, setCreateOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const stacked = useStacked(root, STACK_BELOW_PX)

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return pipelines
    return pipelines.filter((pipeline) => {
      const project = projects.find((p) => p.id === pipeline.projectId)
      return [pipeline.name, pipeline.branch, ...pipeline.phases.map((p) => p.name), ...(project?.folders ?? [])].some((field) =>
        field?.toLowerCase().includes(q),
      )
    })
  }, [pipelines, projects, query])

  const selected = pipelines.find((p) => p.id === selectedId) ?? null
  const scope = useMemo(() => (selected ? [selected] : pipelines), [selected, pipelines])

  const stats = useMemo(() => {
    const since = Date.now() - 30 * DAY_MS
    let running = 0
    let failed = 0
    let cost = 0
    for (const pipeline of scope) {
      for (const task of realTasks(tasksPerPipeline[pipeline.id] ?? EMPTY_TASKS)) {
        if (task.status === "in_progress") running++
        if (task.status === "paused" && task.pauseReason === "error") failed++
        if (task.startedAt && Date.parse(task.startedAt) >= since) cost += task.cost
      }
    }
    return { running, failed, cost }
  }, [scope, tasksPerPipeline])

  const dialog = <PipelineCreateDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={onOpen} />

  // With no pipeline at all the screen is just the empty state with the call to create.
  if (pipelines.length === 0) {
    return (
      <div ref={setRoot} className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <LayersIcon className="size-10 text-muted-foreground/50" />
          <div>
            <p className="text-sm font-medium">{t("pipeline.emptyTitle")}</p>
            <p className="mx-auto max-w-sm text-xs text-muted-foreground">{t("pipeline.emptySubtitle")}</p>
          </div>
          <Button size="lg" onClick={() => setCreateOpen(true)}>
            <PlusIcon className="size-4" />
            {t("pipeline.createFirst")}
          </Button>
        </div>
        {dialog}
      </div>
    )
  }

  const badges = (
    <StatBadges
      separated={stacked}
      items={[
        { label: t("pipeline.stats.pipelines"), value: String(scope.length) },
        { label: t("pipeline.inProgress"), value: String(stats.running) },
        { label: t("pipeline.stats.failed"), value: String(stats.failed), tone: stats.failed > 0 ? "bad" : undefined },
        { label: t("pipeline.stats.spent"), value: formatCost(stats.cost), title: t("pipeline.stats.spentHint") },
      ]}
    />
  )

  const summary = (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5">
      <div className="flex min-h-[30px] shrink-0 items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-[13px] font-semibold">{selected ? selected.name : t("pipeline.summary.all")}</p>
        {selected && (
          <>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setSelectedId(null)}>
              {t("pipeline.summary.seeAll")}
            </Button>
            <Button size="sm" variant="outline" className="h-7 gap-1 px-2.5 text-xs" onClick={() => onOpen(selected.id)}>
              {t("pipeline.summary.openBoard")} <span aria-hidden>→</span>
            </Button>
          </>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PipelineSummary pipelines={scope} tasksPerPipeline={tasksPerPipeline} onOpen={onOpen} />
      </div>
    </div>
  )

  return (
    <div ref={setRoot} className={cn("flex min-h-0 flex-1", stacked ? "flex-col gap-3" : "gap-4")}>
      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", !stacked && "border-r pr-4")}>
        <ListToolbar
          query={query}
          onQueryChange={setQuery}
          placeholder={t("pipeline.search")}
          actionLabel={t("pipeline.newPipeline")}
          actionIcon={PlusIcon}
          onAction={() => setCreateOpen(true)}
        />
        {visible.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
            {t("pipeline.noResults", { query: query.trim() })}
          </p>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-1">
            {visible.map((pipeline) => (
              <PipelineCard
                key={pipeline.id}
                pipeline={pipeline}
                selected={pipeline.id === selectedId}
                onSelect={() => setSelectedId(pipeline.id === selectedId ? null : pipeline.id)}
              />
            ))}
          </div>
        )}
        {stacked && <div className="mt-2.5 shrink-0">{badges}</div>}
      </div>

      {stacked ? (
        <div className="max-h-[40%] shrink-0 overflow-y-auto">{summary}</div>
      ) : (
        <div className="@container flex min-h-0 w-[clamp(17rem,40%,27rem)] shrink-0 flex-col">
          {summary}
          <div className="mt-2.5 shrink-0">{badges}</div>
        </div>
      )}
      {dialog}
    </div>
  )
}

function PipelineCard({ pipeline, selected, onSelect }: { pipeline: Pipeline; selected: boolean; onSelect: () => void }) {
  const { t } = useTranslation()
  const projects = usePipelineStore((s) => s.projects)
  const tasks = realTasks(usePipelineStore((s) => s.tasksPerPipeline[pipeline.id]) ?? EMPTY_TASKS)
  const project = projects.find((p) => p.id === pipeline.projectId)

  const running = tasks.filter((x) => x.status === "in_progress").length
  const failed = tasks.filter((x) => x.status === "paused" && x.pauseReason === "error").length
  const paused = tasks.filter((x) => x.status === "paused" && x.pauseReason !== "error").length
  const completed = tasks.filter((x) => x.status === "completed").length
  const allDone = tasks.length > 0 && completed === tasks.length
  const folder = project?.folders[0]?.split(/[\\/]/).filter(Boolean).pop()

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex items-start gap-2.5 rounded-lg border bg-card px-3.5 py-3 text-left transition-colors hover:border-ring",
        selected && "border-primary/70",
      )}
    >
      <span
        className={cn(
          "mt-[7px] size-2 shrink-0 rounded-full",
          failed > 0 ? "bg-destructive" : running > 0 ? "bg-blue-400" : allDone ? "bg-emerald-500" : "bg-muted-foreground/60",
        )}
        aria-hidden
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="truncate text-sm font-medium">{pipeline.name}</span>
        <span className="truncate text-xs text-muted-foreground">{pipeline.phases.map((p) => p.name).join(" → ")}</span>
        <span className="flex flex-wrap items-center gap-1.5">
          {running > 0 && (
            <Badge tone="blue">{t("pipeline.card.running", { count: running })}</Badge>
          )}
          {failed > 0 && <Badge tone="red">{t("pipeline.card.failed", { count: failed })}</Badge>}
          {paused > 0 && <Badge tone="amber">{t("pipeline.card.paused", { count: paused })}</Badge>}
          <Badge>{t("pipeline.card.done", { done: completed, total: tasks.length })}</Badge>
          <span className="flex-1" />
          {(folder || pipeline.branch) && (
            <span className="min-w-0 truncate text-[11px] text-muted-foreground">{[folder, pipeline.branch].filter(Boolean).join(" · ")}</span>
          )}
        </span>
      </span>
    </button>
  )
}

function Badge({ tone, children }: { tone?: "blue" | "red" | "amber"; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-md px-1.5 py-px text-[10px]",
        !tone && "bg-muted text-muted-foreground",
        tone === "blue" && "bg-blue-500/15 text-blue-600 dark:text-blue-300",
        tone === "red" && "bg-destructive/10 text-destructive",
        tone === "amber" && "bg-amber-500/15 text-amber-600 dark:text-amber-400",
      )}
    >
      {children}
    </span>
  )
}
