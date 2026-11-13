import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { AlertTriangleIcon } from "lucide-react"
import type { Pipeline, Task } from "@shared/pipeline"
import { taskRound } from "@shared/pipeline"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { EMPTY_TASKS, usePipelineStore } from "@/src/stores/pipeline-store"

/**
 * Returning a completed task: the review comment becomes the priority
 * instruction of a new round, which restarts at the chosen phase and works on
 * top of what the previous round left behind.
 */
export function ReturnTaskDialog({
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
  const returnTask = usePipelineStore((s) => s.returnTask)
  const tasks = usePipelineStore((s) => s.tasksPerPipeline[pipeline.id] ?? EMPTY_TASKS)
  const [text, setText] = useState("")
  const [phase, setPhase] = useState(0)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setText("")
    setPhase(0)
    setError(null)
  }, [open, task?.id])

  if (!task) return null

  // Whoever depends on this one and already ran worked on the previous version:
  // warn about it without blocking — sometimes the fix does not affect them.
  const dependentsRan = tasks.filter((x) => x.dependsOn.includes(task.id) && x.status !== "pending")

  const submitReturn = async () => {
    if (!text.trim() || sending) return
    setSending(true)
    setError(null)
    try {
      await returnTask(pipeline.id, task.id, text.trim(), phase)
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
        <DialogTitle>{t("pipeline.returnTitle", { title: task.title })}</DialogTitle>
        <p className="text-[11px] text-muted-foreground">
          {t("pipeline.returnHint", { round: taskRound(task) + 1 })}
        </p>

        <div className="space-y-1">
          <p className="text-xs font-medium">{t("pipeline.returnComment")}</p>
          <Textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submitReturn()
            }}
            rows={6}
            placeholder={t("pipeline.returnPlaceholder")}
            className="text-xs"
          />
        </div>

        <div className="space-y-1">
          <p className="text-xs font-medium">{t("pipeline.returnPhase")}</p>
          <select
            value={phase}
            onChange={(e) => setPhase(Number(e.target.value))}
            className="h-8 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus-visible:border-ring"
          >
            {pipeline.phases.map((p, index) => (
              <option key={p.id} value={index} className="bg-popover text-popover-foreground">
                {p.name}
              </option>
            ))}
          </select>
        </div>

        {dependentsRan.length > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-2.5 py-2 text-[11px] text-yellow-700 dark:text-yellow-300">
            <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {t("pipeline.returnDependents", {
                count: dependentsRan.length,
                titles: dependentsRan.map((x) => x.title).join(", "),
              })}
            </span>
          </div>
        )}

        {error && <p className="text-[11px] text-destructive">{error}</p>}

        <div className="flex justify-end gap-2 border-t pt-3">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!text.trim() || sending} onClick={() => void submitReturn()}>
            {t("pipeline.return")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
