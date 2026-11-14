import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Folder } from "lucide-react"
import { DEFAULT_ROUTINE_PERMISSION, parseTime, type Schedule } from "@shared/routines"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useWorkspace } from "@/lib/workspace-context"
import { ModelPicker } from "@/src/components/model-picker"
import { RemoteFolderPicker } from "@/src/components/peers/remote-folder-picker"
import { useEnvProviders } from "@/src/hooks/use-env-providers"
import { deriveTitle } from "@/src/lib/routine-title"
import { usePeersStore } from "@/src/stores/peers-store"
import type { SelectedModel } from "@/src/stores/provider-store"
import { useRoutinesStore } from "@/src/stores/routines-store"
import { Field } from "./form-parts"
import { ScheduleEditor } from "./schedule-editor"

/**
 * "New routine" for another desktop: the routine lives and runs THERE, so its model and its
 * folder must be that machine's. One step — what it does, when, which model and (in code
 * mode) which of its folders. Agents, teams and scripts are set up on the machine itself.
 */
export function RemoteCreateRoutineDialog({ open, onOpenChange, onCreated }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (routineId: string) => void
}) {
  const { t } = useTranslation()
  const { mode: pageMode } = useWorkspace()
  const peerId = usePeersStore((s) => s.env)
  const peerName = usePeersStore((s) => s.snapshot?.peers.find((p) => p.peerId === s.env)?.name ?? "")
  const { defaultModel } = useEnvProviders()
  const create = useRoutinesStore((s) => s.create)
  const [title, setTitle] = useState("")
  const [prompt, setPrompt] = useState("")
  const [schedule, setSchedule] = useState<Schedule>({ time: "09:00" })
  const [model, setModel] = useState<SelectedModel | null>(null)
  const [folder, setFolder] = useState<string | null>(null)
  const [pickingFolder, setPickingFolder] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setTitle("")
    setPrompt("")
    setSchedule({ time: "09:00" })
    setFolder(null)
    setError(null)
  }, [open])

  // The machine's own default model, once it has been read.
  useEffect(() => {
    if (open && !model && defaultModel) setModel(defaultModel)
  }, [open, model, defaultModel])

  const canCreate = prompt.trim().length > 0 && !!model && !!parseTime(schedule.time) && !saving

  const submit = async () => {
    if (!canCreate || !model) return
    setSaving(true)
    setError(null)
    try {
      const routine = await create({
        title: title.trim() || deriveTitle(prompt),
        prompt: prompt.trim(),
        schedule,
        model,
        modes: { permissionMode: DEFAULT_ROUTINE_PERMISSION },
        folders: folder ? [folder] : [],
        active: true,
      })
      onOpenChange(false)
      onCreated?.(routine.id)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("peers.remote.newRoutine", { name: peerName })}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          <Field label={t("routines.form.whatItDoes")} hint={t("routines.form.whatItDoesHint")}>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t("routines.form.whatPlaceholder")}
              className="max-h-56 min-h-28"
            />
          </Field>
          <Field label={t("routines.review.schedule")}>
            <ScheduleEditor schedule={schedule} onChange={setSchedule} />
          </Field>
          <Field label={t("routines.review.titleField")}>
            <Input value={title} placeholder={deriveTitle(prompt)} onChange={(e) => setTitle(e.target.value)} className="h-8 text-sm" />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <ModelPicker value={model} onValueChange={setModel} hideRotationOptions triggerClassName="border" />
            {pageMode === "code" ? (
              <>
                <Button variant="outline" size="sm" className="h-7 max-w-full gap-1.5 text-xs" onClick={() => setPickingFolder(true)}>
                  <Folder className="size-3.5 shrink-0" />
                  <span className="truncate">{folder ?? t("peers.remote.noFolder")}</span>
                </Button>
                <RemoteFolderPicker
                  peerId={peerId}
                  peerName={peerName}
                  initial={folder ?? undefined}
                  open={pickingFolder}
                  onOpenChange={setPickingFolder}
                  onPick={setFolder}
                />
              </>
            ) : null}
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!canCreate} onClick={() => void submit()}>
            {t("routines.create.title")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
