import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { GitMergeIcon, MoreHorizontalIcon, Trash2Icon } from "lucide-react"
import type { Delivery, Pipeline, Task } from "@shared/pipeline"
import { ConfirmDialog } from "@/components/ui/alert-dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { pipelineApi } from "@/src/lib/ipc"
import { usePipelineStore } from "@/src/stores/pipeline-store"
import { formatCost } from "./task-card"

const NO_DELIVERIES: Delivery[] = []

/**
 * History of the Merge button: one entry per delivery, the tasks it carried
 * inside it. A click on a task opens it (read-only). Deleting a delivery removes
 * the record, its archived tasks and the images they stored — never automatic.
 */
export function HistoryPanel({
  pipeline,
  tasks,
  open,
  onOpenChange,
  onOpenTask,
}: {
  pipeline: Pipeline
  tasks: Task[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenTask: (taskId: string) => void
}) {
  const { t, i18n } = useTranslation()
  const deliveries = usePipelineStore((s) => s.deliveriesPerPipeline[pipeline.id] ?? NO_DELIVERIES)
  const loadDeliveries = usePipelineStore((s) => s.loadDeliveries)
  const [deleting, setDeleting] = useState<Delivery | null>(null)

  useEffect(() => {
    if (open) void loadDeliveries(pipeline.id)
  }, [open, pipeline.id, loadDeliveries])

  const date = (iso: string) =>
    new Date(iso).toLocaleString(i18n.language, { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" })

  const ordered = [...deliveries].sort((a, b) => b.number - a.number)

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full gap-0 sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{t("pipeline.history.title")}</SheetTitle>
            <SheetDescription>{t("pipeline.history.subtitle")}</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
            {ordered.length === 0 && <p className="text-xs text-muted-foreground">{t("pipeline.history.empty")}</p>}
            {ordered.map((delivery) => {
              const items = tasks.filter((x) => x.deliveryId === delivery.id)
              const cost = items.reduce((sum, x) => sum + x.cost, 0)
              return (
                <section key={delivery.id} className="rounded-lg border">
                  <header className="flex items-center gap-2 border-b px-3 py-2">
                    <GitMergeIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-foreground">
                        {delivery.destination
                          ? t("pipeline.history.deliveryTo", { number: delivery.number, branch: delivery.destination })
                          : t("pipeline.history.delivery", { number: delivery.number })}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        {date(delivery.createdAt)}
                        {delivery.mergeHash && ` · ${delivery.mergeHash.slice(0, 7)}`}
                        {cost > 0 && ` · ${formatCost(cost)}`}
                      </p>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        aria-label={t("pipeline.history.options")}
                        className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        <MoreHorizontalIcon className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-40">
                        <DropdownMenuItem variant="destructive" onClick={() => setDeleting(delivery)}>
                          <Trash2Icon className="size-3.5" />
                          {t("pipeline.history.delete")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </header>
                  <ul className="divide-y">
                    {items.map((task) => (
                      <li key={task.id}>
                        <button
                          type="button"
                          onClick={() => {
                            onOpenChange(false)
                            onOpenTask(task.id)
                          }}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent"
                        >
                          {task.number !== undefined && (
                            <span className="shrink-0 font-mono text-muted-foreground">#{task.number}</span>
                          )}
                          <span className="min-w-0 flex-1 truncate">{task.title}</span>
                          {(task.diff?.files.length ?? 0) > 0 && (
                            <span className="shrink-0 text-[10px] text-muted-foreground">
                              {t("pipeline.changedFiles", { count: task.diff!.files.length })}
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                    {items.length === 0 && (
                      <li className="px-3 py-2 text-[11px] text-muted-foreground">{t("pipeline.history.noTasks")}</li>
                    )}
                  </ul>
                </section>
              )
            })}
          </div>
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        title={t("pipeline.history.confirmDelete", { number: deleting?.number ?? 0 })}
        description={t("pipeline.history.confirmDeleteBody")}
        confirmLabel={t("pipeline.history.delete")}
        destructive
        onConfirm={() => deleting && void pipelineApi.deleteDelivery(pipeline.id, deleting.id)}
      />
    </>
  )
}
