import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import {
  CalendarClockIcon,
  Ellipsis,
  Loader2,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  Trash2Icon,
} from "lucide-react"
import type { Routine, RoutineRun } from "@shared/routines"
import { isFinishedOnce, nextRoutineRun } from "@shared/routines"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/alert-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { formatWhen } from "@/src/lib/format"
import { useRoutinesStore } from "@/src/stores/routines-store"
import { AgentAvatars } from "./agent-avatars"
import { describeWhen } from "./schedule"
import { RescheduleDialog } from "./reschedule-dialog"

/** Routine list: the rows of the Routines page. The screen lives in routine-screen.tsx. */

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

export function RoutineList({ routines, query, selectedId, onSelect, onCreateNew }: {
  routines: Routine[]
  query: string
  selectedId: string | null
  /** Opens the routine's screen (the page becomes its chat). */
  onSelect: (id: string) => void
  /** Starts the creation chat. */
  onCreateNew: () => void
}) {
  const { t } = useTranslation()

  const sorted = useMemo(
    () => routines.filter((r) => routineMatches(r, query, t)).sort((a, b) => b.createdAt - a.createdAt),
    [routines, query, t],
  )

  if (routines.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <CalendarClockIcon className="size-10 text-muted-foreground/50" />
        <div>
          <p className="text-sm font-medium">{t("routines.list.emptyTitle")}</p>
          <p className="mx-auto max-w-sm text-xs text-muted-foreground">
            {t("routines.list.emptySubtitle")}
          </p>
        </div>
        <Button size="lg" onClick={onCreateNew}>
          <CalendarClockIcon className="size-4" />
          {t("routines.list.createFirst")}
        </Button>
      </div>
    )
  }

  if (sorted.length === 0) {
    // The message fills the rest of the list: without flex-1 the foot line of the page
    // would rise up to right below it whenever the search finds nothing.
    return (
      <div className="flex min-h-0 flex-1 flex-col p-3">
        <p className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
          {t("routines.list.noResults", { query: query.trim() })}
        </p>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-1">
      {sorted.map((routine) => (
        <RoutineRow
          key={routine.id}
          routine={routine}
          selected={routine.id === selectedId}
          onOpen={() => onSelect(routine.id)}
        />
      ))}
    </div>
  )
}

/** What the leading icon and the pill say: what needs the user's eyes first. */
type RoutineState = "running" | "failed" | "finished" | "paused" | "ok"

/**
 * One routine, as the row of the page: the state on the left, the name and when it runs in the
 * middle, the team and the next call on the right, and one pill. The whole row opens the
 * routine's screen; the pill is the state, and the options button appears beside it on hover —
 * the pill stays and the row shifts left to make room (the button acts on the row, it does not
 * open it).
 */
function RoutineRow({ routine, selected, onOpen }: {
  routine: Routine
  selected?: boolean
  onOpen: () => void
}) {
  const { t, i18n } = useTranslation()
  const update = useRoutinesStore((s) => s.update)
  const remove = useRoutinesStore((s) => s.remove)
  const openSettings = useRoutinesStore((s) => s.openSettings)
  const [menuOpen, setMenuOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [rescheduling, setRescheduling] = useState(false)
  const running = useRoutinesStore((s) => s.runs.some((r) => r.routineId === routine.id && r.status === "running"))
  // The last execution failed: the row says so, instead of waiting for the user to open it.
  const failed = useRoutinesStore((s) => {
    let last: RoutineRun | undefined
    for (const r of s.runs) if (r.routineId === routine.id && (!last || r.startedAt > last.startedAt)) last = r
    return last?.status === "error"
  })
  const next = nextRoutineRun(routine)
  // A one-off that already ran is finished, not paused: the scheduler turned it off, the user did not.
  const finished = isFinishedOnce(routine)
  const state: RoutineState = running ? "running" : failed ? "failed" : finished ? "finished" : !routine.active ? "paused" : "ok"
  const members = routine.team?.members.map((member) => member.name) ?? []
  const folder = routine.folders[0]?.split(/[\\/]/).filter(Boolean).pop()
  const label =
    state === "running" ? t("routines.list.running")
      : state === "failed" ? t("routines.list.failedShort")
        : state === "finished" ? t("routines.list.finished")
          : state === "paused" ? t("routines.list.paused")
            : t("routines.list.active")

  return (
    <div
      className={cn(
        "group relative flex items-center gap-3 rounded-[10px] border px-3 py-[11px] transition-colors",
        selected ? "border-border bg-card" : "border-transparent hover:bg-accent",
      )}
    >
      <span
        className={cn(
          "grid size-[31px] shrink-0 place-items-center rounded-[9px]",
          state === "running" && "bg-blue-500/13 text-blue-500",
          state === "failed" && "bg-destructive/13 text-destructive",
          state === "finished" && "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
          (state === "paused" || state === "ok") && "bg-muted/60 text-muted-foreground",
        )}
      >
        {state === "running" ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <CalendarClockIcon className="size-3.5" />
        )}
      </span>

      <div className="flex min-w-0 flex-1 flex-col">
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 truncate text-left text-[12.5px] font-semibold after:absolute after:inset-0 after:content-['']"
        >
          {routine.title}
        </button>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10.5px] text-muted-foreground">
          <span className="truncate">{describeWhen(routine, t)}</span>
          {folder && (
            <>
              <span className="shrink-0 text-muted-foreground/40">·</span>
              <span className="truncate">{t("routines.list.folder", { name: folder })}</span>
            </>
          )}
        </div>
      </div>

      {members.length > 0 && (
        <AgentAvatars names={members} size={20} className="pointer-events-none relative z-10" />
      )}

      <div className="hidden shrink-0 text-right sm:block">
        <div className="text-[9px] uppercase tracking-[0.07em] text-muted-foreground/60">
          {t("routines.list.nextLabel")}
        </div>
        <div className="mt-0.5 whitespace-nowrap text-[10.5px] text-muted-foreground">
          {next ? formatWhen(next, i18n.language) : "—"}
        </div>
      </div>

      <div className="relative z-10 flex shrink-0 items-center justify-end gap-1">
        <span
          className={cn(
            "inline-flex min-w-[66px] items-center justify-center gap-1 rounded-full border px-1.5 py-0.5 text-[9.5px]",
            state === "running" && "border-blue-500/30 text-blue-500",
            state === "failed" && "border-destructive/30 text-destructive",
            state === "finished" && "border-emerald-500/30 text-emerald-600 dark:text-emerald-400",
            state === "paused" && "border-border text-muted-foreground/60",
            state === "ok" && "border-border text-muted-foreground",
          )}
        >
          {state === "running" && <Loader2 className="size-2.5 animate-spin" />}
          {state === "ok" && <span className="size-[5px] rounded-full bg-emerald-500" />}
          {state === "failed" && <span className="size-[5px] rounded-full bg-destructive" />}
          {state === "finished" && <span className="size-[5px] rounded-full bg-emerald-500" />}
          {state === "paused" && <span className="size-[5px] rounded-full bg-muted-foreground/40" />}
          {label}
        </span>
        {/* The options button: it grows from nothing and pushes the row left; the pill never leaves. */}
        <span
          className={cn(
            "flex items-center overflow-hidden transition-all duration-200 focus-within:w-6 focus-within:opacity-100",
            menuOpen ? "w-6 opacity-100" : "w-0 opacity-0 group-hover:w-6 group-hover:opacity-100",
          )}
        >
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger
              aria-label={t("routines.list.options")}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Ellipsis className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem
                onClick={() => {
                  // A finished one-off has no date left to resume: the dialog picks a new one.
                  if (!routine.active && finished) {
                    setRescheduling(true)
                    return
                  }
                  void update(routine.id, { active: !routine.active })
                }}
              >
                {routine.active ? <PauseIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
                {routine.active ? t("routines.detail.pause") : finished ? t("routines.detail.reschedule") : t("routines.detail.activate")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => openSettings(routine.id)}>
                <PencilIcon className="size-3.5" />
                {t("routines.list.edit")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
                <Trash2Icon className="size-3.5" />
                {t("routines.list.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>

      <RescheduleDialog routine={routine} open={rescheduling} onOpenChange={setRescheduling} />

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t("routines.list.deleteTitle")}
        description={t("routines.list.deleteDescription", { title: routine.title })}
        confirmLabel={t("routines.list.delete")}
        destructive
        onConfirm={() => void remove(routine.id)}
      />
    </div>
  )
}
