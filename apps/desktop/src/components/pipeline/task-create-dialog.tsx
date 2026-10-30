import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDownIcon, XIcon } from "lucide-react"
import type { Task } from "@shared/pipeline"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { SearchableTaskList } from "./task-picker"
import { cn } from "@/lib/utils"
import { MediaEmbed } from "./media-embed"
import { Truncate } from "@/components/ui/truncated-text"

/**
 * New task dialog: title, description and dependencies.
 *
 * The description is the briefing the phases receive — the task runs without a
 * chat, so whatever is not here never reaches the agent.
 */
export function TaskCreateDialog({
  open,
  onOpenChange,
  tasks,
  onCreate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Tasks of the pipeline, candidates for a dependency */
  tasks: Task[]
  onCreate: (data: { title: string; description: string; dependsOn: string[] }) => Promise<void>
}) {
  const { t } = useTranslation()
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [dependsOn, setDependsOn] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setTitle("")
    setDescription("")
    setDependsOn([])
  }, [open])

  const create = async () => {
    if (!title.trim() || saving) return
    setSaving(true)
    try {
      await onCreate({ title: title.trim(), description: description.trim(), dependsOn })
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogTitle>{t("pipeline.newTask")}</DialogTitle>

        <div className="space-y-3">
          <div className="space-y-1">
            <p className="text-xs font-medium">{t("pipeline.taskTitle")}</p>
            <Input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="h-8 text-sm"
              placeholder={t("pipeline.taskTitleExample")}
            />
          </div>

          <div className="space-y-1">
            <p className="text-xs font-medium">{t("pipeline.taskDescription")}</p>
            <p className="text-[11px] text-muted-foreground">{t("pipeline.taskDescriptionHint")}</p>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={6}
              className="w-full resize-y rounded-md border bg-transparent px-2 py-1.5 text-xs outline-none focus-visible:border-ring"
            />
            <MediaEmbed text={description} />
          </div>

          <div className="space-y-1">
            <p className="text-xs font-medium">{t("pipeline.taskDependencies")}</p>
            <p className="text-[11px] text-muted-foreground">{t("pipeline.taskDependenciesHint")}</p>
            <DependencyPicker tasks={tasks} selected={dependsOn} onChange={setDependsOn} />
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t pt-3">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" disabled={!title.trim() || saving} onClick={() => void create()}>
            {t("pipeline.createTask")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Dependency picker: a popover with the search on top and the list below; what
 * was chosen shows in the trigger itself. A bare list will not do — in a
 * pipeline with dozens of tasks, finding the right one requires search.
 */
export function DependencyPicker({
  tasks,
  selected,
  onChange,
  className,
}: {
  tasks: Task[]
  selected: string[]
  onChange: (ids: string[]) => void
  className?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  const chosen = tasks.filter((task) => selected.includes(task.id))

  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={tasks.length === 0}
        className={cn(
          "flex min-h-8 w-full items-center gap-1.5 rounded-md border bg-transparent px-2 py-1 text-left text-xs transition-colors",
          tasks.length === 0 ? "cursor-not-allowed opacity-60" : "hover:border-ring",
          className,
        )}
      >
        <div className="flex min-w-0 flex-1 flex-wrap gap-1">
          {chosen.length === 0 ? (
            <span className="text-muted-foreground">
              {tasks.length === 0 ? t("pipeline.noTasksForDependency") : t("pipeline.selectDependencies")}
            </span>
          ) : (
            chosen.map((task) => (
              <span
                key={task.id}
                className="flex max-w-full items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px]"
              >
                <Truncate text={task.title}>
                  <span className="truncate">{task.title}</span>
                </Truncate>
                <span
                  role="button"
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation()
                    toggle(task.id)
                  }}
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                >
                  <XIcon className="size-3" />
                </span>
              </span>
            ))
          )}
        </div>
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </PopoverTrigger>

      <PopoverContent className="p-0">
        <SearchableTaskList tasks={tasks} selected={selected} onPick={toggle} />
      </PopoverContent>
    </Popover>
  )
}
