import { useEffect, useLayoutEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { PlusIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { useWorkspace } from "@/lib/workspace-context"
import { ListToolbar } from "@/src/components/list-toolbar"
import { useViewScope } from "@/src/stores/view-scope-store"
import { useRoutinesStore } from "@/src/stores/routines-store"
import { ORPHAN_KEY, usePanelStore } from "@/src/stores/panel-store"
import { useActiveSession, useSessionStore } from "@/src/stores/session-store"
import { CreateRoutineDialog } from "./create-routine-dialog"
import { RoutineList, routineMatches } from "./my-routines"
import { RoutinesAgenda } from "./routines-agenda"
import { RoutinesSummary } from "./routines-summary"

/**
 * Routines page (in the sidebar, of the chat and code modes). Two levels, like
 * the pipeline:
 *
 *   routine list  →  [open]  →  routine detail (executed sessions)
 *
 * The header chooses what the page lists: the chat routines, the code ones or both (until the
 * user picks, it follows the workspace mode). Creating is a MODAL, not a tab: the
 * page is the list, and creating is an action on it. In the detail the list
 * header disappears — whoever is there is inside ONE routine, and the header
 * is that routine's.
 */
type RoutinesLayout = "list" | "agenda"
/** What the toggle can show: the two layouts, plus the summary when there is no room beside it. */
type RoutinesPane = RoutinesLayout | "summary"

/** Below this width of the page the summary stops sitting beside the routines. */
const WIDE_PX = 960

/** Whether the page has room for two columns — its own width, not the window's: the side panel eats it. */
function useIsWide(element: HTMLElement | null): boolean {
  const [wide, setWide] = useState(true)
  useLayoutEffect(() => {
    if (!element) return
    const measure = () => setWide(element.clientWidth >= WIDE_PX)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  return wide
}
const LAYOUT_KEY = "orbit-routines-layout"

function savedLayout(): RoutinesLayout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "agenda" ? "agenda" : "list"
  } catch {
    return "list"
  }
}

export function RoutinesView() {
  const { t } = useTranslation()
  const { mode } = useWorkspace()
  const loaded = useRoutinesStore((s) => s.loaded)
  const load = useRoutinesStore((s) => s.load)
  const routines = useRoutinesStore((s) => s.routines)
  const prune = useRoutinesStore((s) => s.prune)
  const sessions = useSessionStore((s) => s.sessions)
  const sessionsLoaded = useSessionStore((s) => s.initialized)
  const [createOpen, setCreateOpen] = useState(false)

  // What the page lists is chosen in the header (chat, code or both); until then it follows
  // the workspace mode, as it always did.
  const [scope] = useViewScope("routines", mode)
  const [query, setQuery] = useState("")
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const wide = useIsWide(root)
  const [summaryOnly, setSummaryOnly] = useState(false)
  // List or agenda: the choice is remembered between sessions.
  const [layout, setLayout] = useState<RoutinesLayout>(savedLayout)
  const chooseLayout = (next: RoutinesLayout) => {
    setLayout(next)
    try {
      localStorage.setItem(LAYOUT_KEY, next)
    } catch {
      /* private mode: the choice just does not stick */
    }
  }
  const inScope = routines.filter((r) => scope === "all" || r.mode === scope)

  // A routine opens as a tab of the side panel (the panel of the active conversation, like
  // the memories): the page keeps the list or the agenda and the summary, and the tab has the
  // room of the panel, which resizes. The highlighted routine is the one whose tab is active.
  const panelKey = useActiveSession(mode)?.id ?? ORPHAN_KEY
  const openRoutineTab = usePanelStore((s) => s.openRoutineTab)
  const openedId = usePanelStore((s) => {
    const active = s.activeTabBySession[panelKey]
    return s.tabsBySession[panelKey]?.find((tab) => tab.id === active && tab.type === "routine")?.routineId
  })
  const openRoutine = (id: string) => {
    const routine = routines.find((r) => r.id === id)
    if (routine) openRoutineTab(panelKey, { routineId: id, title: routine.title })
  }

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  // The scheduler's event subscription is GLOBAL (main.tsx): the store mirrors
  // the main process even with the view closed (executions finishing, routine
  // created in another window or in the mobile app).

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

  const filtered = inScope.filter((r) => routineMatches(r, query, t))

  const dialog = (
    <CreateRoutineDialog
      open={createOpen}
      onOpenChange={setCreateOpen}
      onCreated={openRoutine}
      defaultMode={scope === "all" ? mode : scope}
    />
  )

  // With no routine at all the screen is just the empty state with the call to create — a
  // search field and an empty panel on the side would be noise.
  if (inScope.length === 0) {
    return (
      <div ref={setRoot} className="flex min-h-0 flex-1 flex-col">
        <RoutineList
          routines={inScope}
          scope={scope}
          query=""
          selectedId={null}
          onSelect={openRoutine}
          onCreateNew={() => setCreateOpen(true)}
        />
        {dialog}
      </div>
    )
  }

  // Wide: the routines on the left and the summary on the right. Narrow (the side panel is
  // open, or the window is small): one column, and the summary becomes a third view of the
  // same toggle, so nothing is squeezed and nothing is lost.
  const view: RoutinesPane = !wide && summaryOnly ? "summary" : layout
  const chooseView = (next: RoutinesPane) => {
    if (next === "summary") {
      setSummaryOnly(true)
      return
    }
    setSummaryOnly(false)
    chooseLayout(next)
  }
  const options: { value: RoutinesPane; label: string }[] = [
    { value: "list", label: t("routines.view.list") },
    { value: "agenda", label: t("routines.view.agenda") },
    ...(wide ? [] : [{ value: "summary" as const, label: t("routines.view.summary") }]),
  ]

  return (
    <div ref={setRoot} className={cn("flex min-h-0 flex-1 gap-4", !wide && "flex-col gap-0")}>
      {/* The routines, as a list or as the week; the toggle sits with the search. */}
      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", wide && "border-r pr-4")}>
        <ListToolbar
          query={query}
          onQueryChange={setQuery}
          placeholder={t("routines.list.search")}
          actionLabel={t("routines.list.new")}
          actionIcon={PlusIcon}
          onAction={() => setCreateOpen(true)}
        >
          <SegmentedControl<RoutinesPane> size="sm" value={view} onChange={chooseView} options={options} />
        </ListToolbar>
        {view === "summary" ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <RoutinesSummary routines={inScope} onSelect={openRoutine} />
          </div>
        ) : view === "list" ? (
          <RoutineList
            routines={inScope}
            scope={scope}
            query={query}
            selectedId={openedId ?? null}
            onSelect={openRoutine}
            onCreateNew={() => setCreateOpen(true)}
          />
        ) : (
          <RoutinesAgenda routines={filtered} selectedId={openedId ?? null} onSelect={openRoutine} />
        )}
      </div>

      {/* How the routines are doing and what is next; a routine opens in the side panel. */}
      {wide && (
        <div className="flex min-h-0 w-[27rem] shrink-0 flex-col overflow-y-auto">
          <RoutinesSummary routines={inScope} onSelect={openRoutine} />
        </div>
      )}
      {dialog}
    </div>
  )
}
