import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { CalendarClockIcon, FolderIcon } from "lucide-react"
import type { Routine, RoutineRun } from "@shared/routines"
import { nextRoutineRun } from "@shared/routines"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { formatWhen } from "@/src/lib/format"
import { useRoutinesStore } from "@/src/stores/routines-store"
import { describeWhen } from "./schedule"
import { ActiveSwitch } from "./schedule-editor"
import { Truncate } from "@/components/ui/truncated-text"

/** Routine list: the cards of the Routines page. The detail lives in routine-detail.tsx. */

// ─── List ────────────────────────────────────────────────────────────────────

/** The search of the page: title, prompt or the schedule as the user reads it. */
export function routineMatches(routine: Routine, query: string, t: TFunction): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    routine.title.toLowerCase().includes(q) ||
    routine.prompt.toLowerCase().includes(q) ||
    describeWhen(routine, t).toLowerCase().includes(q)
  )
}

export function RoutineList({ routines, scope, query, selectedId, onSelect, onCreateNew, onCreateManual }: {
  routines: Routine[]
  scope: "chat" | "code" | "all"
  query: string
  selectedId: string | null
  /** Opens the routine in the side panel. */
  onSelect: (id: string) => void
  /** Starts the creation chat. */
  onCreateNew: () => void
  /** Opens the form instead, for who knows exactly what they want. */
  onCreateManual?: () => void
}) {
  const { t } = useTranslation()

  const sorted = useMemo(
    () => routines.filter((r) => routineMatches(r, query, t)).sort((a, b) => b.createdAt - a.createdAt),
    [routines, query, t],
  )

  if (routines.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <CalendarClockIcon className="size-10 text-muted-foreground/50" />
        <div>
          <p className="text-sm font-medium">{t("routines.list.emptyTitle")}</p>
          <p className="mx-auto max-w-sm text-xs text-muted-foreground">
            {t(scope === "chat" ? "routines.list.emptySubtitleChat" : "routines.list.emptySubtitle")}
          </p>
        </div>
        <Button size="lg" onClick={onCreateNew}>
          <CalendarClockIcon className="size-4" />
          {t("routines.list.createFirst")}
        </Button>
        {onCreateManual && (
          <Button variant="ghost" size="sm" className="text-xs" onClick={onCreateManual}>
            {t("routines.create.viaForm")}
          </Button>
        )}
      </div>
    )
  }

  if (sorted.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
        {t("routines.list.noResults", { query: query.trim() })}
      </p>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-1">
      {sorted.map((routine) => (
        <RoutineCard
          key={routine.id}
          routine={routine}
          selected={routine.id === selectedId}
          onOpen={() => onSelect(routine.id)}
        />
      ))}
    </div>
  )
}

/** The state the card's dot and badges say: what needs the user's eyes first. */
type RoutineState = "running" | "failed" | "paused" | "ok"

function RoutineCard({ routine, selected, onOpen }: {
  routine: Routine
  /** Open in the panel on the right. */
  selected?: boolean
  onOpen: () => void
}) {
  const { t, i18n } = useTranslation()
  const update = useRoutinesStore((s) => s.update)
  const running = useRoutinesStore((s) => s.runs.some((r) => r.routineId === routine.id && r.status === "running"))
  // The last execution failed: the card says so, instead of waiting for the user to open it.
  const failed = useRoutinesStore((s) => {
    let last: RoutineRun | undefined
    for (const r of s.runs) if (r.routineId === routine.id && (!last || r.startedAt > last.startedAt)) last = r
    return last?.status === "error"
  })
  const next = nextRoutineRun(routine)
  const state: RoutineState = running ? "running" : failed ? "failed" : !routine.active ? "paused" : "ok"

  return (
    <div
      className={cn(
        "relative flex items-start gap-2.5 rounded-lg border bg-card px-3.5 py-3 transition-colors hover:border-ring",
        selected && "border-primary/70",
      )}
    >
      {/* The state is a bullet on the far left of the card, like the memories: everything else
          sits in a column beside it, so the lines under the title line up with the title. */}
      <span
        className={cn(
          "mt-[7px] size-2 shrink-0 rounded-full",
          state === "running" && "bg-blue-400",
          state === "failed" && "bg-destructive",
          state === "paused" && "bg-muted-foreground/60",
          state === "ok" && "bg-emerald-500",
        )}
        aria-hidden
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-center gap-2">
          {/* The title is a button that stretches over the whole card; the switch sits above it. */}
          <button
            type="button"
            onClick={onOpen}
            className="min-w-0 flex-1 truncate text-left text-sm font-medium after:absolute after:inset-0 after:content-['']"
          >
            {routine.title}
          </button>
          <span className="relative z-10">
            <ActiveSwitch active={routine.active} onChange={(v) => void update(routine.id, { active: v })} />
          </span>
        </div>

        <Truncate>
          <p className="truncate text-xs text-muted-foreground">{describeWhen(routine, t)}</p>
        </Truncate>

        <div className="flex items-center gap-1.5">
          {routine.folders.length > 0 && (
            <span className="inline-flex max-w-32 shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
              <FolderIcon className="size-2.5 shrink-0" />
              <span className="truncate">{routine.folders[0].split(/[\\/]/).filter(Boolean).pop() ?? routine.folders[0]}</span>
            </span>
          )}
          {state === "running" && (
            <span className="shrink-0 rounded-md bg-blue-500/15 px-1.5 py-px text-[10px] text-blue-600 dark:text-blue-300">
              {t("routines.list.runningNow")}
            </span>
          )}
          {state === "failed" && (
            <span className="shrink-0 rounded-md bg-destructive/10 px-1.5 py-px text-[10px] text-destructive">
              {t("routines.list.failed")}
            </span>
          )}
          {!routine.active && (
            <span className="shrink-0 rounded-md bg-amber-500/15 px-1.5 py-px text-[10px] text-amber-600 dark:text-amber-400">
              {t("routines.list.paused")}
            </span>
          )}
          <span className="flex-1" />
          {next && <span className="shrink-0 text-[11px] text-muted-foreground">{formatWhen(next, i18n.language)}</span>}
        </div>
      </div>
    </div>
  )
}
