import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import type { Pipeline, Task } from "@shared/pipeline"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { usePipelineStore } from "@/src/stores/pipeline-store"

/**
 * Resuming a paused task telling the phase what it must do differently: a piece
 * of information that was missing, a direction to correct. The phase runs again
 * with the instruction as a priority — without opening a new round (that is
 * what "Return" does).
 */
export function ResumeInstructionDialog({
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
  const { t } = useTranslation()
  const resumeTask = usePipelineStore((s) => s.resumeTask)
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setText("")
    setError(null)
  }, [open, task?.id])

  if (!task) return null
  const phase = pipeline.phases[task.currentPhase ?? 0]

  const submitResume = async () => {
    if (!text.trim() || sending) return
    setSending(true)
    setError(null)
    try {
      await resumeTask(pipeline.id, task.id, text.trim())
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogTitle>{t("pipeline.resumeInstructionTitle", { title: task.title })}</DialogTitle>
        <p className="text-[11px] text-muted-foreground">
          {t("pipeline.resumeInstructionHint", { phase: phase?.name ?? "" })}
        </p>

        {task.pauseReason === "error" && task.error && (
          <p className="max-h-24 overflow-y-auto rounded-md bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">
            {task.error}
          </p>
        )}

        <Textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submitResume()
          }}
          rows={5}
          placeholder={t("pipeline.resumeInstructionPlaceholder")}
          className="text-xs"
        />

        {error && <p className="text-[11px] text-destructive">{error}</p>}

        <div className="flex justify-end gap-2 border-t pt-3">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" disabled={!text.trim() || sending} onClick={() => void submitResume()}>
            {t("pipeline.resume")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
