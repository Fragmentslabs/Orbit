import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { MessageSquareIcon, PlusIcon, TerminalIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useWorkspace } from "@/lib/workspace-context"
import { useRoutinesStore } from "@/src/stores/routines-store"
import { useSessionStore } from "@/src/stores/session-store"
import { CreateRoutineDialog } from "./create-routine-dialog"
import { RoutineDetail, RoutineList } from "./my-routines"

/**
 * Routines page (in the sidebar, of the chat and code modes). Two levels, like
 * the pipeline:
 *
 *   routine list  →  [open]  →  routine detail (executed sessions)
 *
 * The page inherits the workspace mode: in chat it lists/creates only chat
 * routines, in code only the code ones. Creating is a MODAL, not a tab: the
 * page is the list, and creating is an action on it. In the detail the list
 * header disappears — whoever is there is inside ONE routine, and the header
 * is that routine's.
 */
export function RoutinesView() {
  const { t } = useTranslation()
  const { mode } = useWorkspace()
  const loaded = useRoutinesStore((s) => s.loaded)
  const load = useRoutinesStore((s) => s.load)
  const routines = useRoutinesStore((s) => s.routines)
  const prune = useRoutinesStore((s) => s.prune)
  const openId = useRoutinesStore((s) => s.openId)
  const setOpen = useRoutinesStore((s) => s.setOpen)
  const sessions = useSessionStore((s) => s.sessions)
  const sessionsLoaded = useSessionStore((s) => s.initialized)
  const [createOpen, setCreateOpen] = useState(false)

  const open = openId ? routines.find((r) => r.id === openId && r.mode === mode) : undefined
  const inMode = routines.filter((r) => r.mode === mode)

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  // The scheduler's event subscription is GLOBAL (main.tsx): the store mirrors
  // the main process even with the view closed (executions finishing, routine
  // created in another window or in the mobile app).

  // Routine removed (here or in another window): back to the list instead of
  // leaving the screen stuck on a detail that no longer exists.
  useEffect(() => {
    if (openId && loaded && !open) setOpen(null)
  }, [openId, loaded, open, setOpen])

  /**
   * Pruning of orphan metrics. The session of an execution may have been
   * deleted from the sidebar (here or in another window) — since the list is
   * derived from the sessions, the surviving record would be invisible and
   * eternal. Running on page open covers both cases with a single rule.
   */
  useEffect(() => {
    if (!loaded || !sessionsLoaded) return
    void prune(sessions.map((s) => s.id))
    // Only on open/load: pruning on every sessions change would write to disk
    // on every message received.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, sessionsLoaded])

  if (!loaded) {
    return <p className="p-6 text-center text-xs text-muted-foreground">{t("routines.loading")}</p>
  }

  if (open) {
    return <RoutineDetail routine={open} onBack={() => setOpen(null)} />
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* With no routine at all the screen is just the empty state with the
          call to create — a header with a button on top of "nothing here"
          would be redundant. */}
      {inMode.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 pb-4">
          <div className="min-w-0 flex-1">
            <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
              {t("routines.title")}
              <span className="inline-flex items-center gap-1 rounded-md border border-transparent bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                {mode === "chat" ? <MessageSquareIcon className="size-3" /> : <TerminalIcon className="size-3" />}
                {mode === "chat" ? t("routines.mode.chat") : t("routines.mode.code")}
              </span>
            </h2>
            <p className="text-xs text-muted-foreground">
              {mode === "chat" ? t("routines.subtitleChat") : t("routines.subtitle")}
            </p>
          </div>
          <Button size="lg" onClick={() => setCreateOpen(true)}>
            <PlusIcon className="size-4" />
            {t("routines.list.new")}
          </Button>
        </div>
      )}

      <RoutineList mode={mode} onCreateNew={() => setCreateOpen(true)} />

      <CreateRoutineDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(id) => setOpen(id)}
        defaultMode={mode}
      />
    </div>
  )
}
