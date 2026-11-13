import { useTranslation } from "react-i18next"
import { ChevronLeftIcon, Loader2, PlayIcon, PlusIcon, Settings2Icon, SquareIcon } from "lucide-react"
import type { Pipeline } from "@shared/pipeline"
import { Button } from "@/components/ui/button"
import { Hint } from "@/components/ui/hint"
import { cn } from "@/lib/utils"
import { EditableName } from "@/src/components/editable-name"
import { EMPTY_TASKS, usePipelineStore } from "@/src/stores/pipeline-store"

/**
 * The pipeline in the window header — the same place and the same shape as a routine: back to
 * the list, the name (a click renames it, the text already selected) and the state.
 */
export function PipelineHeaderTitle({ pipeline, onBack }: { pipeline: Pipeline; onBack: () => void }) {
  const { t } = useTranslation()
  const updatePipeline = usePipelineStore((s) => s.updatePipeline)
  const running = usePipelineStore(
    (s) => (s.tasksPerPipeline[pipeline.id] ?? EMPTY_TASKS).filter((x) => x.status === "in_progress").length,
  )
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <button
        type="button"
        onClick={onBack}
        className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label={t("pipeline.back")}
      >
        <ChevronLeftIcon className="size-4" />
      </button>
      <EditableName
        value={pipeline.name}
        label={t("pipeline.list.edit")}
        onSave={(next) => void updatePipeline(pipeline.id, { name: next })}
      />
      {running > 0 && (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-blue-500/35 bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-500">
          <Loader2 className="size-2.5 animate-spin" />
          {t("pipeline.list.running", { count: running })}
        </span>
      )}
    </div>
  )
}

/** The board's actions in the window header: the new task and the queue, on the standard buttons. */
export function PipelineHeaderActions({ pipeline }: { pipeline: Pipeline }) {
  const { t } = useTranslation()
  const setPlanOpen = usePipelineStore((s) => s.setPlanOpen)
  const queueEnabled = usePipelineStore((s) => s.queueEnabled[pipeline.id] ?? false)
  const toggleQueue = usePipelineStore((s) => s.toggleQueue)
  return (
    <div className="flex items-center gap-1.5">
      <Button onClick={() => setPlanOpen(true)}>
        <PlusIcon />
        {t("pipeline.addTask")}
      </Button>
      <Button
        variant="outline"
        className={cn(queueEnabled && "border-primary/50 bg-primary/10 text-primary")}
        onClick={() => void toggleQueue(pipeline.id, !queueEnabled)}
      >
        {queueEnabled ? <SquareIcon /> : <PlayIcon />}
        {queueEnabled ? t("pipeline.queueOn") : t("pipeline.queueOff")}
      </Button>
    </div>
  )
}

/** The gear at the right of the window header (before the panel button): the pipeline's settings. */
export function PipelineSettingsButton() {
  const { t } = useTranslation()
  const settingsOpen = usePipelineStore((s) => s.settingsOpen)
  const setSettingsOpen = usePipelineStore((s) => s.setSettingsOpen)
  return (
    <Hint label={t("pipeline.settings.title")}>
      <button
        type="button"
        aria-label={t("pipeline.settings.title")}
        aria-pressed={settingsOpen}
        onClick={() => setSettingsOpen(!settingsOpen)}
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground",
          settingsOpen ? "bg-primary/15 text-primary" : "text-muted-foreground",
        )}
      >
        <Settings2Icon className="size-3.5" />
      </button>
    </Hint>
  )
}
