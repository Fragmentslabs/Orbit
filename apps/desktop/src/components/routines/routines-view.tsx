import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { PlusIcon } from "lucide-react"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { useWorkspace } from "@/lib/workspace-context"
import { ListToolbar } from "@/src/components/list-toolbar"
import { useViewScope } from "@/src/stores/view-scope-store"
import { useRoutinesStore } from "@/src/stores/routines-store"
import { useSessionStore } from "@/src/stores/session-store"
import { CreateRoutineDialog } from "./create-routine-dialog"
import { RoutineDetail, RoutineList, routineMatches } from "./my-routines"
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
  const openId = useRoutinesStore((s) => s.openId)
  const setOpen = useRoutinesStore((s) => s.setOpen)
  const sessions = useSessionStore((s) => s.sessions)
  const sessionsLoaded = useSessionStore((s) => s.initialized)
  const [createOpen, setCreateOpen] = useState(false)

  // What the page lists is chosen in the header (chat, code or both); until then it follows
  // the workspace mode, as it always did.
  const [scope] = useViewScope("routines", mode)
  const [query, setQuery] = useState("")
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
  const open = openId ? inScope.find((r) => r.id === openId) : undefined

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

  const filtered = inScope.filter((r) => routineMatches(r, query, t))

  const dialog = (
    <CreateRoutineDialog
      open={createOpen}
      onOpenChange={setCreateOpen}
      onCreated={(id) => setOpen(id)}
      defaultMode={scope === "all" ? mode : scope}
    />
  )

  // With no routine at all the screen is just the empty state with the call to create — a
  // search field and an empty panel on the side would be noise.
  if (inScope.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <RoutineList
          routines={inScope}
          scope={scope}
          query=""
          selectedId={null}
          onSelect={setOpen}
          onCreateNew={() => setCreateOpen(true)}
        />
        {dialog}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 gap-4">
      {/* Left: the routines, as a list or as the week; the toggle sits with the search. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col border-r pr-4">
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
            selectedId={open?.id ?? null}
            onSelect={setOpen}
            onCreateNew={() => setCreateOpen(true)}
          />
        ) : (
          <RoutinesAgenda routines={filtered} selectedId={open?.id ?? null} onSelect={(id) => setOpen(id === open?.id ? null : id)} />
        )}
      </div>

      {/* Right: the routine that is open, or — with none — how they are doing and what is next. */}
      <div className="flex min-h-0 w-[27rem] max-w-[45%] shrink-0 flex-col overflow-y-auto">
        {open ? (
          <RoutineDetail key={open.id} routine={open} onClose={() => setOpen(null)} />
        ) : (
          <RoutinesSummary routines={inScope} onSelect={setOpen} />
        )}
      </div>
      {dialog}
    </div>
  )
}
