import { useTranslation } from "react-i18next"
import { ChevronLeftIcon, Loader2, PlayIcon, Settings } from "lucide-react"
import type { Routine } from "@shared/routines"
import { Button } from "@/components/ui/button"
import { Hint } from "@/components/ui/hint"
import { cn } from "@/lib/utils"
import { EditableName } from "@/src/components/editable-name"
import { useRoutinesStore } from "@/src/stores/routines-store"

/**
 * The routine in the window header: the way back to the list, the name, the state — and, on
 * the right, the action. The page has one header, not two: the routine screen replaces the
 * page's, exactly like a fragment in fullscreen does.
 */
export function RoutineHeaderTitle({ routine, onBack }: { routine: Routine; onBack: () => void }) {
  const { t } = useTranslation()
  const running = useRoutinesStore((s) =>
    s.runs.some((run) => run.routineId === routine.id && run.status === "running"),
  )
  const update = useRoutinesStore((s) => s.update)
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <button
        type="button"
        onClick={onBack}
        className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label={t("routines.chat.back")}
      >
        <ChevronLeftIcon className="size-4" />
      </button>
      <EditableName
        value={routine.title}
        label={t("routines.list.edit")}
        onSave={(next) => void update(routine.id, { title: next })}
      />
      {running ? (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-blue-500/35 bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-500">
          <Loader2 className="size-2.5 animate-spin" />
          {t("routines.list.runningNow")}
        </span>
      ) : !routine.active ? (
        <span className="shrink-0 rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground">
          {t("routines.list.paused")}
        </span>
      ) : null}
    </div>
  )
}

export function RoutineHeaderActions({ routine }: { routine: Routine }) {
  const { t } = useTranslation()
  const runNow = useRoutinesStore((s) => s.runNow)
  const running = useRoutinesStore((s) =>
    s.runs.some((run) => run.routineId === routine.id && run.status === "running"),
  )
  return (
    <div className="flex items-center gap-1">
      <Button
        variant="outline"
        className={cn(running && "text-muted-foreground")}
        disabled={running}
        onClick={() => void runNow(routine.id)}
      >
        {running ? <Loader2 className="size-3.5 animate-spin" /> : <PlayIcon className="size-3.5" />}
        {t("routines.list.runNow")}
      </Button>
    </div>
  )
}

/**
 * The gear at the right of the window header (immediately before the panel button): it opens the
 * routine's own panel — executions and settings beside the chat, the way a fragment opens its
 * details. It lives outside the actions group so it keeps the same place on every screen.
 */
export function RoutineDetailsButton() {
  const { t } = useTranslation()
  const detailsOpen = useRoutinesStore((s) => s.detailsOpen)
  const toggleDetails = useRoutinesStore((s) => s.toggleDetails)
  return (
    <Hint label={t("routines.chat.info")}>
      <button
        type="button"
        aria-label={t("routines.chat.info")}
        aria-pressed={detailsOpen}
        onClick={toggleDetails}
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground",
          detailsOpen ? "bg-primary/15 text-primary" : "text-muted-foreground",
        )}
      >
        <Settings className="size-3.5" />
      </button>
    </Hint>
  )
}
