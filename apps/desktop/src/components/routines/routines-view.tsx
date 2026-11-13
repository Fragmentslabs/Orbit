import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { CalendarDaysIcon, ClockIcon, ListIcon, SearchIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { useStacked } from "@/src/hooks/use-stacked"
import { useStartCreationChat } from "@/src/hooks/use-creation-chat"
import { useRoutinesStore } from "@/src/stores/routines-store"
import { useSessionStore } from "@/src/stores/session-store"
import { RoutineList, routineMatches } from "./my-routines"
import { RoutineScreen } from "./routine-screen"
import { RoutinesAgenda } from "./routines-agenda"
import { RoutinesSummary } from "./routines-summary"

type RoutinesLayout = "list" | "agenda"
/**
 * The summary column is fixed (372px, as the design); only when there is no room for it beside
 * the routines (the side panel eats the page) does it go below them.
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
 * Routines page (in the sidebar, in every mode). Two levels, like the pipeline:
 *
 *   routine list  →  [open]  →  the routine's screen (its chat + the floating card)
 *
 * The page is the design of the list: the routines on the left (search, the counts, the rows
 * and the foot line) and, on the right, the general summary — the numbers, the next calls of
 * the whole week and the recent runs. Opening a routine replaces the page with its screen, and
 * "voltar" in the header brings the list back.
 */
export function RoutinesView() {
  const { t } = useTranslation()
  const loaded = useRoutinesStore((s) => s.loaded)
  const load = useRoutinesStore((s) => s.load)
  const routines = useRoutinesStore((s) => s.routines)
  const runs = useRoutinesStore((s) => s.runs)
  const prune = useRoutinesStore((s) => s.prune)
  const sessions = useSessionStore((s) => s.sessions)
  const sessionsLoaded = useSessionStore((s) => s.initialized)
  const startCreation = useStartCreationChat()

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

  // A routine opens ITS OWN screen (the chat takes the page); the list stays behind it, and
  // "voltar" in the header brings it back. The open one lives in the store so the header of the
  // window (App) can show the routine instead of the page title.
  const openId = useRoutinesStore((s) => s.openId)
  const openRoutine = useRoutinesStore((s) => s.open)
  const opened = openId ? routines.find((r) => r.id === openId) : undefined

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

  // One routine open: the page IS its screen (the window header shows the routine).
  if (opened) return <RoutineScreen routine={opened} />

  const filtered = routines.filter((r) => routineMatches(r, query, t))

  // With no routine at all the screen is just the empty state with the call to create — a
  // search field and an empty panel on the side would be noise.
  if (routines.length === 0) {
    return (
      <div ref={setRoot} className="flex min-h-0 flex-1 flex-col">
        <RoutineList
          routines={routines}
          query=""
          selectedId={null}
          onSelect={openRoutine}
          onCreateNew={() => void startCreation("routine")}
        />
      </div>
    )
  }

  const activeCount = routines.filter((r) => r.active).length
  const runningCount = routines.filter((r) => runs.some((run) => run.routineId === r.id && run.status === "running")).length
  const counts = [
    t("routines.list.count", { count: routines.length }),
    t("routines.list.countActive", { count: activeCount }),
    ...(runningCount > 0 ? [t("routines.list.countRunning", { count: runningCount })] : []),
  ].join(" · ")

  return (
    <div ref={setRoot} className={cn("flex min-h-0 flex-1", stacked && "flex-col")}>
      {/* The routines: search, the counts, the rows and the foot line. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border bg-card px-2.5 py-1.5 text-muted-foreground focus-within:ring-1 focus-within:ring-ring">
            <SearchIcon className="size-3.5 shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("routines.list.search")}
              className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
          {/* How the routines are read: the rows, or the week. Two segments, the active one
              lit — a switch, not a button that hides which view it leads to. */}
          <div className="flex shrink-0 items-center rounded-lg border bg-card p-0.5">
            {([
              { view: "list", icon: ListIcon, label: t("routines.view.list") },
              { view: "agenda", icon: CalendarDaysIcon, label: t("routines.view.agenda") },
            ] as const).map(({ view, icon: Icon, label }) => (
              <button
                key={view}
                type="button"
                aria-label={label}
                aria-pressed={layout === view}
                title={label}
                onClick={() => chooseLayout(view)}
                className={cn(
                  "flex size-6 items-center justify-center rounded-md transition-colors",
                  layout === view
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-3.5" />
              </button>
            ))}
          </div>
        </div>

        {layout === "list" ? (
          <>
            <p className="shrink-0 px-3.5 pb-1 pt-2.5 text-[10px] text-muted-foreground/70">{counts}</p>
            <RoutineList
              routines={routines}
              query={query}
              selectedId={null}
              onSelect={openRoutine}
              onCreateNew={() => void startCreation("routine")}
            />
            <p className="flex shrink-0 items-center gap-1.5 border-t px-3.5 py-2.5 text-[10px] text-muted-foreground/60">
              <ClockIcon className="size-3 shrink-0" />
              {t("routines.list.tail")}
            </p>
          </>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col p-3">
            <RoutinesAgenda routines={filtered} selectedId={null} onSelect={openRoutine} />
          </div>
        )}
      </div>

      {/* The general summary: numbers, the week ahead and the recent runs. It never goes away:
          it narrows, and when even that does not fit it goes below the routines. */}
      <aside
        className={cn(
          "flex min-h-0 flex-col",
          stacked ? "max-h-[45%] shrink-0 border-t px-3 pt-3" : "w-60 shrink-0 border-l px-3",
        )}
      >
        <RoutinesSummary routines={routines} onSelect={openRoutine} onShowAll={() => chooseLayout("agenda")} />
      </aside>
    </div>
  )
}
