import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core"
import {
  ChevronDownIcon,
  FolderIcon,
  LayersIcon,
  PlusIcon,
  Settings2Icon,
  SlidersHorizontalIcon,
  SparklesIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"
import { pipelineModel, type PhaseChoice, type PhaseTemplate, type Pipeline } from "@shared/pipeline"
import { ConfirmDialog } from "@/components/ui/alert-dialog"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Hint } from "@/components/ui/hint"
import { Truncate } from "@/components/ui/truncated-text"
import { BranchSelector } from "@/src/components/branch-selector"
import { FolderSelector } from "@/src/components/folder-selector"
import { pipelineApi } from "@/src/lib/ipc"
import { usePipelineStore } from "@/src/stores/pipeline-store"
import { cn } from "@/lib/utils"
import { PipelineModelControl } from "./pipeline-model-control"
import { PhaseEditor, useModelLabel, useSavePhaseTemplate } from "./phase-editor"
import { PhaseRow } from "./pipeline-create-dialog"

type Section = "identity" | "phases" | "model" | "run"

/**
 * The pipeline's settings, in the column on the right of the list: the same shape as the
 * routine's settings tab — one closed row per group showing what is set today, and no Save
 * button. A change settles for a moment and goes to the pipeline on its own.
 *
 * Phases are the exception to "no dialog": each one is a full prompt with tools and a model,
 * so it opens in the editor it already had.
 */
export function PipelineSettingsPanel({ pipeline, onClose }: { pipeline: Pipeline; onClose: () => void }) {
  const { t } = useTranslation()
  const updatePipeline = usePipelineStore((s) => s.updatePipeline)
  const updateProject = usePipelineStore((s) => s.updateProject)
  const templates = usePipelineStore((s) => s.templates)
  const project = usePipelineStore((s) => s.projects.find((p) => p.id === pipeline.projectId))
  const savePhaseTemplate = useSavePhaseTemplate()
  const model = pipelineModel(pipeline)
  const modelLabel = useModelLabel(model?.providerId, model?.modelId, model?.reasoning)

  const [open, setOpen] = useState<Section | null>("identity")
  const [confirming, setConfirming] = useState(false)
  const remove = usePipelineStore((s) => s.removePipeline)

  const [folders, setFolders] = useState<string[]>(project?.folders ?? [])
  const [phases, setPhases] = useState<PhaseChoice[]>(() => phasesOf(pipeline, templates))
  const [commitAtEnd, setCommitAtEnd] = useState(pipeline.commitAtEnd !== false)
  const [commitPrompt, setCommitPrompt] = useState(pipeline.commitPrompt ?? "")
  const [worktreePerTask, setWorktreePerTask] = useState(!!pipeline.worktreePerTask)
  const [parallelTasks, setParallelTasks] = useState(pipeline.parallelTasks ?? 1)
  const [promptOpen, setPromptOpen] = useState(false)
  const [phaseMenuOpen, setPhaseMenuOpen] = useState(false)
  const [editing, setEditing] = useState<{ index: number | null; phase: PhaseChoice | null } | null>(null)
  // null = not checked yet. Worktrees need a git repository in the main folder.
  const [hasGit, setHasGit] = useState<boolean | null>(null)

  const first = pipeline.phases[0]
  const phasesModel = first ? { providerId: first.providerId, modelId: first.modelId } : null
  const phasesReasoning = first?.reasoning ?? null
  const mergeFlow = worktreePerTask && hasGit !== false && commitAtEnd

  useEffect(() => {
    const folder = folders[0]
    if (!folder) {
      setHasGit(null)
      return
    }
    let cancelled = false
    void pipelineApi.hasGit(folder).then((ok) => {
      if (!cancelled) setHasGit(ok)
    })
    return () => {
      cancelled = true
    }
  }, [folders])

  // Autosave: the change is written after a short pause, so typing the name does not fire an
  // update per keystroke. `saved` keeps the last written snapshot, so the echo of our own
  // update (the pipeline coming back from the main process) never saves again.
  const snapshot = JSON.stringify({ name, folders, phases, commitAtEnd, commitPrompt, worktreePerTask, parallelTasks })

  const persist = () => {
    saved.current = snapshot
    void updatePipeline(pipeline.id, {
      commitAtEnd,
      commitPrompt: commitPrompt.trim() ? commitPrompt.trim() : "",
      worktreePerTask: worktreePerTask && hasGit !== false,
      parallelTasks: mergeFlow ? parallelTasks : 1,
      phases: phases.map((phase, order) => {
        const previous = pipeline.phases[order]
        return {
          id: previous?.id ?? `phase_${order}_${Date.now().toString(36)}`,
          name: phase.name,
          description: phase.description,
          prompt: phase.prompt,
          ...(phase.noteContract ? { noteContract: phase.noteContract } : {}),
          providerId: phase.providerId && phase.modelId ? phase.providerId : (phasesModel?.providerId ?? ""),
          modelId: phase.providerId && phase.modelId ? phase.modelId : (phasesModel?.modelId ?? ""),
          thinkingLevel: previous?.thinkingLevel ?? 0,
          reasoning: phase.providerId && phase.modelId ? (phase.reasoning ?? null) : phasesReasoning,
          ...(phase.templateId ? { templateId: phase.templateId } : {}),
          tools: [...phase.tools],
          ...(phase.agent ? { agent: phase.agent } : {}),
          order,
        }
      }),
    })
    if (project) void updateProject(project.id, { folders })
  }

  const saved = useRef(snapshot)
  const latest = useRef({ snapshot, persist })
  latest.current = { snapshot, persist }

  useEffect(() => {
    if (snapshot === saved.current) return
    const timer = setTimeout(() => latest.current.persist(), 700)
    return () => clearTimeout(timer)
  }, [snapshot])

  // Closing the panel right after typing still writes the change.
  useEffect(
    () => () => {
      if (latest.current.snapshot !== saved.current) latest.current.persist()
    },
    [],
  )

  const move = (from: number, to: number) => {
    setPhases((current) => {
      if (from === to) return current
      const next = [...current]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const handleDrop = (event: DragEndEvent) => {
    const from = Number(String(event.active.id).replace("phase-", ""))
    const to = Number(String(event.over?.id ?? "").replace("target-", ""))
    if (Number.isInteger(from) && Number.isInteger(to)) move(from, to)
  }

  const savePhase = async (edited: PhaseChoice) => {
    const index = editing?.index ?? null
    setEditing(null)
    const phase = await savePhaseTemplate(edited, "pipeline")
    setPhases((current) => (index == null ? [...current, phase] : current.map((p, i) => (i === index ? phase : p))))
  }

  const label = (tpl: PhaseTemplate) =>
    tpl.i18nKey && !tpl.custom
      ? { name: t(`pipeline.phase.${tpl.i18nKey}.name`), description: t(`pipeline.phase.${tpl.i18nKey}.description`) }
      : { name: tpl.name, description: tpl.description }

  const fromTemplate = (tpl: PhaseTemplate): PhaseChoice => ({
    templateId: tpl.id,
    ...label(tpl),
    prompt: tpl.prompt,
    ...(tpl.noteContract ? { noteContract: tpl.noteContract } : {}),
    tools: [...tpl.tools],
    agent: tpl.agent,
  })

  const available = templates.filter((tpl) => !phases.some((p) => p.templateId === tpl.id))
  const toggle = (section: Section) => setOpen((current) => (current === section ? null : section))
  const folder = folders[0] ?? ""

  return (
    <aside
      aria-label={t("pipeline.settings.title")}
      className="absolute top-2 right-2 bottom-2 z-30 flex w-80 max-w-[calc(100%-1rem)] flex-col overflow-hidden rounded-lg bg-sidebar text-sidebar-foreground shadow-sm ring-1 ring-sidebar-border"
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-sidebar-border/60 px-3">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-sidebar-accent text-sidebar-accent-foreground">
          <Settings2Icon className="size-3.5" />
        </span>
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{pipeline.name}</h2>
        <button
          type="button"
          aria-label={t("common.close")}
          onClick={onClose}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
          <Disclosure
            icon={FolderIcon}
            label={t("pipeline.settings.folders")}
            value={folder ? (folder.split(/[\\/]/).filter(Boolean).pop() ?? folder) : "…"}
            open={open === "identity"}
            onToggle={() => toggle("identity")}
          >
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <FolderSelector folders={folders} onFoldersChange={setFolders} />
                {folders[0] && <BranchSelector repoPath={folders[0]} />}
              </div>
              {folders[0] && (
                <Truncate text={folders[0]}>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {t("pipeline.mainRepository")}: <span className="text-foreground">{folders[0]}</span>
                  </p>
                </Truncate>
              )}
            </div>
          </Disclosure>

          <Disclosure
            icon={LayersIcon}
            label={t("pipeline.settings.phases")}
            value={t("pipeline.settings.phasesSummary", { count: phases.length })}
            open={open === "phases"}
            onToggle={() => toggle("phases")}
          >
            <div className="space-y-1.5">
              <DndContext sensors={sensors} onDragEnd={handleDrop}>
                <div className="space-y-1">
                  {phases.map((phase, index) => (
                    <PhaseRow
                      key={`${phase.templateId ?? "custom"}-${index}`}
                      phase={phase}
                      index={index}
                      defaultModel={phasesModel}
                      defaultReasoning={phasesReasoning}
                      showDefault={false}
                      onEdit={() => setEditing({ index, phase })}
                      onRemove={() => setPhases((current) => current.filter((_, i) => i !== index))}
                    />
                  ))}
                </div>
              </DndContext>
              <DropdownMenu open={phaseMenuOpen} onOpenChange={setPhaseMenuOpen}>
                <DropdownMenuTrigger className="flex w-full items-center gap-1 rounded-md border border-dashed px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground">
                  <PlusIcon className="size-3" />
                  {t("pipeline.addPhase")}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-56">
                  {available.map((tpl) => (
                    <DropdownMenuItem key={tpl.id} onClick={() => setPhases((current) => [...current, fromTemplate(tpl)])}>
                      <div className="min-w-0 flex-1">
                        <Truncate text={label(tpl).name}>
                          <p className="truncate text-xs">{label(tpl).name}</p>
                        </Truncate>
                        <Truncate text={label(tpl).description}>
                          <p className="truncate text-[10px] text-muted-foreground">{label(tpl).description}</p>
                        </Truncate>
                      </div>
                    </DropdownMenuItem>
                  ))}
                  {available.length > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuItem onClick={() => setEditing({ index: null, phase: null })}>
                    <PlusIcon className="size-3.5" />
                    {t("pipeline.createPhase")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </Disclosure>

          <Disclosure
            icon={SparklesIcon}
            label={t("pipeline.settings.model")}
            value={modelLabel ?? "—"}
            open={open === "model"}
            onToggle={() => toggle("model")}
          >
            <PipelineModelControl pipeline={pipeline} />
          </Disclosure>

          <Disclosure
            icon={SlidersHorizontalIcon}
            label={t("pipeline.settings.run")}
            value={[
              worktreePerTask && hasGit !== false ? t("pipeline.settings.worktreeOn") : t("pipeline.settings.worktreeOff"),
              commitAtEnd ? t("pipeline.settings.commitOn") : t("pipeline.settings.commitOff"),
            ].join(" · ")}
            open={open === "run"}
            onToggle={() => toggle("run")}
          >
            <div className="space-y-3">
              <label className={cn("flex items-start gap-2", hasGit === false ? "opacity-60" : "cursor-pointer")}>
                <Switch
                  checked={worktreePerTask && hasGit !== false}
                  onCheckedChange={setWorktreePerTask}
                  disabled={hasGit === false}
                  className="mt-0.5"
                />
                <span>
                  <span className="block text-xs text-foreground">{t("pipeline.worktreePerTask")}</span>
                  <span className="block text-[11px] text-muted-foreground">{t("pipeline.worktreePerTaskHint")}</span>
                  {hasGit === false && (
                    <span className="mt-1 block text-[11px] text-amber-600 dark:text-amber-400">{t("pipeline.noGitNotice")}</span>
                  )}
                </span>
              </label>

              <div className="flex items-center gap-2">
                <Switch checked={commitAtEnd} onCheckedChange={setCommitAtEnd} />
                <span className="text-xs text-foreground">{t("pipeline.commit")}</span>
                <Hint label={t("pipeline.commitPromptTitle")}>
                  <button
                    type="button"
                    onClick={() => setPromptOpen(true)}
                    className="cursor-pointer text-muted-foreground hover:text-foreground"
                  >
                    <Settings2Icon className="size-3.5" />
                  </button>
                </Hint>
              </div>

              {mergeFlow && (
                <div className="flex items-center gap-2">
                  <select
                    value={parallelTasks}
                    onChange={(e) => setParallelTasks(Number(e.target.value))}
                    className="h-7 rounded-md border bg-background px-1.5 text-xs"
                  >
                    {[1, 2, 3, 4].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                  <span>
                    <span className="block text-xs text-foreground">{t("pipeline.parallelTasks")}</span>
                    <span className="block text-[11px] text-muted-foreground">{t("pipeline.parallelTasksHint")}</span>
                  </span>
                </div>
              )}
            </div>
          </Disclosure>

      </div>

      <footer className="flex shrink-0 flex-col gap-2 border-t border-sidebar-border/60 p-2">
        <p className="px-1 text-center text-[10px] text-muted-foreground">{t("pipeline.settings.autosave")}</p>
        <Button
          variant="outline"
          className="h-8 w-full justify-center gap-1.5 text-xs text-destructive hover:text-destructive"
          onClick={() => setConfirming(true)}
        >
          <Trash2Icon className="size-3.5" />
          {t("pipeline.list.delete")}
        </Button>
      </footer>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("pipeline.list.deleteTitle")}
        description={t("pipeline.list.deleteDescription", { name: pipeline.name })}
        confirmLabel={t("pipeline.list.delete")}
        destructive
        onConfirm={() => void remove(pipeline.id)}
      />

      <PhaseEditor
        phase={editing?.phase ?? null}
        open={!!editing}
        defaultModel={phasesModel}
        defaultReasoning={phasesReasoning}
        inheritsDefault={false}
        onOpenChange={(v) => !v && setEditing(null)}
        onSave={(phase) => void savePhase(phase)}
      />

      <Dialog open={promptOpen} onOpenChange={setPromptOpen}>
        <DialogContent className="max-w-xl">
          <DialogTitle>{t("pipeline.commitPromptTitle")}</DialogTitle>
          <p className="text-[11px] text-muted-foreground">{t("pipeline.commitPromptHint")}</p>
          <Textarea
            value={commitPrompt}
            onChange={(e) => setCommitPrompt(e.target.value)}
            rows={12}
            className="text-xs"
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">{t("pipeline.commitPromptEmpty")}</p>
            <Button onClick={() => setPromptOpen(false)}>
              {t("common.close")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </aside>
  )
}

/** One group of the settings: the closed row says what is set, the chevron opens the fields. */
function Disclosure({
  icon: Icon,
  label,
  value,
  open,
  onToggle,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div className="border-b border-sidebar-border/60 last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-sidebar-accent/40"
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs">{label}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{value}</span>
        <ChevronDownIcon
          className={cn(
            "size-3 shrink-0 text-muted-foreground/70 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && <div className="space-y-2 px-3 pb-3">{children}</div>}
    </div>
  )
}

/** The pipeline's real phases, in the shape the editor works with. */
function phasesOf(pipeline: Pipeline, templates: PhaseTemplate[]): PhaseChoice[] {
  return pipeline.phases.map((p) => ({
    templateId: p.templateId ?? templates.find((tpl) => tpl.name === p.name)?.id,
    name: p.name,
    description: p.description,
    prompt: p.prompt,
    ...(p.noteContract ? { noteContract: p.noteContract } : {}),
    tools: [...p.tools],
    agent: p.agent,
    providerId: p.providerId,
    modelId: p.modelId,
    reasoning: p.reasoning ?? null,
  }))
}
