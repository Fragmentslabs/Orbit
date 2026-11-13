import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { DndContext, PointerSensor, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core"
import { MoreHorizontalIcon, PencilIcon } from "lucide-react"
import type { PhaseChoice, PhaseConfig, Pipeline, Task } from "@shared/pipeline"
import { isTaskSatisfied } from "@shared/pipeline"
import { EMPTY_TASKS, usePipelineStore } from "@/src/stores/pipeline-store"
import { cn } from "@/lib/utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { PipelineList } from "./pipeline-list"
import { PipelineSettingsPanel } from "./pipeline-settings-panel"
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
  const setSettingsOpen = usePipelineStore((s) => s.setSettingsOpen)

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
    <PipelineBoardView pipeline={open} />
  ) : (
    <PipelineList
      onOpen={setOpenPipelineId}
      onSettings={(id) => {
        setOpenPipelineId(id)
        setSettingsOpen(true)
      }}
    />
  )
}

// ─── Level 2: pipeline board ─────────────────────────────────────────────────

function PipelineBoardView({ pipeline }: { pipeline: Pipeline }) {
  const { t } = useTranslation()
  const startTask = usePipelineStore((s) => s.startTask)
  const createTaskInStore = usePipelineStore((s) => s.createTask)
  const settingsOpen = usePipelineStore((s) => s.settingsOpen)
  const setSettingsOpen = usePipelineStore((s) => s.setSettingsOpen)
  const allTasks = usePipelineStore((s) => s.tasksPerPipeline[pipeline.id] ?? EMPTY_TASKS)
  // Delivered tasks left the board for the history panel.
  const tasks = useMemo(() => allTasks.filter((x) => !x.deliveryId), [allTasks])
  const [historyOpen, setHistoryOpen] = useState(false)
  const planOpen = usePipelineStore((s) => s.planOpen)
  const setPlanOpen = usePipelineStore((s) => s.setPlanOpen)
  const queueEnabled = usePipelineStore((s) => s.queueEnabled[pipeline.id] ?? false)
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const [createTaskOpen, setCreateTaskOpen] = useState(false)
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
            ...(currentPhase.noteContract ? { noteContract: currentPhase.noteContract } : {}),
            tools: [...currentPhase.tools],
            agent: currentPhase.agent,
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
              ...(phase.noteContract ? { noteContract: phase.noteContract } : {}),
              tools: [...phase.tools],
              // Written even when absent: choosing General clears the specialist.
              agent: phase.agent,
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
    <div className="relative flex min-h-0 flex-1 flex-col">
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

      <TaskPlanDialog
        pipeline={pipeline}
        open={planOpen}
        onOpenChange={setPlanOpen}
        onManual={() => setCreateTaskOpen(true)}
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

      {settingsOpen && (
        <PipelineSettingsPanel pipeline={pipeline} onClose={() => setSettingsOpen(false)} />
      )}
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
