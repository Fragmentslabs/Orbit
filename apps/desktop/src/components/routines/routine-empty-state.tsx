import { useTranslation } from "react-i18next"
import { Loader2, PlayIcon } from "lucide-react"
import { nextRoutineRun, type Routine } from "@shared/routines"
import { Button } from "@/components/ui/button"
import { Persona } from "@/src/components/ai/persona"
import { formatWhen } from "@/src/lib/format"
import { useRoutinesStore } from "@/src/stores/routines-store"

/**
 * The routine before its first execution: who it is, that it has not run yet, and the button
 * that runs it now.
 *
 * It takes the place of the generic start screen on purpose — a routine chat is not a new
 * conversation waiting for a prompt, and the instruction belongs to the routine's settings.
 */
export function RoutineEmptyState({ routine }: { routine: Routine }) {
  const { t, i18n } = useTranslation()
  const runNow = useRoutinesStore((s) => s.runNow)
  const running = useRoutinesStore((s) =>
    s.runs.some((run) => run.routineId === routine.id && run.status === "running"),
  )
  const next = nextRoutineRun(routine)

  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <div style={{ width: "8rem", height: "8rem" }}>
        <Persona state="idle" className="!size-full" />
      </div>
      <div className="flex flex-col items-center gap-2">
        <h1 className="max-w-md text-lg font-semibold">{routine.title}</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          {next
            ? t("routines.chat.notRunYetNext", { when: formatWhen(next, i18n.language) })
            : t("routines.chat.notRunYet")}
        </p>
      </div>
      <Button variant="outline" onClick={() => void runNow(routine.id)} disabled={running}>
        {running ? <Loader2 className="size-4 animate-spin" /> : <PlayIcon className="size-4" />}
        {t("routines.list.runNow")}
      </Button>
    </div>
  )
}
