import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Loader2Icon, SparklesIcon, Trash2Icon } from "lucide-react"
import type { PlannedTask, Pipeline } from "@shared/pipeline"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { pipelineApi } from "@/src/lib/ipc"

/**
 * Create tasks by talking to the pipeline model, in two steps: describe what you
 * want loosely, then review what the model proposes — edit, remove, approve.
 * Nothing exists before the second step's button.
 */
export function TaskPlanDialog({
  pipeline,
  open,
  onOpenChange,
  initialRequest = "",
  onCreated,
}: {
  pipeline: Pipeline
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Text to start from (a chat handing over a plan) */
  initialRequest?: string
  /** After the approved tasks were created */
  onCreated?: (count: number) => void
}) {
  const { t } = useTranslation()
  const [request, setRequest] = useState("")
  const [plan, setPlan] = useState<PlannedTask[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setRequest(initialRequest)
    setPlan(null)
    setError(null)
  }, [open, initialRequest])

  const propose = async () => {
    setBusy(true)
    setError(null)
    try {
      setPlan(await pipelineApi.planTasks(pipeline.id, request))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const create = async () => {
    if (!plan || plan.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const created = await pipelineApi.createPlanned(pipeline.id, plan)
      onOpenChange(false)
      onCreated?.(created.length)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const edit = (index: number, patch: Partial<PlannedTask>) =>
    setPlan((current) => current?.map((item, i) => (i === index ? { ...item, ...patch } : item)) ?? null)

  // Removing a task also fixes the indexes of the ones that waited for it.
  const remove = (index: number) =>
    setPlan((current) =>
      current
        ? current
            .filter((_, i) => i !== index)
            .map((item) => ({
              ...item,
              dependsOn: item.dependsOn.filter((d) => d !== index).map((d) => (d > index ? d - 1 : d)),
            }))
        : null,
    )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col gap-3">
        <DialogHeader>
          <DialogTitle>{t("pipeline.plan.title")}</DialogTitle>
          <DialogDescription>{plan ? t("pipeline.plan.reviewHint") : t("pipeline.plan.describeHint")}</DialogDescription>
        </DialogHeader>

        {!plan ? (
          <>
            <Textarea
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              placeholder={t("pipeline.plan.placeholder")}
              className="min-h-40"
              autoFocus
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t("common.cancel")}
              </Button>
              <Button disabled={busy || !request.trim()} onClick={() => void propose()}>
                {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <SparklesIcon className="size-3.5" />}
                {t("pipeline.plan.propose")}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {plan.map((item, index) => (
                <div key={index} className="space-y-1.5 rounded-lg border p-2.5">
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{index + 1}</span>
                    <Input value={item.title} onChange={(e) => edit(index, { title: e.target.value })} className="h-7 text-xs font-medium" />
                    <button
                      type="button"
                      aria-label={t("common.remove")}
                      onClick={() => remove(index)}
                      className="shrink-0 cursor-pointer text-muted-foreground hover:text-destructive"
                    >
                      <Trash2Icon className="size-3.5" />
                    </button>
                  </div>
                  <Textarea
                    value={item.description}
                    onChange={(e) => edit(index, { description: e.target.value })}
                    className="min-h-20 text-xs"
                  />
                  <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                    {item.dependsOn.length > 0 && (
                      <span className="rounded-full bg-muted px-1.5 py-0.5">
                        {t("pipeline.plan.waitsFor", { tasks: item.dependsOn.map((d) => d + 1).join(", ") })}
                      </span>
                    )}
                    {item.files.map((file) => (
                      <span key={file} className="rounded bg-muted/60 px-1 font-mono">
                        {file}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" disabled={busy} onClick={() => setPlan(null)}>
                {t("pipeline.plan.back")}
              </Button>
              <Button disabled={busy || plan.length === 0} onClick={() => void create()}>
                {busy && <Loader2Icon className="size-3.5 animate-spin" />}
                {t("pipeline.plan.create", { count: plan.length })}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
