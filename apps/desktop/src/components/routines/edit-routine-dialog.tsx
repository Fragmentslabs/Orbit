import { useState } from "react"
import { useTranslation } from "react-i18next"
import { userProfileId } from "@shared/agents"
import type { Routine, RoutineModes, Schedule } from "@shared/routines"
import { applyAgentModes, isScriptTriggered, parseTime, restrictModesToChat, routineModeFor } from "@shared/routines"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { ModelPicker } from "@/src/components/model-picker"
import { agentsAreValid, draftOf, isTeam, soloAgent, storedFields, type AgentsDraft } from "@/src/lib/agents-draft"
import { useAgents } from "@/src/stores/agents-store"
import type { SelectedModel } from "@/src/stores/provider-store"
import { useProviderStore } from "@/src/stores/provider-store"
import { useRoutinesStore } from "@/src/stores/routines-store"
import { AbilitiesField, Field, FoldersField } from "./form-parts"
import { describeWhen } from "./schedule"
import { ScheduleEditor } from "./schedule-editor"
import { AgentsEditor } from "./agents-editor"

export function EditRoutineDialog({
  routine,
  open,
  onOpenChange,
}: {
  routine: Routine
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const agents = useAgents()
  const update = useRoutinesStore((s) => s.update)
  const visionModel = useProviderStore((s) => s.visionModel)
  const [title, setTitle] = useState(routine.title)
  const [prompt, setPrompt] = useState(routine.prompt)
  const [schedule, setSchedule] = useState<Schedule>(routine.schedule)
  const [modes, setModes] = useState<RoutineModes>(routine.modes)
  const [model, setModel] = useState<SelectedModel | null>(routine.model)
  const [folders, setFolders] = useState<string[]>(routine.folders)
  const [draft, setDraft] = useState<AgentsDraft>(() => draftOf(routine))
  const mode = routineModeFor(folders)
  const watched = isScriptTriggered(routine)

  // Reopening the dialog starts over from the persisted routine (the scheduler
  // may have touched it while it was closed).
  const key = `${routine.id}:${open}`
  const [lastKey, setLastKey] = useState(key)
  if (key !== lastKey) {
    setLastKey(key)
    if (open) {
      setTitle(routine.title)
      setPrompt(routine.prompt)
      setSchedule(routine.schedule)
      setModes(routine.modes)
      setModel(routine.model)
      setFolders(routine.folders)
      setDraft(draftOf(routine))
    }
  }

  const canSave =
    title.trim().length > 0 && prompt.trim().length > 0 && (watched || !!parseTime(schedule.time)) && !!model && agentsAreValid(draft)

  const save = async () => {
    if (!canSave || !model) return
    const stored = storedFields(draft)
    const selectedAgent = agents.find((a) => userProfileId(a.id) === stored.agent)
    const withAgent = selectedAgent ? applyAgentModes(modes, selectedAgent.features) : modes
    const effective = mode === "chat" ? restrictModesToChat(withAgent) : withAgent
    // A team needs a folder to work in; without one only a single agent is kept.
    const keepsTeam = mode === "code" && !!stored.team
    await update(routine.id, {
      title: title.trim(),
      prompt: prompt.trim(),
      schedule,
      modes: effective.vision && !visionModel && !routine.visionModel ? { ...effective, vision: undefined } : effective,
      model,
      mode,
      folders,
      agent: stored.agent,
      visionModel: routine.visionModel ?? visionModel ?? undefined,
      team: keepsTeam ? stored.team : undefined,
      tokenBudget: keepsTeam ? stored.tokenBudget : undefined,
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>{t("routines.list.edit")}</DialogTitle>
        <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1">
          <Field label={t("routines.review.titleField")}>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} className="h-8 text-sm" />
          </Field>
          <Field label={t("routines.review.promptField")}>
            <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} className="max-h-56 min-h-28" />
          </Field>
          <Field label={t("routines.review.schedule")}>
            {watched ? (
              <p className="text-xs text-muted-foreground">{describeWhen(routine, t)}</p>
            ) : (
              <ScheduleEditor schedule={schedule} onChange={setSchedule} />
            )}
          </Field>
          <Field label={t("routines.create.model")}>
            <ModelPicker value={model} onValueChange={setModel} />
          </Field>
          <FoldersField folders={folders} onChange={setFolders} />
          <AgentsEditor value={draft} onChange={setDraft} canBeTeam={mode === "code"} />
          <details className="rounded-lg border px-3 py-2">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">{t("routines.form.advanced")}</summary>
            <div className="mt-2.5">
              <AbilitiesField agent={soloAgent(draft)} team={isTeam(draft)} modes={modes} onChange={setModes} chatOnly={mode === "chat"} />
            </div>
          </details>
        </div>
        <div className="flex justify-end gap-2 border-t pt-3">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" disabled={!canSave} onClick={() => void save()}>
            {t("routines.list.save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
