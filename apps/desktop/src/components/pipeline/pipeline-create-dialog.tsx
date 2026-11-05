import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core"
import { GripVerticalIcon, PencilIcon, PlusIcon, Settings2Icon, XIcon } from "lucide-react"
import type { ReasoningConfig } from "@shared/chat"
import type { PhaseChoice, PhaseTemplate, Pipeline } from "@shared/pipeline"
import { PIPELINE_COMMIT_PROMPT_DEFAULT } from "@shared/pipeline"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { ConfirmDialog } from "@/components/ui/alert-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { FolderSelector } from "@/src/components/folder-selector"
import { BranchSelector } from "@/src/components/branch-selector"
import { ModelPicker } from "@/src/components/model-picker"
import { ThinkingMenu } from "@/src/components/thinking-menu"
import { usePipelineStore } from "@/src/stores/pipeline-store"
import { pipelineApi } from "@/src/lib/ipc"
import { useReasoningPrefsStore } from "@/src/stores/reasoning-prefs"
import { useSessionModel, useSessionModelPrefs } from "@/src/stores/session-model-prefs"
import { cn } from "@/lib/utils"
import { PhaseEditor, useModelLabel, useSavePhaseTemplate, type PhaseDestination } from "./phase-editor"
import { Hint } from "@/components/ui/hint"
import { Truncate } from "@/components/ui/truncated-text"

/**
 * "New Pipeline" dialog (§3).
 *
 * Model key of its own: the input's ModelPicker stores the choice per session,
 * so the pipeline uses a synthetic key — that way the picker is literally the
 * same component as the chat's, without switching the model of any conversation.
 */
const MODEL_KEY = "pipeline:new"

/** Reasoning level the user already uses with the model (the same as in the chat). */
function savedLevel(providerId: string, modelId: string): ReasoningConfig | null {
  const pref = useReasoningPrefsStore.getState().prefs[`${providerId}/${modelId}`]
  return pref?.enabled ? { enabled: true, variantId: pref.variantId } : null
}

export function PipelineCreateDialog({
  open,
  onOpenChange,
  projectId,
  onCreated,
  editing: pipelineBeingEdited,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Existing project; absent = the project is created together with the pipeline */
  projectId?: string
  /** Opens the freshly created pipeline straight on the board */
  onCreated?: (pipelineId: string) => void
  /** Existing pipeline — the same dialog becomes an edit */
  editing?: Pipeline | null
}) {
  const { t } = useTranslation()
  const createProject = usePipelineStore((s) => s.createProject)
  const createPipeline = usePipelineStore((s) => s.createPipeline)
  const removeTemplate = usePipelineStore((s) => s.removeTemplate)
  const templates = usePipelineStore((s) => s.templates)
  const savePhaseTemplate = useSavePhaseTemplate()
  const model = useSessionModel(MODEL_KEY)
  const modelKey = model ? `${model.providerId}/${model.modelId}` : null

  const [name, setName] = useState("")
  const [folders, setFolders] = useState<string[]>([])
  const [phases, setPhases] = useState<PhaseChoice[]>([])
  const [commitAtEnd, setCommitAtEnd] = useState(true)
  const [commitPrompt, setCommitPrompt] = useState("")
  const [promptOpen, setPromptOpen] = useState(false)
  const [worktreePerTask, setWorktreePerTask] = useState(true)
  const [parallelTasks, setParallelTasks] = useState(1)
  // null = not checked yet. Worktrees need a git repository in the main folder.
  const [hasGit, setHasGit] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState<{ index: number | null; phase: PhaseChoice | null } | null>(null)
  const [defaultReasoning, setDefaultReasoning] = useState<ReasoningConfig | null>(null)
  // Last default model seen: when it changes, the default reasoning restarts.
  const [alignedModel, setAlignedModel] = useState<string | null>(null)
  const [phaseMenuOpen, setPhaseMenuOpen] = useState(false)
  const [deleting, setDeleting] = useState<PhaseTemplate | null>(null)

  const updatePipeline = usePipelineStore((s) => s.updatePipeline)
  const updateProject = usePipelineStore((s) => s.updateProject)
  const editingPipeline = pipelineBeingEdited ?? null
  const targetProject = editingPipeline?.projectId ?? projectId
  const existingProject = usePipelineStore((s) => s.projects.find((p) => p.id === targetProject))

  // Built-in phases have translated name/description (the prompt stays in
  // English, like the rest of the app's prompts). The user's use what they wrote.
  // The label family comes from `kind`: `i18nKey` is the persisted template id,
  // which only says the phase is a built-in one.
  const label = (tpl: PhaseTemplate) =>
    tpl.i18nKey && !tpl.custom
      ? {
          name: t(`pipeline.phase.${tpl.kind}.name`),
          description: t(`pipeline.phase.${tpl.kind}.description`),
        }
      : { name: tpl.name, description: tpl.description }

  const fromTemplate = (tpl: PhaseTemplate): PhaseChoice => ({
    templateId: tpl.id,
    ...label(tpl),
    prompt: tpl.prompt,
    tools: [...tpl.tools],
    kind: tpl.kind,
  })

  // Initial state on every open: only the default phases come in; the rest stay
  // behind the "+" so the dialog does not open on a wall of options.
  // Once per open: saving/deleting a template changes `templates` with the
  // dialog open, and re-seeding would wipe what the user already chose. It only
  // waits for the templates to arrive (async load) before considering itself seeded.
  const seeded = useRef(false)
  useEffect(() => {
    if (!open) {
      seeded.current = false
      return
    }
    if (seeded.current) return
    seeded.current = !!editingPipeline || templates.length > 0
    setFolders(existingProject?.folders ?? [])
    if (editingPipeline) {
      setName(editingPipeline.name)
      setCommitAtEnd(editingPipeline.commitAtEnd !== false)
      setCommitPrompt(editingPipeline.commitPrompt ?? "")
      setWorktreePerTask(!!editingPipeline.worktreePerTask)
      setParallelTasks(editingPipeline.parallelTasks ?? 1)
      // Editing starts from the pipeline's REAL phases (they are already copies,
      // D4), not from the templates: the user may have edited them only for this
      // pipeline. Each one carries the model and reasoning it already has.
      setPhases(
        editingPipeline.phases.map((p) => ({
          templateId: p.templateId ?? templates.find((tpl) => tpl.name === p.name)?.id,
          name: p.name,
          description: p.description,
          prompt: p.prompt,
          tools: [...p.tools],
          kind: p.kind ?? "generic",
          providerId: p.providerId,
          modelId: p.modelId,
          reasoning: p.reasoning ?? null,
        })),
      )
      return
    }
    setAlignedModel(modelKey)
    setDefaultReasoning(model ? savedLevel(model.providerId, model.modelId) : null)
    setName("")
    setCommitAtEnd(true)
    setCommitPrompt("")
    setWorktreePerTask(true)
    setParallelTasks(1)
    setPhases(templates.filter((tpl) => tpl.isDefault).map(fromTemplate))
    // The reset is triggered by the dialog OPENING; fromTemplate is a helper
    // recreated on every render and as a dep would clear the form by itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, templates, existingProject, editingPipeline])

  // Default model change (creation only): the reasoning starts from the level
  // the user already uses with that model. Phases with a model of their own do
  // not change. It only reacts to the model (not to opening): on the opening
  // commit the state is still the previous session's.
  useEffect(() => {
    if (!open || editingPipeline || !model || modelKey === alignedModel) return
    setAlignedModel(modelKey)
    setDefaultReasoning(savedLevel(model.providerId, model.modelId))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelKey])

  // What a phase without a model of its own uses. On creation, the "Default
  // model"; on edit (where it is not shown — each phase already has its own),
  // the first phase's, for whoever comes in through "Add phase".
  const first = editingPipeline?.phases[0]
  const phasesModel = editingPipeline
    ? first
      ? { providerId: first.providerId, modelId: first.modelId }
      : null
    : (model ?? null)
  const phasesReasoning = editingPipeline ? (first?.reasoning ?? null) : defaultReasoning

  const available = templates.filter(
    (tpl) => !phases.some((p) => p.templateId === tpl.id),
  )

  const move = useCallback((from: number, to: number) => {
    setPhases((current) => {
      if (from === to || from < 0 || to < 0 || from >= current.length || to >= current.length) return current
      const next = [...current]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }, [])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const handleDrop = (event: DragEndEvent) => {
    const from = Number(String(event.active.id).replace("phase-", ""))
    const to = Number(String(event.over?.id ?? "").replace("target-", ""))
    if (Number.isInteger(from) && Number.isInteger(to)) move(from, to)
  }

  const savePhase = async (edited: PhaseChoice, destination: PhaseDestination) => {
    const index = editing?.index ?? null
    setEditing(null)
    const phase = await savePhaseTemplate(edited, destination)
    setPhases((current) => (index == null ? [...current, phase] : current.map((p, i) => (i === index ? phase : p))))
  }

  // The folder is mandatory: without a main repository there is nowhere for the
  // pipeline to work, and the task would only fail on the first phase.
  const canCreate = name.trim().length > 0 && phases.length > 0 && !!phasesModel && folders.length > 0

  // Push depends on the final commit: turning the commit off turns the push off
  // with it — a push without the complete state committed would upload
  // Which flow the switches add up to (see pipelineFlow in @shared/pipeline).
  const mergeFlow = worktreePerTask && hasGit !== false && commitAtEnd

  // Worktrees need git: look at the main folder whenever it changes.
  useEffect(() => {
    const folder = folders[0]
    if (!open || !folder) {
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
  }, [open, folders])

  const create = async () => {
    if (!canCreate || saving || !phasesModel) return
    setSaving(true)
    try {
      if (editingPipeline) {
        // Editing does not recreate the pipeline: it keeps the id, the tasks and
        // the history. Each phase uses its own model when it has one; otherwise
        // the "Default model".
        await updatePipeline(editingPipeline.id, {
          name: name.trim(),
          commitAtEnd,
          ...(commitPrompt.trim() ? { commitPrompt: commitPrompt.trim() } : { commitPrompt: "" }),
          worktreePerTask: worktreePerTask && hasGit !== false,
          parallelTasks: mergeFlow ? parallelTasks : 1,
          phases: phases.map((phase, order) => {
            const previous = editingPipeline.phases[order]
            return {
              id: previous?.id ?? `phase_${order}_${Date.now().toString(36)}`,
              name: phase.name,
              description: phase.description,
              prompt: phase.prompt,
              providerId: phase.providerId && phase.modelId ? phase.providerId : phasesModel.providerId,
              modelId: phase.providerId && phase.modelId ? phase.modelId : phasesModel.modelId,
              thinkingLevel: previous?.thinkingLevel ?? 0,
              reasoning: phase.providerId && phase.modelId ? (phase.reasoning ?? null) : phasesReasoning,
              ...(phase.templateId ? { templateId: phase.templateId } : {}),
              tools: [...phase.tools],
              kind: phase.kind,
              order,
            }
          }),
        })
        if (targetProject) await updateProject(targetProject, { folders })
        onOpenChange(false)
        return
      }
      // The project (D1) owns the folders. Since the flow is "create the
      // pipeline and choose the repository", it is born together, with the same name.
      const target = projectId ?? (await createProject(name.trim(), folders)).id
      const pipeline = await createPipeline({
        projectId: target,
        name: name.trim(),
        phases,
        providerId: phasesModel.providerId,
        modelId: phasesModel.modelId,
        reasoning: defaultReasoning,
        commitAtEnd,
        ...(commitPrompt.trim() ? { commitPrompt: commitPrompt.trim() } : {}),
        worktreePerTask: worktreePerTask && hasGit !== false,
        ...(mergeFlow && parallelTasks > 1 ? { parallelTasks } : {}),
      })
      // Recents are global and shared with the chats. The model enters the list
      // here, and not when it is picked: the app's criterion is "actually used"
      // (in the chats, when a response finishes) — creating the pipeline is the
      // moment it becomes the model of the phases.
      useSessionModelPrefs.getState().markUsed(phasesModel.providerId, phasesModel.modelId)
      onOpenChange(false)
      onCreated?.(pipeline.id)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogTitle>{editingPipeline ? t("pipeline.editPipeline") : t("pipeline.newPipeline")}</DialogTitle>

          <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
            <Field label={t("pipeline.pipelineName")}>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-8 text-sm"
                placeholder={t("pipeline.nameExample")}
              />
            </Field>

            <Field label={t("pipeline.folders")} hint={t("pipeline.foldersHint")}>
              <div className="flex flex-wrap items-center gap-2">
                <FolderSelector folders={folders} onFoldersChange={setFolders} />
                {/* Branch badge only after the folder: before it there is no repo
                    to list, and the picker would open empty. */}
                {folders[0] && <BranchSelector repoPath={folders[0]} />}
              </div>
              {folders.length > 0 && (
                
                  <Truncate>
                      <p className="mt-1 truncate text-[11px] text-muted-foreground">
                      {t("pipeline.mainRepository")}: <span className="text-foreground">{folders[0]}</span>
                    </p>
                  </Truncate>
              )}
            </Field>

            {!editingPipeline && (
            <Field label={t("pipeline.defaultModel")} hint={t("pipeline.modelHint")}>
              {/* Trigger that looks like a form field (same visual as the Input),
                  but opens the real picker — which includes the recents. Next to
                  it, the reasoning level (as in Preferences). */}
              <div className="flex items-center gap-1.5">
                <div className="min-w-0 flex-1">
                  <ModelPicker
                    sessionId={MODEL_KEY}
                    triggerClassName="w-full justify-start gap-1.5 rounded-md border border-input bg-input/20 px-2 text-sm font-normal shadow-none hover:bg-accent/40 dark:bg-input/30 md:text-xs/relaxed"
                  />
                </div>
                <ThinkingMenu model={model ?? null} value={defaultReasoning} onChange={setDefaultReasoning} />
              </div>
            </Field>
            )}

            <Field label={t("pipeline.phases")} hint={t("pipeline.phasesHint")}>
              <DndContext sensors={sensors} onDragEnd={handleDrop}>
                <div className="space-y-1">
                  {phases.map((phase, index) => (
                    <PhaseRow
                      key={`${phase.templateId ?? "custom"}-${index}`}
                      phase={phase}
                      index={index}
                      defaultModel={phasesModel}
                      defaultReasoning={phasesReasoning}
                      showDefault={!editingPipeline}
                      onEdit={() => setEditing({ index, phase })}
                      onRemove={() => setPhases((current) => current.filter((_, i) => i !== index))}
                    />
                  ))}
                </div>
              </DndContext>

              <div className="mt-1.5">
                <DropdownMenu open={phaseMenuOpen} onOpenChange={setPhaseMenuOpen}>
                  <DropdownMenuTrigger
                    className="flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
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
                        {/* Only the user-created ones can go; the built-in ones belong to the app. */}
                        {tpl.userCreated && (
                          <Hint label={t("pipeline.deletePhase")}>
                            <button
                              type="button"
                              aria-label={t("pipeline.deletePhase")}
                              onClick={(e) => {
                                e.stopPropagation()
                                e.preventDefault()
                                setPhaseMenuOpen(false)
                                setDeleting(tpl)
                              }}
                              className="ml-2 shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            >
                              <XIcon className="size-3" />
                            </button>
                          </Hint>
                        )}
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
            </Field>

            <div className="space-y-2">
              {/* Worktrees: the flow is built around them (tasks merge into one
                  integration branch). Without git there is nothing to merge, so the
                  switch is off and explains why. */}
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
                    <span className="mt-1 block text-[11px] text-amber-600 dark:text-amber-400">
                      {t("pipeline.noGitNotice")}
                    </span>
                  )}
                  {hasGit !== false && !worktreePerTask && (
                    <span className="mt-1 block text-[11px] text-amber-600 dark:text-amber-400">
                      {t("pipeline.worktreeOffNotice")}
                    </span>
                  )}
                </span>
              </label>
              <div className="space-y-1">
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
                {!commitAtEnd && (
                  <p className="pl-10 text-[11px] text-amber-600 dark:text-amber-400">
                    {t(worktreePerTask && hasGit !== false ? "pipeline.commitOffSharedNotice" : "pipeline.commitOffNotice")}
                  </p>
                )}
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
          </div>

          <div className="flex justify-end gap-2 border-t pt-3">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button size="sm" disabled={!canCreate || saving} onClick={() => void create()}>
              {editingPipeline ? t("pipeline.save") : t("pipeline.create")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <PhaseEditor
        phase={editing?.phase ?? null}
        open={!!editing}
        defaultModel={phasesModel}
        defaultReasoning={phasesReasoning}
        inheritsDefault={!editingPipeline}
        onOpenChange={(v) => !v && setEditing(null)}
        onSave={(phase, destination) => void savePhase(phase, destination)}
      />

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        title={t("pipeline.deletePhaseTitle")}
        description={t("pipeline.deletePhaseConfirm", { name: deleting?.name ?? "" })}
        confirmLabel={t("pipeline.deletePhase")}
        cancelLabel={t("common.cancel")}
        destructive
        onConfirm={() => deleting && void removeTemplate(deleting.id)}
      />

      {/* Final commit prompt: empty = default (whatever the task asks for;
          without that, the style of the last commit; without history, memory;
          fallback Conventional Commits). */}
      <Dialog open={promptOpen} onOpenChange={setPromptOpen}>
        <DialogContent className="max-w-xl">
          <DialogTitle>{t("pipeline.commitPromptTitle")}</DialogTitle>
          <p className="text-[11px] text-muted-foreground">{t("pipeline.commitPromptHint")}</p>
          <Textarea
            value={commitPrompt}
            onChange={(e) => setCommitPrompt(e.target.value)}
            placeholder={PIPELINE_COMMIT_PROMPT_DEFAULT}
            rows={12}
            className="text-xs"
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">{t("pipeline.commitPromptEmpty")}</p>
            <Button size="sm" onClick={() => setPromptOpen(false)}>
              {t("common.close")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-foreground">{label}</p>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      {children}
    </div>
  )
}

/** Draggable phase row: the handle moves it, the rest opens the editor. */
function PhaseRow({
  phase,
  index,
  defaultModel,
  defaultReasoning,
  showDefault,
  onEdit,
  onRemove,
}: {
  phase: PhaseChoice
  index: number
  defaultModel: { providerId: string; modelId: string } | null
  defaultReasoning: ReasoningConfig | null
  /** On creation: highlights the phases with a model of their own (the others follow the default) */
  showDefault: boolean
  onEdit: () => void
  onRemove: () => void
}) {
  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({ id: `phase-${index}` })
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `target-${index}` })
  const { t } = useTranslation()
  const own = !!phase.providerId && !!phase.modelId
  const modelLabel = useModelLabel(
    own ? phase.providerId : defaultModel?.providerId,
    own ? phase.modelId : defaultModel?.modelId,
    own ? (phase.reasoning ?? null) : defaultReasoning,
  )

  return (
    <div
      ref={setDropRef}
      className={cn(
        "flex items-center gap-2 rounded-md border bg-card px-2 py-1.5 transition-colors",
        isDragging && "opacity-40",
        isOver && "border-primary",
      )}
    >
      <button
        ref={setDragRef}
        {...attributes}
        {...listeners}
        type="button"
        aria-label={t("common.reorder")}
        className="shrink-0 cursor-grab text-muted-foreground/60 hover:text-foreground active:cursor-grabbing"
      >
        <GripVerticalIcon className="size-3.5" />
      </button>
      <div className="min-w-0 flex-1">
        <Truncate text={phase.name}>
          <p className="truncate text-xs font-medium">{phase.name}</p>
        </Truncate>
        <Truncate text={phase.description}>
          <p className="truncate text-[11px] text-muted-foreground">{phase.description}</p>
        </Truncate>
      </div>
      {modelLabel && (
        <Truncate text={modelLabel}>
          <span
            className={cn(
              "max-w-44 shrink-0 truncate rounded px-1.5 py-0.5 text-[10px]",
              own && showDefault ? "bg-primary/10 text-primary" : "text-muted-foreground",
            )}
          >
            {modelLabel}
          </span>
        </Truncate>
      )}
      <Hint label={t("common.edit")}>
        <button
          type="button"
          onClick={onEdit}
          className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
        >
          <PencilIcon className="size-3.5" />
        </button>
      </Hint>
      <Hint label={t("common.remove")}>
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 cursor-pointer text-muted-foreground hover:text-destructive"
        >
          <XIcon className="size-3.5" />
        </button>
      </Hint>
    </div>
  )
}
