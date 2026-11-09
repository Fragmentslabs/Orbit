import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { AlertCircleIcon, ArrowLeftIcon, SparklesIcon } from "lucide-react"
import type { PendingRoutine, RoutineModes, RoutineSuggestion, Schedule } from "@shared/routines"
import { DEFAULT_ROUTINE_PERMISSION, parseTime, restrictModesToChat, ROUTINE_CHAT_MODES, routineModeFor } from "@shared/routines"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Skeleton } from "@/components/ui/skeleton"
import { useWorkspace } from "@/lib/workspace-context"
import { BranchSelector } from "@/src/components/branch-selector"
import { FolderSelector } from "@/src/components/folder-selector"
import { ModelPicker } from "@/src/components/model-picker"
import { LOCALE_PROMPT_NAME, useLocaleStore } from "@/src/stores/locale-store"
import type { SelectedModel } from "@/src/stores/provider-store"
import { useProviderStore } from "@/src/stores/provider-store"
import { sessionModelFor, useSessionModelPrefs } from "@/src/stores/session-model-prefs"
import { useRoutinesStore } from "@/src/stores/routines-store"
import { ModesEditor, ReuseChatField, ScheduleEditor } from "./schedule-editor"
import { describeWhen } from "./schedule"
import { EMPTY_TEAM, TeamEditor, teamIsValid, type TeamDraft } from "./team-editor"
import { Truncate } from "@/components/ui/truncated-text"

/**
 * "New routine" modal, in two steps inside the same dialog:
 *
 *   1. Describe  — free text + model, and only that
 *   2. Review    — what the model proposed, everything editable before confirming
 *
 * Step 2 is never skipped: the agent SUGGESTS (title, prompt, schedule, modes)
 * and the user decides — nothing from the generator goes straight to disk. The
 * transition enters from the right and the header gains the back button, so
 * moving back and forth between the steps is obvious.
 */
export function CreateRoutineDialog({
  open,
  onOpenChange,
  onCreated,
  defaultMode = "code",
  proposal,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (routineId: string) => void
  /** Mode of the page that opened the modal. It only seeds the folders: a code page starts with
   *  the workspace's folders attached, a chat page with none. The routine's own mode is derived
   *  from the folders (see `routineModeFor`), so adding or removing one changes it. */
  defaultMode: "chat" | "code"
  /** A routine the chat proposed: the modal opens straight on the review, filled in with it, and
   *  creating keeps the proposal's id so its card recognises the routine. */
  proposal?: PendingRoutine
}) {
  const { t } = useTranslation()
  const { folders: workspaceFolders } = useWorkspace()
  const routines = useRoutinesStore((s) => s.routines)
  const generate = useRoutinesStore((s) => s.generate)
  const create = useRoutinesStore((s) => s.create)
  // Vision model configured in the preferences: it is what the routine stores
  // when Vision mode is on (the main process does not read localStorage).
  const visionModel = useProviderStore((s) => s.visionModel)
  const visionAvailable = !!visionModel

  const [description, setDescription] = useState("")
  const [model, setModel] = useState<SelectedModel | null>(null)
  // The folders are optional. The routine's mode follows them: any folder, code; none, chat.
  // The folder is picked IN STEP 1, together with the model — the generation
  // already uses those folders as prompt context. Seeded from the current
  // workspace (the common case is a routine for the repository already open),
  // but independent from it from then on: switching folders in the chat behind
  // cannot change the routine being created.
  const [folders, setFolders] = useState<string[]>([])
  const [generating, setGenerating] = useState(false)
  const mode = routineModeFor(folders)
  const [error, setError] = useState<string | null>(null)
  const [suggestion, setSuggestion] = useState<RoutineSuggestion | null>(null)

  // Step 2 fields (start from the suggestion, then follow the user's edits)
  const [title, setTitle] = useState("")
  const [prompt, setPrompt] = useState("")
  const [schedule, setSchedule] = useState<Schedule>({ time: "09:00" })
  const [modes, setModes] = useState<RoutineModes>({ permissionMode: DEFAULT_ROUTINE_PERMISSION })
  const [reuseChat, setReuseChat] = useState(false)
  const [teamDraft, setTeamDraft] = useState<TeamDraft>(EMPTY_TEAM)
  const [saving, setSaving] = useState(false)

  /**
   * Default model, in this order: the one of the last routine created > the one
   * of the last chat (rule that already exists in sessionModelFor) > empty. The
   * previous routine comes first because it is the closest context to what the
   * user is doing now — whoever builds the second routine wants the same model
   * as the first.
   */
  const fallback = useMemo<SelectedModel | null>(() => {
    const last = [...routines].sort((a, b) => b.createdAt - a.createdAt)[0]
    if (last) return last.model
    return sessionModelFor(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routines.length])

  // Every opening starts over — reopening the modal after creating a routine
  // cannot bring back the previous draft.
  useEffect(() => {
    if (!open) return
    setDescription("")
    setSuggestion(null)
    setError(null)
    setGenerating(false)
    setModel(fallback)
    setReuseChat(false)
    setFolders(defaultMode === "chat" ? [] : workspaceFolders)
    if (proposal) {
      const filled = { title: proposal.title, prompt: proposal.prompt, schedule: proposal.schedule, modes: proposal.modes }
      setSuggestion(filled)
      setTitle(filled.title)
      setPrompt(filled.prompt)
      setSchedule(filled.schedule)
      setModes(filled.modes)
      setFolders(proposal.folders)
      setModel(proposal.model)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, fallback])

  const canGenerate = description.trim().length > 0 && !!model && !generating

  const handleGenerate = async () => {
    if (!canGenerate || !model) return
    setGenerating(true)
    setError(null)
    try {
      const language = LOCALE_PROMPT_NAME[useLocaleStore.getState().activeLocale]
      const result = await generate(description.trim(), model, folders, language, mode, visionAvailable)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setSuggestion(result.suggestion)
      setTitle(result.suggestion.title)
      setPrompt(result.suggestion.prompt)
      setSchedule(result.suggestion.schedule)
      setModes(result.suggestion.modes)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
    }
  }

  // No folder is fine: without one the routine simply runs as a chat.
  const canCreate =
    !!model &&
    title.trim().length > 0 &&
    prompt.trim().length > 0 &&
    !!parseTime(schedule.time) &&
    teamIsValid(teamDraft) &&
    !saving

  const handleCreate = async () => {
    if (!canCreate || !model) return
    setSaving(true)
    try {
      const routine = await create({
        title: title.trim(),
        prompt: prompt.trim(),
        schedule,
        model,
        // Vision only works with the configured vision model — if the user
        // turned the badge on in the review without one, the mode comes out
        // disabled from creation (the scheduler would have nothing to send in
        // `visionModel`).
        modes: (() => {
          const base = modes.vision && !visionModel ? { ...modes, vision: undefined } : modes
          // Folders removed in the review: the code-only modes cannot ride along into a chat routine.
          return mode === "chat" ? restrictModesToChat(base) : base
        })(),
        mode,
        folders,
        visionModel: modes.vision ? (visionModel ?? undefined) : undefined,
        reuseChat: reuseChat || undefined,
        // Scripts and their trigger ride along from the agent's proposal (the form has no editor for them).
        ...(proposal?.scripts?.length ? { scripts: proposal.scripts, trigger: proposal.trigger } : {}),
        // The team only exists in a code routine (its workers need a folder to work in).
        ...(mode === "code" && teamDraft.team.members.length > 0
          ? { team: teamDraft.team, tokenBudget: teamDraft.tokenBudget }
          : {}),
        active: true,
        // The proposal's own id: its card finds the routine and turns into "created".
        ...(proposal ? { id: proposal.id } : {}),
      })
      // Recents are global and shared with the chats. The model enters the list
      // here — creating the routine is the moment it starts being used for real
      // (same criterion as the pipeline modal).
      useSessionModelPrefs.getState().markUsed(model.providerId, model.modelId)
      onOpenChange(false)
      onCreated?.(routine.id)
    } finally {
      setSaving(false)
    }
  }

  const reviewing = !!suggestion

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl overflow-hidden">
        <div className="flex items-center gap-2">
          {reviewing && !proposal && (
            <Button variant="ghost" size="icon-sm" onClick={() => setSuggestion(null)} aria-label={t("routines.review.back")}>
              <ArrowLeftIcon className="size-3.5" />
            </Button>
          )}
          <div className="min-w-0">
            <DialogTitle>{reviewing ? t("routines.review.title") : t("routines.create.title")}</DialogTitle>
            <Truncate text={reviewing ? t("routines.review.subtitle") : t("routines.create.describeHint")}>
              <p className="truncate text-[11px] text-muted-foreground">
                {reviewing ? t("routines.review.subtitle") : t("routines.create.describeHint")}
              </p>
            </Truncate>
          </div>
        </div>

        {reviewing ? (
          <div
            // key forces the animation to run again on every trip to the review
            key="review"
            className="animate-in slide-in-from-right-8 fade-in-0 duration-200"
          >
            <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
              <Field label={t("routines.review.titleField")}>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} className="h-8 text-sm" />
              </Field>

              <Field label={t("routines.review.promptField")} hint={t("routines.review.promptFieldHint")}>
                <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} className="max-h-56 min-h-28" />
              </Field>

              {/* A script decides when this one runs: there is no calendar to edit. */}
              <Field label={t("routines.review.schedule")}>
                {proposal?.trigger ? (
                  <p className="text-xs text-muted-foreground">{describeWhen({ schedule, trigger: proposal.trigger }, t)}</p>
                ) : (
                  <ScheduleEditor schedule={schedule} onChange={setSchedule} />
                )}
              </Field>

              <Field label={t("routines.review.modes")} hint={t("routines.review.modesHint")}>
                <ModesEditor modes={modes} onChange={setModes} available={mode === "chat" ? ROUTINE_CHAT_MODES : undefined} />
              </Field>

              <Field label={t("routines.create.model")}>
                <ModelPicker value={model} onValueChange={setModel} />
              </Field>

              <ReuseChatField value={reuseChat} onChange={setReuseChat} />

              <Field label={t("routines.review.folders")} hint={t("routines.review.foldersHint")}>
                <FolderSelector folders={folders} onFoldersChange={setFolders} />
              </Field>

              {mode === "code" && <TeamEditor value={teamDraft} onChange={setTeamDraft} />}
            </div>

            <div className="mt-3 flex justify-end gap-2 border-t pt-3">
              <Button variant="ghost" size="sm" onClick={() => (proposal ? onOpenChange(false) : setSuggestion(null))}>
                {proposal ? t("common.cancel") : t("routines.review.back")}
              </Button>
              <Button size="sm" disabled={!canCreate} onClick={() => void handleCreate()}>
                {t("routines.review.create")}
              </Button>
            </div>
          </div>
        ) : (
          <div key="describe" className="animate-in slide-in-from-left-8 fade-in-0 duration-200">
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t(mode === "chat" ? "routines.create.placeholderChat" : "routines.create.placeholder")}
              className="max-h-64 min-h-36"
              disabled={generating}
            />

            {error && (
              <p className="mt-2 flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">
                <AlertCircleIcon className="mt-px size-3.5 shrink-0" />
                <span className="min-w-0 flex-1">{error}</span>
              </p>
            )}

            {generating && (
              <div className="mt-2 space-y-2 rounded-lg border bg-card p-3">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-5/6" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
              <div className="flex flex-wrap items-center gap-2">
                <FolderSelector folders={folders} onFoldersChange={setFolders} />
                {folders[0] && <BranchSelector repoPath={folders[0]} />}
              </div>
              <ModelPicker value={model} onValueChange={setModel} />
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">{t(folders.length > 0 ? "routines.create.foldersCodeHint" : "routines.create.foldersChatHint")}</p>
            {!model && <p className="mt-1.5 text-[11px] text-muted-foreground">{t("routines.create.noModel")}</p>}

            <div className="mt-2 flex justify-end">
              <Button size="sm" disabled={!canGenerate} onClick={() => void handleGenerate()}>
                <SparklesIcon className="size-3.5" />
                {generating ? t("routines.create.generating") : t("routines.create.generate")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
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
