import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Ellipsis, InfoIcon, LayersIcon, Loader2, PencilIcon, PlusIcon, SearchIcon, Trash2Icon } from "lucide-react"
import type { Pipeline } from "@shared/pipeline"
import { ConfirmDialog } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { formatCost } from "@/src/lib/format"
import { useStacked } from "@/src/hooks/use-stacked"
import { EMPTY_TASKS, usePipelineStore } from "@/src/stores/pipeline-store"
import { PhaseLibrary } from "./phase-library"
import { PipelineCreateDialog } from "./pipeline-create-dialog"
import { PipelineSummary, realTasks } from "./pipeline-summary"

/** Below this width of the page the summary stops sitting beside the pipelines. */
const STACK_BELOW_PX = 640
const DAY_MS = 86_400_000

/**
 * Level 1 of the pipeline page: two tabs — the pipelines and the phase library. The tabs are the
 * page's own; everything below them belongs to the open one.
 */
export function PipelineList(props: {
  onOpen: (id: string) => void
  /** Opens the pipeline with its settings column shown (the row menu's Edit). */
  onSettings: (id: string) => void
}) {
  const { t } = useTranslation()
  const pipelines = usePipelineStore((s) => s.pipelines)
  const templates = usePipelineStore((s) => s.templates)
  const [tab, setTab] = useState<"pipelines" | "phases">("pipelines")

  const tabs = [
    { id: "pipelines" as const, label: t("pipeline.tabPipelines"), count: pipelines.length },
    { id: "phases" as const, label: t("pipeline.tabPhases"), count: templates.length },
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setTab(entry.id)}
            className={cn(
              "relative flex h-full items-center gap-1.5 px-2.5 text-xs font-medium transition-colors",
              tab === entry.id
                ? "text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-[2px] after:rounded-full after:bg-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {entry.label}
            <span className="rounded-full bg-muted px-1.5 py-px text-[9.5px] font-normal text-muted-foreground">
              {entry.count}
            </span>
          </button>
        ))}
      </div>
      {tab === "pipelines" ? <PipelinesTab {...props} /> : <PhaseLibrary />}
    </div>
  )
}

/**
 * The pipelines: the search row with the call to create, the counts line, the rows — the state
 * tile, the name, the phases, the tasks and the state pill — and the quiet foot line. On the right
 * the summary, with the numbers as cards on top and the running/attention/done lists under them.
 * A click on a row opens its board (the phases); on a narrow page the summary goes below the rows.
 */
function PipelinesTab({
  onOpen,
  onSettings,
}: {
  onOpen: (id: string) => void
  /** Opens the pipeline with its settings column shown (the row menu's Edit). */
  onSettings: (id: string) => void
}) {
  const { t } = useTranslation()
  const pipelines = usePipelineStore((s) => s.pipelines)
  const projects = usePipelineStore((s) => s.projects)
  const tasksPerPipeline = usePipelineStore((s) => s.tasksPerPipeline)
  const [createOpen, setCreateOpen] = useState(false)
  const [query, setQuery] = useState("")
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

  const stats = useMemo(() => {
    const since = Date.now() - 30 * DAY_MS
    let tasks = 0
    let running = 0
    let failed = 0
    let cost = 0
    for (const pipeline of pipelines) {
      for (const task of realTasks(tasksPerPipeline[pipeline.id] ?? EMPTY_TASKS)) {
        tasks++
        if (task.status === "in_progress") running++
        if (task.status === "paused" && task.pauseReason === "error") failed++
        if (task.startedAt && Date.parse(task.startedAt) >= since) cost += task.cost
      }
    }
    return { tasks, running, failed, cost }
  }, [pipelines, tasksPerPipeline])

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

  const counts = [
    t("pipeline.list.count", { count: pipelines.length }),
    ...(stats.running > 0 ? [t("pipeline.list.running", { count: stats.running })] : []),
    ...(stats.failed > 0 ? [t("pipeline.list.failed", { count: stats.failed })] : []),
  ].join(" · ")

  return (
    <div ref={setRoot} className={cn("flex min-h-0 flex-1", stacked && "flex-col")}>
      {/* The pipelines: search and create, the counts, the rows and the foot line. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border bg-card px-2.5 py-1.5 text-muted-foreground focus-within:ring-1 focus-within:ring-ring">
            <SearchIcon className="size-3.5 shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("pipeline.search")}
              className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
          <Button onClick={() => setCreateOpen(true)}>
            <PlusIcon className="size-3.5" />
            {t("pipeline.newPipeline")}
          </Button>
        </div>

        <p className="shrink-0 px-3.5 pb-1 pt-2.5 text-[10px] text-muted-foreground/70">{counts}</p>

        {visible.length === 0 ? (
          // The message takes the whole free height: without flex-1 the foot line of the page
          // rises up to right below it when the search finds nothing.
          <div className="flex min-h-0 flex-1 flex-col p-3">
            <p className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
              {t("pipeline.noResults", { query: query.trim() })}
            </p>
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-2">
            {visible.map((pipeline) => (
              <PipelineRow key={pipeline.id} pipeline={pipeline} onOpen={() => onOpen(pipeline.id)} onEdit={() => onSettings(pipeline.id)} />
            ))}
          </div>
        )}

        <p className="flex shrink-0 items-center gap-1.5 border-t px-3.5 py-2.5 text-[10px] text-muted-foreground/60">
          <InfoIcon className="size-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{t("pipeline.list.tail")}</span>
          <span className="shrink-0" title={t("pipeline.stats.spentHint")}>
            {t("pipeline.stats.spentFooter", { cost: formatCost(stats.cost) })}
          </span>
        </p>
      </div>

      {/* The summary: the numbers on top, then what is running, what needs the user and what was
          finished. On a narrow page it goes below the rows. */}
      <aside
          className={cn(
            "flex min-h-0 flex-col",
            stacked ? "max-h-[45%] shrink-0 border-t px-3 pt-3" : "w-60 shrink-0 border-l px-3",
          )}
        >
        <div className="shrink-0 pb-3 pt-3">
          <div className="grid grid-cols-2 gap-1.5">
            <Stat label={t("pipeline.stats.pipelines")} value={String(pipelines.length)} />
            <Stat label={t("pipeline.stats.tasks")} value={String(stats.tasks)} />
            <Stat label={t("pipeline.inProgress")} value={String(stats.running)} />
            <Stat label={t("pipeline.stats.failed")} value={String(stats.failed)} bad={stats.failed > 0} />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          <PipelineSummary pipelines={pipelines} tasksPerPipeline={tasksPerPipeline} onOpen={onOpen} />
        </div>
        </aside>
      {dialog}
    </div>
  )
}

function Stat({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className="min-w-0 rounded-[9px] border bg-card px-2 py-1.5">
      <div className="truncate text-[9px] leading-tight text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 text-[13px] font-semibold leading-tight", bad && "text-destructive")}>{value}</div>
    </div>
  )
}

function PipelineRow({ pipeline, onOpen, onEdit }: { pipeline: Pipeline; onOpen: () => void; onEdit: () => void }) {
  const { t } = useTranslation()
  const remove = usePipelineStore((s) => s.removePipeline)
  const [menuOpen, setMenuOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const projects = usePipelineStore((s) => s.projects)
  const tasks = realTasks(usePipelineStore((s) => s.tasksPerPipeline[pipeline.id]) ?? EMPTY_TASKS)
  const project = projects.find((p) => p.id === pipeline.projectId)

  const running = tasks.filter((x) => x.status === "in_progress").length
  const failed = tasks.filter((x) => x.status === "paused" && x.pauseReason === "error").length
  const paused = tasks.filter((x) => x.status === "paused" && x.pauseReason !== "error").length
  const completed = tasks.filter((x) => x.status === "completed").length
  const allDone = tasks.length > 0 && completed === tasks.length
  const folder = project?.folders[0]?.split(/[\\/]/).filter(Boolean).pop()
  const state = failed > 0 ? "failed" : running > 0 ? "running" : allDone ? "done" : paused > 0 ? "paused" : "idle"

  return (
    <div className="group relative flex items-center gap-3 rounded-[10px] border border-transparent px-3 py-[11px] transition-colors hover:bg-accent">
      <span
        className={cn(
          "grid size-[31px] shrink-0 place-items-center rounded-[9px]",
          state === "running" && "bg-blue-500/13 text-blue-500",
          state === "failed" && "bg-destructive/13 text-destructive",
          state === "done" && "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
          (state === "paused" || state === "idle") && "bg-muted/60 text-muted-foreground",
        )}
      >
        {state === "running" ? <Loader2 className="size-3.5 animate-spin" /> : <LayersIcon className="size-3.5" />}
      </span>

      <div className="flex min-w-0 flex-1 flex-col">
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 truncate text-left text-[12.5px] font-semibold after:absolute after:inset-0 after:content-['']"
        >
          {pipeline.name}
        </button>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10.5px] text-muted-foreground">
          <span className="truncate">{pipeline.phases.map((p) => p.name).join(" → ")}</span>
          {folder && (
            <>
              <span className="shrink-0 text-muted-foreground/40">·</span>
              <span className="truncate">{folder}</span>
            </>
          )}
        </div>
      </div>

      <div className="hidden shrink-0 text-right sm:block">
        <div className="text-[9px] uppercase tracking-[0.07em] text-muted-foreground/60">{t("pipeline.list.tasks")}</div>
        <div className="mt-0.5 whitespace-nowrap text-[10.5px] tabular-nums text-muted-foreground">
          {completed}/{tasks.length}
        </div>
      </div>

      <span
        className={cn(
          "inline-flex min-w-[66px] shrink-0 items-center justify-center rounded-full border px-1.5 py-0.5 text-[9.5px]",
          state === "running" && "border-blue-500/30 text-blue-500",
          state === "failed" && "border-destructive/30 text-destructive",
          state === "done" && "border-emerald-500/30 text-emerald-600 dark:text-emerald-400",
          (state === "paused" || state === "idle") && "border-border text-muted-foreground/60",
        )}
      >
        {state === "running"
          ? t("pipeline.list.running", { count: running })
          : state === "failed"
            ? t("pipeline.list.failed", { count: failed })
            : state === "done"
              ? t("pipeline.list.done")
              : state === "paused"
                ? t("pipeline.card.paused", { count: paused })
                : t("pipeline.list.idle")}
      </span>

      {/* The options: it grows from nothing and pushes the row left, like the routine row. */}
      <span
        className={cn(
          "relative z-10 flex items-center overflow-hidden transition-all duration-200 focus-within:w-6 focus-within:opacity-100",
          menuOpen ? "w-6 opacity-100" : "w-0 opacity-0 group-hover:w-6 group-hover:opacity-100",
        )}
      >
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger
            aria-label={t("pipeline.list.options")}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Ellipsis className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem onClick={onEdit}>
              <PencilIcon className="size-3.5" />
              {t("pipeline.list.edit")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
              <Trash2Icon className="size-3.5" />
              {t("pipeline.list.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t("pipeline.list.deleteTitle")}
        description={t("pipeline.list.deleteDescription", { name: pipeline.name })}
        confirmLabel={t("pipeline.list.delete")}
        destructive
        onConfirm={() => void remove(pipeline.id)}
      />
    </div>
  )
}
