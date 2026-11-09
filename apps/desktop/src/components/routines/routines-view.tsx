import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { MessageSquarePlusIcon, PenLineIcon, PlusIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { useWorkspace } from "@/lib/workspace-context"
import { useStacked } from "@/src/hooks/use-stacked"
import { useStartCreationChat } from "@/src/hooks/use-creation-chat"
import { ListToolbar } from "@/src/components/list-toolbar"
import { useViewScope } from "@/src/stores/view-scope-store"
import { useRoutinesStore } from "@/src/stores/routines-store"
import { ORPHAN_KEY, usePanelStore } from "@/src/stores/panel-store"
import { useActiveSession, useSessionStore } from "@/src/stores/session-store"
import { CreateRoutineDialog } from "./create-routine-dialog"
import { RoutineList, routineMatches } from "./my-routines"
import { RoutinesAgenda } from "./routines-agenda"
import { RoutinesStatsBar } from "./routines-stats"
import { RoutinesSummary } from "./routines-summary"

type RoutinesLayout = "list" | "agenda"
/**
 * The summary column follows the width of the page continuously, and only when there is no room
 * for it beside the routines (less than 640px: the side panel eats the page, not only the window)
 * does it go below them.
 */
const STACK_BELOW_PX = 640

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
  const startCreation = useStartCreationChat()

  // What the page lists is chosen in the header (chat, code or both); until then it follows
  // the workspace mode, as it always did.
  const [scope] = useViewScope("routines", mode)
  const [query, setQuery] = useState("")
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const stacked = useStacked(root, STACK_BELOW_PX)
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
          onCreateNew={() => void startCreation("routine")}
          onCreateManual={() => setCreateOpen(true)}
        />
        {dialog}
      </div>
    )
  }

  return (
    <div ref={setRoot} className={cn("flex min-h-0 flex-1", stacked ? "flex-col gap-3" : "gap-4")}>
      {/* The routines, as a list or as the week; the toggle sits with the search. */}
      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", !stacked && "border-r pr-4")}>
        <ListToolbar
          query={query}
          onQueryChange={setQuery}
          placeholder={t("routines.list.search")}
          actionLabel={t("routines.list.new")}
          actionIcon={PlusIcon}
          onAction={() => void startCreation("routine")}
          actionOptions={[
            {
              id: "chat",
              icon: MessageSquarePlusIcon,
              title: t("routines.create.viaChat"),
              description: t("routines.create.viaChatHint"),
              onSelect: () => void startCreation("routine"),
            },
            {
              id: "form",
              icon: PenLineIcon,
              title: t("routines.create.viaForm"),
              description: t("routines.create.viaFormHint"),
              onSelect: () => setCreateOpen(true),
            },
          ]}
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
            onCreateNew={() => void startCreation("routine")}
            onCreateManual={() => setCreateOpen(true)}
          />
        ) : (
          <RoutinesAgenda routines={filtered} selectedId={openedId ?? null} onSelect={openRoutine} />
        )}
        {/* Narrow page: the numbers go under the list, with a line before the summary strip. */}
        {stacked && (
          <div className="mt-2.5 shrink-0">
            <RoutinesStatsBar routines={inScope} separated />
          </div>
        )}
      </div>

      {/* How the routines are doing and what is next; a routine opens in the side panel. It never
          goes away: it narrows, and when even that does not fit it goes below the routines. */}
      {stacked ? (
        <div className="max-h-[40%] shrink-0 overflow-y-auto">
          <RoutinesSummary routines={inScope} variant="strip" onSelect={openRoutine} />
        </div>
      ) : (
        // Its width follows the page continuously (17rem to 27rem), so there is nothing to wait for.
        <div className="@container flex min-h-0 w-[clamp(17rem,40%,27rem)] shrink-0 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <RoutinesSummary routines={inScope} onSelect={openRoutine} />
          </div>
          {/* Fixed at the bottom of the column: the summary scrolls, the numbers stay. */}
          <div className="mt-2.5 shrink-0">
            <RoutinesStatsBar routines={inScope} />
          </div>
        </div>
      )}
      {dialog}
    </div>
  )
}
