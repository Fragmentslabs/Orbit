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

type RoutinesLayout = "list" | "agenda"
/**
 * The page has three sizes, by ITS OWN width (the side panel eats it, not only the window):
 * wide (the summary column beside the routines), medium (a narrower, compact one) and narrow
 * (the summary below the routines).
 */
type Tier = "wide" | "medium" | "narrow"
const WIDE_PX = 960
const MEDIUM_PX = 640

function useTier(element: HTMLElement | null): Tier {
  const [tier, setTier] = useState<Tier>("wide")
  useLayoutEffect(() => {
    if (!element) return
    const measure = () => {
      const width = element.clientWidth
      setTier(width >= WIDE_PX ? "wide" : width >= MEDIUM_PX ? "medium" : "narrow")
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  return tier
}
const LAYOUT_KEY = "orbit-routines-layout"

function savedLayout(): RoutinesLayout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "agenda" ? "agenda" : "list"
  } catch {
    return "list"
  }
}

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
  const tier = useTier(root)
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

  return (
    <div ref={setRoot} className={cn("flex min-h-0 flex-1", tier === "narrow" ? "flex-col gap-3" : "gap-4")}>
      {/* The routines, as a list or as the week; the toggle sits with the search. */}
      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", tier !== "narrow" && "border-r pr-4")}>
        <ListToolbar
          query={query}
          onQueryChange={setQuery}
          placeholder={t("routines.list.search")}
          actionLabel={t("routines.list.new")}
          actionIcon={PlusIcon}
          onAction={() => setCreateOpen(true)}
        >
          <SegmentedControl<RoutinesLayout>
            size="sm"
            value={layout}
            onChange={chooseLayout}
            options={[
              { value: "list", label: t("routines.view.list") },
              { value: "agenda", label: t("routines.view.agenda") },
            ]}
          />
        </ListToolbar>
        {layout === "list" ? (
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

      {/* How the routines are doing and what is next; a routine opens in the side panel. It never
          goes away: it narrows, and when even that does not fit it goes below the routines. */}
      {tier === "narrow" ? (
        <div className="max-h-[40%] shrink-0 overflow-y-auto">
          <RoutinesSummary routines={inScope} variant="strip" onSelect={openRoutine} />
        </div>
      ) : (
        <div className={cn("flex min-h-0 shrink-0 flex-col overflow-y-auto", tier === "wide" ? "w-[27rem]" : "w-[17rem]")}>
          <RoutinesSummary routines={inScope} variant={tier === "wide" ? "full" : "side"} onSelect={openRoutine} />
        </div>
      )}
      {dialog}
    </div>
  )
}
