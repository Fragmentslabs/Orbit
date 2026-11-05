import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { AlertTriangleIcon, CheckIcon, CornerUpLeftIcon, FileDiffIcon, FolderOpenIcon, GitBranchIcon, Loader2Icon, MessageSquarePlusIcon, MessageSquareQuoteIcon, MessagesSquareIcon, PauseIcon, PlayIcon, PlusIcon, RotateCcwIcon, Trash2Icon, XIcon } from "lucide-react"
import type { Pipeline, Task } from "@shared/pipeline"
import { instructionsForRound, isTaskSatisfied, notesForRound, returnForRound, taskRound } from "@shared/pipeline"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Hint } from "@/components/ui/hint"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ConfirmDialog } from "@/components/ui/alert-dialog"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { AssistantMarkdown, GenericToolView, ReasoningPartView } from "@/src/components/messages/shared"
import { Shimmer } from "@/src/components/ai/shimmer"
import { BrowserTestChip } from "@/src/components/browser-test-chip"
import { MediaEmbed, extractMediaUrls } from "./media-embed"
import { SearchableTaskList } from "./task-picker"
import { ReturnTaskDialog } from "./return-task-dialog"
import { ResumeInstructionDialog } from "./resume-instruction-dialog"
import { EMPTY_TASKS, usePipelineStore } from "@/src/stores/pipeline-store"
import { pipelineApi } from "@/src/lib/ipc"
import { usePanelStore } from "@/src/stores/panel-store"
import { useSessionStore } from "@/src/stores/session-store"
import { useDraftInput } from "@/src/stores/draft-input"
import { useWorkspace } from "@/lib/workspace-context"
import { cn } from "@/lib/utils"
import { formatCost, formatDuration } from "./task-card"
import { Truncate } from "@/components/ui/truncated-text"

/**
 * Task modal (§13): editable title, phase tabs with the note in markdown, a
 * right-hand column with telemetry and dependencies, and the error banner when
 * the task paused because of a failure.
 */
export function TaskModal({
  task,
  pipeline,
  open,
  onOpenChange,
}: {
  task: Task | null
  pipeline: Pipeline
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t, i18n } = useTranslation()
  const updateTask = usePipelineStore((s) => s.updateTask)
  const removeTask = usePipelineStore((s) => s.removeTask)
  const startTask = usePipelineStore((s) => s.startTask)
  const pauseTask = usePipelineStore((s) => s.pauseTask)
  const resumeTask = usePipelineStore((s) => s.resumeTask)
  const tasks = usePipelineStore((s) => s.tasksPerPipeline[pipeline.id] ?? EMPTY_TASKS)
  const projectFolders = usePipelineStore((s) => s.projects.find((p) => p.id === pipeline.projectId)?.folders)
  const { setMode, setView, setFolders } = useWorkspace()
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [activePhase, setActivePhase] = useState(0)
  const [addingDependency, setAddingDependency] = useState(false)
  const [dependencyError, setDependencyError] = useState<string | null>(null)
  const [confirmingRemoval, setConfirmingRemoval] = useState(false)
  const [returning, setReturning] = useState(false)
  const [instructing, setInstructing] = useState(false)
  const currentRound = task ? taskRound(task) : 1
  // Round shown in the phase tabs: the current one by default; the previous ones
  // are one click away, with the comment that opened each of them.
  const [viewedRound, setViewedRound] = useState(1)
  useEffect(() => {
    setViewedRound(currentRound)
  }, [task?.id, currentRound])

  useEffect(() => {
    if (!task) return
    setTitle(task.title)
    setDescription(task.description)
    setActivePhase(task.currentPhase ?? 0)
    // Seeds the form when the task changes, not on every mutation of the object
    // — otherwise a store update would wipe what is being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id])

  const noteByPhase = useMemo(() => {
    const map = new Map<string, Task["notes"][number]>()
    if (task) for (const note of notesForRound(task, viewedRound)) map.set(note.phaseId, note)
    return map
  }, [task, viewedRound])

  // +/- of the patch, as in the chat message footer
  const diffLines = useMemo(() => {
    let added = 0
    let removed = 0
    for (const line of (task?.diff?.patch ?? "").split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) added++
      else if (line.startsWith("-") && !line.startsWith("---")) removed++
    }
    return { added, removed }
  }, [task?.diff?.patch])

  if (!task) return null

  const hasError = task.pauseReason === "error"
  // Delivered: part of the history, read-only (Reopen starts a follow-up task).
  const archived = !!task.deliveryId
  const integration = task.integration
  const onCurrentRound = viewedRound === currentRound
  const viewedReturn = returnForRound(task, viewedRound)
  const dependencies = task.dependsOn
    .map((id) => tasks.find((t) => t.id === id))
    .filter((t): t is Task => !!t)
  const candidates = tasks.filter((t) => t.id !== task.id && !task.dependsOn.includes(t.id))

  const saveField = (patch: Partial<Task>) => {
    void updateTask(pipeline.id, task.id, patch)
  }

  const changeDependencies = async (next: string[]) => {
    setDependencyError(null)
    try {
      await updateTask(pipeline.id, task.id, { dependsOn: next })
    } catch (err) {
      // Cycles are validated in the main process — the message comes from there
      setDependencyError(err instanceof Error ? err.message : String(err))
    }
  }

  // New chat in the task's worktree (or the project folder without one), with the
  // question typed and NOT sent: the person edits it and sends. The chat reads the
  // task through the pipeline_task_read tool, so nothing else needs to be injected.
  const openInChat = async () => {
    const folders = task.worktree?.folder
      ? [task.worktree.folder, ...(projectFolders ?? []).slice(1)]
      : (projectFolders ?? [])
    const directory = folders[0]
    if (!directory) return
    const session = await useSessionStore.getState().createSession("code", { directory, setActive: true })
    useDraftInput.getState().setDraft(
      session.id,
      t("pipeline.openInChatPrompt", {
        number: task.number !== undefined ? `#${task.number}` : task.id,
        title: task.title,
        pipeline: pipeline.name,
      }),
    )
    setMode("code")
    setView("chat")
    setFolders(folders)
    onOpenChange(false)
  }

  const removeImage = (url: string) => {
    if (window.confirm(t("pipeline.removeImageConfirm"))) void pipelineApi.removeTaskImage(pipeline.id, task.id, url)
  }

  const reopen = async () => {
    await pipelineApi.reopenTask(pipeline.id, task.id)
    onOpenChange(false)
  }

  const shortDate = (iso?: string) =>
    iso ? new Date(iso).toLocaleString(i18n.language, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Same height as the settings dialog (600px), clamped to the screen. In
          flex (not grid): in DialogContent's grid the implicit rows stretch and
          the space does not go to whoever needs it. */}
      <DialogContent className="flex h-[600px] max-h-[90vh] max-w-4xl flex-col gap-0 p-0">
        <DialogTitle className="sr-only">{task.title}</DialogTitle>

        {hasError && (
          <div className="flex items-start gap-2 rounded-t-lg border-b border-destructive/30 bg-destructive/10 px-4 py-2.5">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-destructive">{t("pipeline.pausedByError")}</p>
              <p className="mt-0.5 text-[11px] text-destructive/90">{task.error}</p>
            </div>
            <button
              type="button"
              onClick={() => setInstructing(true)}
              className="shrink-0 rounded-md border border-destructive/40 px-3 py-1.5 text-[11px] font-medium text-destructive hover:bg-destructive/10"
            >
              {t("pipeline.resumeWithInstruction")}
            </button>
            <button
              type="button"
              onClick={() => void resumeTask(pipeline.id, task.id)}
              className="shrink-0 rounded-md bg-destructive px-3 py-1.5 text-[11px] font-medium text-destructive-foreground hover:bg-destructive/90"
            >
              {t("pipeline.resume")}
            </button>
          </div>
        )}

        {archived && (
          <div className="flex items-start gap-2 rounded-t-lg border-b bg-muted/40 px-4 py-2.5">
            <CheckIcon className="mt-0.5 size-4 shrink-0 text-emerald-500" />
            <p className="min-w-0 flex-1 text-[11px] text-muted-foreground">{t("pipeline.archivedNotice")}</p>
            <button
              type="button"
              onClick={() => void reopen()}
              className="shrink-0 rounded-md border px-3 py-1.5 text-[11px] font-medium hover:bg-accent"
            >
              {t("pipeline.reopen")}
            </button>
          </div>
        )}

        {!archived && integration && integration.state !== "integrated" && (
          <div
            className={cn(
              "flex items-start gap-2 rounded-t-lg border-b px-4 py-2.5",
              integration.state === "failed" ? "border-destructive/30 bg-destructive/10" : "bg-muted/40",
            )}
          >
            {integration.state === "failed" ? (
              <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            ) : (
              <Loader2Icon className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
            )}
            <div className="min-w-0 flex-1">
              <p className={cn("text-xs font-medium", integration.state === "failed" && "text-destructive")}>
                {t(`pipeline.integration.${integration.state}`)}
              </p>
              {integration.waitingFor && integration.waitingFor.length > 0 ? (
                <p className="mt-0.5 break-all text-[11px] text-muted-foreground">
                  {t("pipeline.integration.waitingFor", { files: integration.waitingFor.join(", ") })}
                </p>
              ) : integration.detail ? (
                <p className="mt-0.5 break-words text-[11px] text-muted-foreground">{integration.detail}</p>
              ) : null}
            </div>
            {integration.state === "failed" && (
              <button
                type="button"
                onClick={() => void pipelineApi.retryIntegration(pipeline.id, task.id)}
                className="flex shrink-0 items-center gap-1 rounded-md border border-destructive/40 px-3 py-1.5 text-[11px] font-medium text-destructive hover:bg-destructive/10"
              >
                <RotateCcwIcon className="size-3" />
                {t("pipeline.integration.retry")}
              </button>
            )}
          </div>
        )}

        {task.commitError && (
          <div className="flex items-start gap-2 rounded-t-lg border-b border-yellow-500/30 bg-yellow-500/10 px-4 py-2.5">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-yellow-600 dark:text-yellow-400" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-yellow-700 dark:text-yellow-300">{t("pipeline.commitFailed")}</p>
              <p className="mt-0.5 break-all text-[11px] text-yellow-700/80 dark:text-yellow-300/80">{task.commitError}</p>
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 px-4 pt-4">
          {task.number !== undefined && (
            <span className="shrink-0 font-mono text-sm text-muted-foreground">#{task.number}</span>
          )}
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title !== task.title && saveField({ title })}
            readOnly={archived}
            className="h-8 flex-1 border-0 bg-transparent px-1.5 text-base font-semibold shadow-none focus-visible:ring-0"
          />
          <Hint label={t("pipeline.openInChat")}>
            <button
              type="button"
              aria-label={t("pipeline.openInChat")}
              onClick={() => void openInChat()}
              className="flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-ring hover:text-foreground"
            >
              <MessagesSquareIcon className="size-3.5" />
              {t("pipeline.openInChat")}
            </button>
          </Hint>
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            {t(`pipeline.status.${task.status}`)}
          </span>
        </div>

        {/* Changed files: measured by the engine (snapshot), not reported by the
            agent. A click opens the diff in the panel, just like the chat. */}
        {(task.diff?.files.length ?? 0) > 0 && (
          <button
            type="button"
            onClick={() => {
              usePanelStore.getState().openTaskDiff(pipeline.id, task.id, task.title)
              onOpenChange(false)
            }}
            className="mx-4 mt-2 flex w-fit items-center gap-2 rounded-md border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-ring hover:text-foreground"
          >
            <FileDiffIcon className="size-3.5" />
            {t("pipeline.changedFiles", { count: task.diff!.files.length })}
            {diffLines.added > 0 && <span className="text-emerald-500">+{diffLines.added}</span>}
            {diffLines.removed > 0 && <span className="text-red-500">-{diffLines.removed}</span>}
          </button>
        )}

        {/* The task's isolated worktree: branch and shortcut to the folder (it
            lives in userData, outside the project — without the shortcut it would
            be hard to find). */}
        {task.worktree && (
          <div className="mx-4 mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span className="flex min-w-0 items-center gap-1.5" title={t("pipeline.worktreeBase", { base: task.worktree.base })}>
              <GitBranchIcon className="size-3.5 shrink-0" />
              <Truncate text={task.worktree.branch}>
                <span className="truncate font-mono text-foreground">{task.worktree.branch}</span>
              </Truncate>
            </span>
            <button
              type="button"
              onClick={() => void window.ipcRenderer.invoke("shell:showItemInFolder", task.worktree!.folder)}
              className="flex items-center gap-1 rounded-md border px-2 py-0.5 transition-colors hover:border-ring hover:text-foreground"
            >
              <FolderOpenIcon className="size-3" />
              {t("pipeline.openWorktree")}
            </button>
            {task.worktree.dependencies === "linked" && (
              <span className="text-yellow-600 dark:text-yellow-400">{t("pipeline.linkedDependencies")}</span>
            )}
          </div>
        )}

        <div className="flex min-h-0 flex-1 gap-4 px-4 pb-4 pt-3">
          {/* Left: description + phase tabs */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
            {/* Height split 1:2 between the description and the phase area (the
                model's notes, which tend to be much longer). */}
            <div className="flex min-h-28 flex-[1] flex-col">
              <p className="mb-1 shrink-0 text-[11px] font-medium text-muted-foreground">{t("pipeline.description")}</p>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onBlur={() => description !== task.description && saveField({ description })}
                readOnly={archived}
                className="min-h-0 w-full flex-1 resize-none rounded-md border bg-transparent px-2 py-1.5 text-xs outline-none focus-visible:border-ring"
              />
              {/* orbit-media:// URLs pasted into the description become images
                  (the text remains the source of truth for the phases). Height
                  limited so the images do not push the phase area. */}
              <div className="max-h-28 shrink-0 overflow-y-auto">
                <MediaEmbed text={description} onRemove={removeImage} />
              </div>
            </div>

            {/* Rounds: only show up after the first return. Each one shows the
                comment that opened it and its notes. */}
            {currentRound > 1 && (
              <div className="shrink-0 space-y-2">
                <div className="flex flex-wrap items-center gap-1">
                  {Array.from({ length: currentRound }, (_, i) => i + 1).map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setViewedRound(n)}
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                        viewedRound === n
                          ? "border-primary/40 bg-primary/10 text-primary"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground",
                      )}
                    >
                      {t("pipeline.round", { round: n })}
                    </button>
                  ))}
                </div>
                {viewedReturn && (
                  <div className="rounded-md border border-violet-500/30 bg-violet-500/5 px-2.5 py-2">
                    <p className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-violet-600 dark:text-violet-400">
                      <MessageSquareQuoteIcon className="size-3.5" />
                      {t("pipeline.reviewComment")}
                      <span className="font-normal text-muted-foreground">· {shortDate(viewedReturn.createdAt)}</span>
                    </p>
                    <p className="max-h-20 overflow-y-auto whitespace-pre-wrap break-words text-xs text-foreground">{viewedReturn.text}</p>
                  </div>
                )}
              </div>
            )}

            <div className="flex shrink-0 gap-1 overflow-x-auto border-b">
              {pipeline.phases.map((phase, index) => {
                const note = noteByPhase.get(phase.id)
                const running = onCurrentRound && task.status === "in_progress" && task.currentPhase === index
                return (
                  <button
                    key={phase.id}
                    type="button"
                    onClick={() => setActivePhase(index)}
                    className={cn(
                      "flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-1.5 text-xs transition-colors",
                      activePhase === index
                        ? "border-primary text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {phase.name}
                    {note?.status === "ok" && <CheckIcon className="size-3 text-emerald-500" />}
                    {note?.status === "error" && <AlertTriangleIcon className="size-3 text-destructive" />}
                    {note?.status === "skipped" && <span className="text-[10px] opacity-60">↷</span>}
                    {running && <span className="size-1.5 animate-pulse rounded-full bg-primary" />}
                  </button>
                )
              })}
            </div>

            {/* Scroll like the sidebar's (ScrollArea): the bar disappears when
                idle and only shows on scroll/hover, in place of the native scrollbar. */}
            <ScrollArea className="min-h-40 flex-[2] rounded-md border">
              <div className="p-3 [&_li]:break-words [&_p]:break-words">
                {(() => {
                  const phase = pipeline.phases[activePhase]
                  const note = phase ? noteByPhase.get(phase.id) : undefined
                  // Instructions given when resuming this phase in this round:
                  // they sit on top, before the run/note they guided.
                  const instructions = phase
                    ? instructionsForRound(task, viewedRound).filter((i) => i.phaseId === phase.id)
                    : []
                  const instructionBlock = instructions.length > 0 && (
                    <div className="mb-3 space-y-1.5">
                      {instructions.map((instruction, i) => (
                        <div key={i} className="rounded-md border border-sky-500/30 bg-sky-500/5 px-2.5 py-2">
                          <p className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-sky-600 dark:text-sky-400">
                            <MessageSquarePlusIcon className="size-3.5" />
                            {t("pipeline.resumeInstruction")}
                            <span className="font-normal text-muted-foreground">· {shortDate(instruction.createdAt)}</span>
                          </p>
                          <p className="whitespace-pre-wrap break-words text-xs text-foreground">{instruction.text}</p>
                        </div>
                      ))}
                    </div>
                  )
                  // Phase running: shows the agent live (thinking, tools, browser)
                  // instead of the placeholder.
                  const running = phase && onCurrentRound && task.status === "in_progress" && task.currentPhase === activePhase
                  if (running) {
                    return (
                      <>
                        {instructionBlock}
                        <LiveRun taskId={task.id} phaseIndex={activePhase} />
                      </>
                    )
                  }
                  if (!note) {
                    // Round that restarted on a later phase: the previous ones did
                    // not run in it (their work belongs to the previous round).
                    const didNotRun = viewedReturn && activePhase < viewedReturn.startPhase
                    return (
                      <>
                        {instructionBlock}
                        <p className="text-xs text-muted-foreground">
                          {didNotRun ? t("pipeline.didNotRunInRound") : t("pipeline.noNote")}
                        </p>
                      </>
                    )
                  }
                  return (
                    <>
                      {instructionBlock}
                      <AssistantMarkdown>{note.content}</AssistantMarkdown>
                      <NoteImages text={note.content} onRemove={removeImage} />
                      {note.controlledCommands.length > 0 && (
                        <div className="mt-3 rounded-md bg-muted/50 p-2">
                          <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            {t("pipeline.controlledCommands")}
                          </p>
                          <ul className="space-y-0.5">
                            {note.controlledCommands.map((cmd, i) => (
                              <li key={i} className="font-mono text-[10px] text-muted-foreground">{cmd}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </>
                  )
                })()}
              </div>
            </ScrollArea>
          </div>

          {/* Right: telemetry + dependencies */}
          <div className="w-56 shrink-0 space-y-3 overflow-y-auto text-[11px]">
            <dl className="space-y-1.5">
              <InfoLine label={t("pipeline.createdAt")} value={shortDate(task.createdAt)} />
              <InfoLine label={t("pipeline.completedAt")} value={shortDate(task.completedAt)} />
              <InfoLine label={t("pipeline.workTime")} value={formatDuration(task.workTimeMs)} />
              <InfoLine label={t("pipeline.tokens")} value={task.tokens.toLocaleString()} />
              <InfoLine label={t("pipeline.cost")} value={formatCost(task.cost)} />
            </dl>

            <div className="border-t pt-2">
              <p className="mb-1.5 font-medium text-muted-foreground">{t("pipeline.dependenciesTitle")}</p>
              {/* The notice used to vanish while the picker was open, because it
                  replaced the button. Now the picker is a separate popover, so
                  the notice only depends on whether there are dependencies. */}
              {dependencies.length === 0 && (
                <p className="text-muted-foreground/70">{t("pipeline.noDependencies")}</p>
              )}
              <ul className="space-y-1">
                {dependencies.map((dep) => (
                  <li key={dep.id} className="flex items-center gap-1.5">
                    <span className={cn("size-1.5 shrink-0 rounded-full", isTaskSatisfied(dep) ? "bg-emerald-500" : "bg-amber-500")} />
                    <Truncate text={dep.title}>
                      <span className="min-w-0 flex-1 truncate">{dep.title}</span>
                    </Truncate>
                    <Hint label={t("common.remove")}>
                      <button
                        type="button"
                        onClick={() => void changeDependencies(task.dependsOn.filter((id) => id !== dep.id))}
                        className="shrink-0 cursor-pointer text-muted-foreground hover:text-destructive"
                      >
                        <XIcon className="size-3" />
                      </button>
                    </Hint>
                  </li>
                ))}
              </ul>
              {candidates.length > 0 && (
                <Popover open={addingDependency} onOpenChange={setAddingDependency}>
                  <PopoverTrigger
                    render={
                      <button
                        type="button"
                        className="mt-1.5 flex items-center gap-1 text-muted-foreground hover:text-foreground"
                      >
                        <PlusIcon className="size-3" />
                        {t("pipeline.addDependency")}
                      </button>
                    }
                  />
                  {/* Fixed width: the popup inherits the anchor's width, and the
                      trigger here is a text button too short to fit the list. */}
                  <PopoverContent className="w-64 p-0" align="start">
                    <SearchableTaskList
                      tasks={candidates}
                      onPick={(id) => {
                        void changeDependencies([...task.dependsOn, id])
                        setAddingDependency(false)
                      }}
                    />
                  </PopoverContent>
                </Popover>
              )}
              {dependencyError && <p className="mt-1 text-[10px] text-destructive">{dependencyError}</p>}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 border-t px-4 py-2.5">
          {archived ? (
            <ActionButton icon={<RotateCcwIcon className="size-3.5" />} label={t("pipeline.reopen")} onClick={() => void reopen()} />
          ) : task.status === "in_progress" ? (
            <ActionButton icon={<PauseIcon className="size-3.5" />} label={t("pipeline.pause")} onClick={() => void pauseTask(pipeline.id, task.id)} />
          ) : task.status !== "completed" ? (
            <>
            <ActionButton
              icon={<PlayIcon className="size-3.5" />}
              label={task.status === "paused" ? t("pipeline.resume") : t("pipeline.start")}
              onClick={() =>
                task.status === "paused"
                  ? void resumeTask(pipeline.id, task.id)
                  : void startTask(pipeline.id, task.id)
              }
            />
            {task.status === "paused" && (
              <ActionButton
                icon={<MessageSquarePlusIcon className="size-3.5" />}
                label={t("pipeline.resumeWithInstruction")}
                onClick={() => setInstructing(true)}
              />
            )}
            </>
          ) : integration?.state === "integrating" ? null : (
            <ActionButton
              icon={<CornerUpLeftIcon className="size-3.5" />}
              label={t("pipeline.return")}
              onClick={() => setReturning(true)}
            />
          )}
          {!archived && (
            <button
              type="button"
              onClick={() => setConfirmingRemoval(true)}
              className="ml-auto flex items-center gap-1 rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2Icon className="size-3.5" />
              {t("pipeline.deleteTask")}
            </button>
          )}
        </div>

        <ReturnTaskDialog task={task} pipeline={pipeline} open={returning} onOpenChange={setReturning} />
        <ResumeInstructionDialog task={task} pipeline={pipeline} open={instructing} onOpenChange={setInstructing} />

        <ConfirmDialog
          open={confirmingRemoval}
          onOpenChange={setConfirmingRemoval}
          title={t("pipeline.confirmTaskDeletion", { title: task.title })}
          description={task.worktree ? t("pipeline.taskDeletionDescriptionWorktree", { branch: task.worktree.branch }) : t("pipeline.taskDeletionDescription")}
          confirmLabel={t("pipeline.deleteTask")}
          destructive
          onConfirm={() => {
            void removeTask(pipeline.id, task.id)
            onOpenChange(false)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

/**
 * Live run of the phase (modal): status chips (Running + the agent's browser),
 * streaming thinking (reasoning) and the tool calls — the same visual vocabulary
 * as the conversation. When it finishes the task updates and the modal goes back
 * to showing the note (final answer).
 */
function LiveRun({ taskId, phaseIndex }: { taskId: string; phaseIndex: number }) {
  const { t } = useTranslation()
  const activity = usePipelineStore((s) => s.activity[taskId])
  const current = activity && activity.phaseIndex === phaseIndex ? activity : null

  const empty = !current || (current.thinking.length === 0 && current.tools.length === 0)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 self-start rounded-full border border-primary/30 bg-background/90 px-2.5 py-1 text-[11px] font-medium text-primary shadow-sm">
          <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
          <Shimmer>{t("pipeline.running")}</Shimmer>
        </span>
        <BrowserTestChip sessionId={`pipeline_${taskId}`} />
      </div>

      {empty && <p className="text-xs text-muted-foreground">{t("pipeline.starting")}</p>}

      {current && current.thinking.length > 0 && (
        <ReasoningPartView
          part={{ id: "thinking", type: "reasoning", text: current.thinking, state: "streaming" }}
        />
      )}

      {current?.tools.map((entry) => (
        <GenericToolView
          key={entry.toolCallId}
          part={{
            id: entry.toolCallId,
            type: "tool",
            tool: entry.tool,
            state:
              entry.state === "running"
                ? "running"
                : entry.state === "error"
                  ? "error"
                  : "done",
            error: entry.detail,
          }}
          label={entry.tool}
          subtitle={entry.summary || undefined}
        />
      ))}
    </div>
  )
}

/** Small thumbnails of the images stored with a note, each with a delete button. */
function NoteImages({ text, onRemove }: { text: string; onRemove: (url: string) => void }) {
  const { t } = useTranslation()
  const urls = useMemo(() => extractMediaUrls(text), [text])
  if (urls.length === 0) return null
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-2">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{t("pipeline.images")}</span>
      {urls.map((url) => (
        <span key={url} className="group relative">
          <img src={url} alt="" className="size-10 rounded border object-cover" />
          <Hint label={t("pipeline.removeImage")}>
            <button
              type="button"
              onClick={() => onRemove(url)}
              className="absolute -right-1 -top-1 hidden size-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground group-hover:flex"
            >
              <XIcon className="size-2.5" />
            </button>
          </Hint>
        </span>
      ))}
    </div>
  )
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground">{value}</dd>
    </div>
  )
}

function ActionButton({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs hover:bg-accent"
    >
      {icon}
      {label}
    </button>
  )
}
