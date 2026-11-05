import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { DndContext, PointerSensor, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core"
import { ArrowLeftIcon, FolderIcon, LayersIcon, Loader2, MoreHorizontalIcon, PencilIcon, PlayIcon, PlusIcon, SparklesIcon, SquareIcon, Trash2Icon } from "lucide-react"
import type { PhaseChoice, PhaseConfig, Pipeline, Task } from "@shared/pipeline"
import { isTaskSatisfied } from "@shared/pipeline"
import { Button } from "@/components/ui/button"
import { EMPTY_TASKS, usePipelineStore } from "@/src/stores/pipeline-store"
import { cn } from "@/lib/utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { PipelineCreateDialog } from "./pipeline-create-dialog"
import { PhaseEditor, useModelLabel, useSavePhaseTemplate, type PhaseDestination } from "./phase-editor"
import { ReturnTaskDialog } from "./return-task-dialog"
import { ResumeInstructionDialog } from "./resume-instruction-dialog"
import { TaskCreateDialog } from "./task-create-dialog"
import { TaskPlanDialog } from "./task-plan-dialog"
import { PipelineFooter } from "./pipeline-footer"
import { IntegrationBar } from "./integration-bar"
import { HistoryPanel } from "./history-panel"
import { TaskCard } from "./task-card"
import { TaskModal } from "./task-modal"
import { Hint } from "@/components/ui/hint"
import { Truncate } from "@/components/ui/truncated-text"

/**
 * Pipeline page (code mode, in the sidebar). Two levels:
 *
 *   pipeline list  →  [open]  →  pipeline board (columns per phase)
 *
 * It is not a mode of the input: the pipeline is another way of working — a
 * task pipeline without a chat — so it navigates as a page, not as a
 * conversation toggle.
 */
export function PipelineBoard() {
  const { t } = useTranslation()
  const loaded = usePipelineStore((s) => s.loaded)
  const load = usePipelineStore((s) => s.load)
  const openPipelineId = usePipelineStore((s) => s.openPipelineId)
  const setOpenPipelineId = usePipelineStore((s) => s.setOpenPipeline)

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  // The engine event subscription is GLOBAL (main.tsx): pipeline and routines
  // keep mirroring the main process even with the view closed (changes coming
  // from another window or from the mobile app cannot be lost).

  const pipelines = usePipelineStore((s) => s.pipelines)
  const open = pipelines.find((p) => p.id === openPipelineId) ?? null

  // Pipeline removed (from here or from another window): go back to the list
  // instead of leaving the screen stuck on a board that no longer exists.
  useEffect(() => {
    if (openPipelineId && !open) setOpenPipelineId(null)
  }, [openPipelineId, open, setOpenPipelineId])

  if (!loaded) {
    return <p className="p-6 text-center text-xs text-muted-foreground">{t("pipeline.loading")}</p>
  }

  return open ? (
    <PipelineBoardView pipeline={open} onBack={() => setOpenPipelineId(null)} />
  ) : (
    <PipelineList onOpen={setOpenPipelineId} />
  )
}

// ─── Level 1: pipeline list ──────────────────────────────────────────────────

function PipelineList({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useTranslation()
  const pipelines = usePipelineStore((s) => s.pipelines)
  const projects = usePipelineStore((s) => s.projects)
  const tasksPerPipeline = usePipelineStore((s) => s.tasksPerPipeline)
  const [createOpen, setCreateOpen] = useState(false)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 pb-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-foreground">{t("pipeline.title")}</h2>
          <p className="text-xs text-muted-foreground">{t("pipeline.subtitle")}</p>
        </div>
        <Button size="lg" onClick={() => setCreateOpen(true)}>
          <PlusIcon className="size-4" />
          {t("pipeline.newPipeline")}
        </Button>
      </div>

      {pipelines.length === 0 ? (
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
      ) : (
        <div className="grid min-h-0 flex-1 auto-rows-min gap-2 overflow-y-auto sm:grid-cols-2 xl:grid-cols-3">
          {pipelines.map((pipeline) => {
            const tasks = (tasksPerPipeline[pipeline.id] ?? []).filter((x) => !x.deliveryId)
            const project = projects.find((p) => p.id === pipeline.projectId)
            const inProgress = tasks.filter((t) => t.status === "in_progress").length
            const completed = tasks.filter((t) => t.status === "completed").length
            const failed = tasks.some((t) => t.pauseReason === "error")
            return (
              <button
                key={pipeline.id}
                type="button"
                onClick={() => onOpen(pipeline.id)}
                className="flex flex-col gap-2 rounded-lg border bg-card p-3 text-left transition-colors hover:border-ring"
              >
                <div className="flex items-center gap-2">
                  <LayersIcon className="size-4 shrink-0 text-muted-foreground" />
                  
                    <Truncate>
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{pipeline.name}</span>
                    </Truncate>
                  {inProgress > 0 && (
                    <span title={t("pipeline.inProgress")}>
                      <Loader2 className="size-3 shrink-0 animate-spin text-primary" />
                    </span>
                  )}
                  {completed > 0 && (
                    <span
                      className="size-1.5 shrink-0 rounded-full bg-yellow-500"
                      title={t("pipeline.tasksSummary", { total: tasks.length, completed })}
                    />
                  )}
                  {failed && (
                    <span
                      className="size-1.5 shrink-0 rounded-full bg-destructive"
                      title={t("pipeline.error")}
                    />
                  )}
                </div>
                
                  <Truncate>
                      <p className="truncate text-[11px] text-muted-foreground">
                      {pipeline.phases.map((p) => p.name).join(" → ")}
                    </p>
                  </Truncate>
                {project && project.folders.length > 0 && (
                  
                    <Truncate>
                      <p className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
                      <FolderIcon className="size-3 shrink-0" />
                      {project.folders[0]}
                      {project.folders.length > 1 && ` +${project.folders.length - 1}`}
                    </p>
                    </Truncate>
                )}
                <div className="mt-auto flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span>{t("pipeline.tasksSummary", { total: tasks.length, completed })}</span>
                  {pipeline.branch && 
                    <Truncate>
                        <span className="truncate">· {pipeline.branch}</span>
                    </Truncate>}
                </div>
              </button>
            )
          })}
        </div>
      )}

      <PipelineCreateDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={onOpen} />
    </div>
  )
}

// ─── Level 2: pipeline board ─────────────────────────────────────────────────

function PipelineBoardView({ pipeline, onBack }: { pipeline: Pipeline; onBack: () => void }) {
  const { t } = useTranslation()
  const startTask = usePipelineStore((s) => s.startTask)
  const createTaskInStore = usePipelineStore((s) => s.createTask)
  const removePipeline = usePipelineStore((s) => s.removePipeline)
  const toggleQueue = usePipelineStore((s) => s.toggleQueue)
  const allTasks = usePipelineStore((s) => s.tasksPerPipeline[pipeline.id] ?? EMPTY_TASKS)
  // Delivered tasks left the board for the history panel.
  const tasks = useMemo(() => allTasks.filter((x) => !x.deliveryId), [allTasks])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [planOpen, setPlanOpen] = useState(false)
  const queueEnabled = usePipelineStore((s) => s.queueEnabled[pipeline.id] ?? false)
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const [createTaskOpen, setCreateTaskOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [editingPhase, setEditingPhase] = useState<number | null>(null)
  const [returning, setReturning] = useState<string | null>(null)
  const [instructing, setInstructing] = useState<string | null>(null)
  const updatePipeline = usePipelineStore((s) => s.updatePipeline)
  const savePhaseTemplate = useSavePhaseTemplate()

  // The board's phase becomes a PhaseChoice for the editor (the same one as in
  // the modal), already carrying the model and reasoning it uses.
  const currentPhase: PhaseConfig | undefined = editingPhase == null ? undefined : pipeline.phases[editingPhase]
  const phaseForEditor = useMemo<PhaseChoice | null>(
    () =>
      currentPhase
        ? {
            templateId: currentPhase.templateId,
            name: currentPhase.name,
            description: currentPhase.description,
            prompt: currentPhase.prompt,
            tools: [...currentPhase.tools],
            kind: currentPhase.kind ?? "generic",
            providerId: currentPhase.providerId,
            modelId: currentPhase.modelId,
            reasoning: currentPhase.reasoning ?? null,
          }
        : null,
    [currentPhase],
  )

  const saveBoardPhase = async (edited: PhaseChoice, destination: PhaseDestination) => {
    const index = editingPhase
    if (index == null) return
    const phase = await savePhaseTemplate(edited, destination)
    await updatePipeline(pipeline.id, {
      phases: pipeline.phases.map((p, i) =>
        i === index
          ? {
              ...p,
              name: phase.name,
              description: phase.description,
              prompt: phase.prompt,
              tools: [...phase.tools],
              kind: phase.kind,
              providerId: phase.providerId ?? p.providerId,
              modelId: phase.modelId ?? p.modelId,
              reasoning: phase.reasoning !== undefined ? phase.reasoning : (p.reasoning ?? null),
              ...(phase.templateId ? { templateId: phase.templateId } : {}),
            }
          : p,
      ),
    })
  }

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const handleDrop = useCallback(
    (event: DragEndEvent) => {
      const task = event.active.data.current?.task as Task | undefined
      const target = String(event.over?.id ?? "")
      if (!task || !target.startsWith("phase:")) return
      const index = Number(target.slice("phase:".length))
      if (!Number.isInteger(index) || index < 0 || index >= pipeline.phases.length) return
      // Dropping on the phase the task is already in and running has no effect
      if (task.status === "in_progress" && task.currentPhase === index) return
      void startTask(pipeline.id, task.id, index)
    },
    [pipeline, startTask],
  )


  // "Next in the queue": the first pending task without pending dependencies
  // (FIFO by creation, the same rule as the engine). Only meaningful with the
  // queue on.
  const nextId = queueEnabled
    ? tasks
        .filter(
          (x) => x.status === "pending" && x.dependsOn.every((id) => allTasks.some((t) => t.id === id && isTaskSatisfied(t))),
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]?.id
    : undefined

  // Title of the dependency that blocks the task (shown on the card, with a tooltip).
  const waitingTitle = (task: Task): string | undefined => {
    for (const id of task.dependsOn) {
      const dep = tasks.find((t) => t.id === id)
      if (dep && !isTaskSatisfied(dep)) return dep.title
    }
    return undefined
  }

  const columns = useMemo(
    () => [
      { id: "pending", title: t("pipeline.pendingPlural"), tasks: tasks.filter((x) => x.status === "pending") },
      ...pipeline.phases.map((phase, index) => ({
        id: `phase:${index}`,
        title: phase.name,
        phaseIndex: index as number | undefined,
        tasks: tasks.filter(
          (x) => x.status !== "pending" && x.status !== "completed" && x.currentPhase === index,
        ),
      })),
      { id: "completed", title: t("pipeline.completedPlural"), tasks: tasks.filter((x) => x.status === "completed") },
    ],
    [pipeline.phases, tasks, t],
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Pipeline header: back + name + controls */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 pb-3">
        <Hint label={t("pipeline.back")}>
          <button
            type="button"
            onClick={onBack}
            className="flex size-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ArrowLeftIcon className="size-4" />
          </button>
        </Hint>
        <div className="min-w-0">
          <Truncate>
              <h2 className="truncate text-sm font-semibold text-foreground">{pipeline.name}</h2>
          </Truncate>
          <Truncate>
            <p className="truncate text-[11px] text-muted-foreground">
            {pipeline.phases.map((p) => p.name).join(" → ")}
            {pipeline.branch && ` · ${pipeline.branch}`}
          </p>
          </Truncate>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Hint label={t("pipeline.plan.hint")}>
            <Button size="lg" variant="outline" onClick={() => setPlanOpen(true)}>
              <SparklesIcon className="size-4" />
              {t("pipeline.plan.button")}
            </Button>
          </Hint>
          <Button size="lg" onClick={() => setCreateTaskOpen(true)}>
            <PlusIcon className="size-4" />
            {t("pipeline.addTask")}
          </Button>
          <Hint label={t("pipeline.queueHint")}>
            <button
              type="button"
              onClick={() => void toggleQueue(pipeline.id, !queueEnabled)}
              className={cn(
                "flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors",
                queueEnabled ? "border-primary/50 bg-primary/10 text-primary" : "hover:bg-accent",
              )}
            >
       
               {queueEnabled ? <SquareIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
            {queueEnabled ? t("pipeline.queueOn") : t("pipeline.queueOff")}
          </button>
          </Hint>
          <DropdownMenu>
            <DropdownMenuTrigger className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
              <MoreHorizontalIcon className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-40">
              <DropdownMenuItem onClick={() => setEditOpen(true)}>
                <PencilIcon className="size-3.5" />
                {t("pipeline.editPipeline")}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => {
                  if (confirm(t("pipeline.confirmRemoval", { name: pipeline.name }))) {
                    void removePipeline(pipeline.id)
                    onBack()
                  }
                }}
              >
                <Trash2Icon className="size-3.5" />
                {t("pipeline.removePipeline")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <IntegrationBar pipeline={pipeline} tasks={allTasks} onOpenHistory={() => setHistoryOpen(true)} />

      <DndContext sensors={sensors} onDragEnd={handleDrop}>
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
          {columns.map((column) => (
            <Column
              key={column.id}
              id={column.id}
              title={column.title}
              phase={"phaseIndex" in column && column.phaseIndex != null ? pipeline.phases[column.phaseIndex] : undefined}
              onEditPhase={"phaseIndex" in column && column.phaseIndex != null ? () => setEditingPhase(column.phaseIndex!) : undefined}
              tasks={column.tasks}
              pipeline={pipeline}
              nextId={nextId}
              waitingTitle={waitingTitle}
              onOpen={setOpenTaskId}
              onReturn={setReturning}
              onResumeWithInstruction={setInstructing}
            />
          ))}
        </div>
      </DndContext>

      <PipelineFooter pipeline={pipeline} tasks={tasks} />

      <TaskCreateDialog
        open={createTaskOpen}
        onOpenChange={setCreateTaskOpen}
        tasks={tasks}
        onCreate={({ title, description, dependsOn }) =>
          createTaskInStore(pipeline.id, title, description, dependsOn).then(() => undefined)
        }
      />

      <TaskPlanDialog pipeline={pipeline} open={planOpen} onOpenChange={setPlanOpen} />

      <PipelineCreateDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        editing={pipeline}
      />

      <PhaseEditor
        phase={phaseForEditor}
        open={editingPhase != null && !!phaseForEditor}
        defaultModel={currentPhase ? { providerId: currentPhase.providerId, modelId: currentPhase.modelId } : null}
        defaultReasoning={currentPhase?.reasoning ?? null}
        onOpenChange={(v) => !v && setEditingPhase(null)}
        onSave={(phase, destination) => void saveBoardPhase(phase, destination)}
      />

      <ReturnTaskDialog
        task={tasks.find((x) => x.id === returning) ?? null}
        pipeline={pipeline}
        open={!!returning}
        onOpenChange={(v) => !v && setReturning(null)}
      />

      <ResumeInstructionDialog
        task={tasks.find((x) => x.id === instructing) ?? null}
        pipeline={pipeline}
        open={!!instructing}
        onOpenChange={(v) => !v && setInstructing(null)}
      />

      <HistoryPanel
        pipeline={pipeline}
        tasks={allTasks}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        onOpenTask={setOpenTaskId}
      />

      <TaskModal
        pipeline={pipeline}
        task={allTasks.find((x) => x.id === openTaskId) ?? null}
        open={!!openTaskId}
        onOpenChange={(open) => !open && setOpenTaskId(null)}
      />
    </div>
  )
}

function Column({
  id,
  title,
  phase,
  onEditPhase,
  tasks,
  pipeline,
  nextId,
  waitingTitle,
  onOpen,
  onReturn,
  onResumeWithInstruction,
}: {
  id: string
  title: string
  /** Only on phase columns: the phase (to show the model under the title) */
  phase?: PhaseConfig
  /** Only on phase columns: opens the phase editor (name, prompt, model…) */
  onEditPhase?: () => void
  tasks: Task[]
  pipeline: Pipeline
  /** Id of the task the queue will fire (only the pending column uses it). */
  nextId?: string
  /** Title of the dependency that blocks each pending task. */
  waitingTitle: (task: Task) => string | undefined
  onOpen: (taskId: string) => void
  onReturn: (taskId: string) => void
  onResumeWithInstruction: (taskId: string) => void
}) {
  const { t } = useTranslation()
  const modelLabel = useModelLabel(phase?.providerId, phase?.modelId, phase?.reasoning)
  const startTask = usePipelineStore((s) => s.startTask)
  const pauseTask = usePipelineStore((s) => s.pauseTask)
  const resumeTask = usePipelineStore((s) => s.resumeTask)
  const progress = usePipelineStore((s) => s.progress)
  const { setNodeRef, isOver } = useDroppable({ id })
  const acceptsDrop = id.startsWith("phase:")

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex w-60 shrink-0 flex-col rounded-lg border bg-muted/20 transition-colors",
        isOver && acceptsDrop && "border-primary bg-primary/5",
      )}
    >
      <div className="flex shrink-0 items-center gap-1.5 px-2.5 py-2">
        <div className="min-w-0 flex-1">
          <Truncate text={title}>
            <p className="truncate text-xs font-medium text-foreground">{title}</p>
          </Truncate>
          {modelLabel && (
            <Truncate text={modelLabel}>
              <p className="truncate text-[10px] text-muted-foreground" >
                {modelLabel}
              </p>
            </Truncate>
          )}
        </div>
        <span className="rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">{tasks.length}</span>
        {onEditPhase && (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={t("pipeline.phaseOptions")}
              className="-mr-1 flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <MoreHorizontalIcon className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-36">
              <DropdownMenuItem onClick={onEditPhase}>
                <PencilIcon className="size-3.5" />
                {t("pipeline.editPhase")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-1.5 pb-2">
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            pipeline={pipeline}
            progress={progress[task.id]}
            waitingTitle={waitingTitle(task)}
            isNext={nextId === task.id}
            onOpen={() => onOpen(task.id)}
            onStart={() => void startTask(pipeline.id, task.id)}
            onPause={() => void pauseTask(pipeline.id, task.id)}
            onResume={() => void resumeTask(pipeline.id, task.id)}
            onReturn={() => onReturn(task.id)}
            onResumeWithInstruction={() => onResumeWithInstruction(task.id)}
          />
        ))}
      </div>
    </div>
  )
}
