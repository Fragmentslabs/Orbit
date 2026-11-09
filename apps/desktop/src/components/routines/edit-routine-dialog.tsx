import { useState } from "react"
import { useTranslation } from "react-i18next"
import type { Routine, RoutineModes, Schedule } from "@shared/routines"
import { parseTime, ROUTINE_CHAT_MODES } from "@shared/routines"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { ModelPicker } from "@/src/components/model-picker"
import type { SelectedModel } from "@/src/stores/provider-store"
import { useRoutinesStore } from "@/src/stores/routines-store"
import { ModesEditor, ReuseChatField, ScheduleEditor } from "./schedule-editor"
import { EMPTY_TEAM, TeamEditor, teamIsValid, type TeamDraft } from "./team-editor"

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
  const update = useRoutinesStore((s) => s.update)
  const [title, setTitle] = useState(routine.title)
  const [prompt, setPrompt] = useState(routine.prompt)
  const [schedule, setSchedule] = useState<Schedule>(routine.schedule)
  const [modes, setModes] = useState<RoutineModes>(routine.modes)
  const [model, setModel] = useState<SelectedModel | null>(routine.model)
  const [reuseChat, setReuseChat] = useState(!!routine.reuseChat)
  const draftOf = (): TeamDraft => ({ team: routine.team ?? EMPTY_TEAM.team, tokenBudget: routine.tokenBudget })
  const [teamDraft, setTeamDraft] = useState<TeamDraft>(draftOf)

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
      setReuseChat(!!routine.reuseChat)
      setTeamDraft(draftOf())
    }
  }

  const canSave = title.trim().length > 0 && prompt.trim().length > 0 && !!parseTime(schedule.time) && !!model && teamIsValid(teamDraft)

  const save = async () => {
    if (!canSave || !model) return
    await update(routine.id, {
      title: title.trim(),
      prompt: prompt.trim(),
      schedule,
      modes,
      model,
      reuseChat,
      team: teamDraft.team.members.length > 0 ? teamDraft.team : undefined,
      tokenBudget: teamDraft.team.members.length > 0 ? teamDraft.tokenBudget : undefined,
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>{t("routines.list.edit")}</DialogTitle>
        <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1">
          <div className="space-y-1">
            <p className="text-xs font-medium">{t("routines.review.titleField")}</p>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} className="h-8 text-sm" />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium">{t("routines.review.promptField")}</p>
            <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} className="max-h-56 min-h-28" />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium">{t("routines.review.schedule")}</p>
            <ScheduleEditor schedule={schedule} onChange={setSchedule} />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium">{t("routines.review.modes")}</p>
            <ModesEditor
              modes={modes}
              onChange={setModes}
              available={routine.mode === "chat" ? ROUTINE_CHAT_MODES : undefined}
            />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium">{t("routines.create.model")}</p>
            <ModelPicker value={model} onValueChange={setModel} />
          </div>
          <ReuseChatField value={reuseChat} onChange={setReuseChat} />
          {routine.mode === "code" && <TeamEditor value={teamDraft} onChange={setTeamDraft} />}
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
