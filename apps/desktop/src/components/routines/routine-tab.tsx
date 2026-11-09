import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { CalendarClockIcon } from "lucide-react"
import { useRoutinesStore } from "@/src/stores/routines-store"
import { ORPHAN_KEY, usePanelStore } from "@/src/stores/panel-store"
import { RoutineDetail } from "./routine-detail"

/**
 * Side panel tab with a routine opened from the Routines page: the same detail the page used to
 * hold, with the width the panel gives it (it resizes up to most of the window) and next to the
 * other tabs. The tab has its own close button, so the detail does not draw one.
 */
export function RoutineTab({ routineId, tabId, sessionId }: { routineId?: string; tabId: string; sessionId?: string }) {
  const { t } = useTranslation()
  const loaded = useRoutinesStore((s) => s.loaded)
  const routine = useRoutinesStore((s) => s.routines.find((r) => r.id === routineId))
  const removeTab = usePanelStore((s) => s.removeTab)

  // The routine was deleted (from this very tab, or in another window): there is nothing left
  // to show, so the tab goes away instead of staying open on an empty message.
  useEffect(() => {
    if (loaded && !routine) removeTab(sessionId ?? ORPHAN_KEY, tabId)
  }, [loaded, routine, removeTab, sessionId, tabId])

  if (!routine) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-xs text-muted-foreground">
        <CalendarClockIcon className="size-5" />
        <p>{t("routines.tab.notFound")}</p>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
      <RoutineDetail routine={routine} />
    </div>
  )
}
