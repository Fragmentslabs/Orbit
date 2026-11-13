import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  CalendarClockIcon,
  CheckIcon,
  ChevronRightIcon,
  Loader2,
  PlayIcon,
  Trash2Icon,
  UsersIcon,
  XIcon,
} from "lucide-react"
import { isFinishedOnce, nextRoutineRun, routineRunMessageId, type Routine, type RoutineRun } from "@shared/routines"
import { ConfirmDialog } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useProviderStore } from "@/src/stores/provider-store"
import { formatDuration, formatWhen } from "@/src/lib/format"
import { scrollToMessage } from "@/src/lib/message-jump"
import { useRoutinesStore } from "@/src/stores/routines-store"
import { AgentAvatars } from "./agent-avatars"
import { RescheduleDialog } from "./reschedule-dialog"
import { RoutineSettings } from "./routine-settings"
import { describeWhen } from "./schedule"

/**
 * The routine's information, docked beside its chat the way a fragment's details panel is:
 * the same sidebar column, a header with the close button and two tabs — "Runs" (when it fires
 * again, who works in it and how the last ones ended; clicking a row takes the chat to that
 * execution) and "Settings", which IS the editor: one accordion per group, no dialog.
 *
 * The way in is the gear in the window header (RoutineDetailsButton); this file only draws the
 * column. Overlaid only when there is no room for a second column.
 */

export function RoutineDetailsPanel({
  routine,
  overlaid,
}: {
  routine: Routine
  /** No room for two columns: the panel goes over the chat instead of beside it. */
  overlaid?: boolean
}) {
  const { t, i18n } = useTranslation()
  const toggleDetails = useRoutinesStore((s) => s.toggleDetails)
  const update = useRoutinesStore((s) => s.update)
  const remove = useRoutinesStore((s) => s.remove)
  const runNow = useRoutinesStore((s) => s.runNow)
  const allRuns = useRoutinesStore((s) => s.runs)
  const tab = useRoutinesStore((s) => s.detailsTab)
  const setTab = useRoutinesStore((s) => s.setDetailsTab)
  const [confirming, setConfirming] = useState(false)
  const [rescheduling, setRescheduling] = useState(false)
  const modelName = useProviderStore(
    (s) => s.catalog[routine.model.providerId]?.models[routine.model.modelId]?.name ?? routine.model.modelId,
  )

  const runs = useMemo(
    () => allRuns.filter((r) => r.routineId === routine.id).sort((a, b) => b.startedAt - a.startedAt),
    [allRuns, routine.id],
  )
  const running = runs.some((r) => r.status === "running")
  const next = nextRoutineRun(routine)
  const finished = isFinishedOnce(routine)
  const members = routine.team?.members.map((member) => member.name) ?? []

  // Takes the reading to that execution's MESSAGE in the conversation — opening the window of
  // history if it is above the fold. Every execution has one (see syncRunMessages), so there is
  // nowhere else to open: the answer is read where it happened.
  const jump = (sessionId: string) => {
    void scrollToMessage(routineRunMessageId(sessionId))
  }

  return (
    <aside
      aria-label={t("routines.chat.info")}
      className={cn(
        "z-30 flex w-80 flex-col overflow-hidden rounded-lg bg-sidebar text-sidebar-foreground ring-1 ring-sidebar-border",
        overlaid ? "absolute top-2 right-2 bottom-2 shadow-xl" : "m-2 shrink-0",
      )}
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-sidebar-border/60 px-3">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-sidebar-accent text-sidebar-accent-foreground">
          <CalendarClockIcon className="size-3.5" />
        </span>
        <h2 className="min-w-0 truncate text-sm font-medium">{routine.title}</h2>
        <button
          type="button"
          aria-label={t("common.close")}
          onClick={toggleDetails}
          className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      </header>

      <div className="flex shrink-0 items-center gap-0.5 border-b border-sidebar-border/60 px-2 py-1.5">
        {(["runs", "config"] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={cn(
              "flex-1 rounded-md px-2.5 py-1 text-[11px] transition-colors",
              tab === value
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
            )}
          >
            {t(value === "runs" ? "routines.chat.tabRuns" : "routines.chat.tabConfig")}
          </button>
        ))}
      </div>

      {/* Both stay mounted: a settings change waiting for its autosave survives a tab switch. */}
      <div className={cn("min-h-0 flex-1 overflow-y-auto p-3", tab !== "runs" && "hidden")}>
        <div className="flex flex-col gap-4">
          <section className="flex flex-col gap-1.5">
            <p className="text-[9.5px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t("routines.chat.next")}
            </p>
            <div className="rounded-xl border bg-background/40 px-3 py-2.5">
              <p className="text-[15px] font-semibold leading-tight">
                {next ? formatWhen(next, i18n.language) : t(finished ? "routines.list.finished" : "routines.list.paused")}
              </p>
              <p className="mt-0.5 text-[10.5px] text-muted-foreground">{describeWhen(routine, t)}</p>
              {running && (
                <p className="mt-2 flex items-center gap-1.5 border-t pt-2 text-[10.5px] text-blue-500">
                  <Loader2 className="size-3 animate-spin" />
                  {t("routines.chat.runningNow")}
                </p>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="outline"
                className="h-7 flex-1 px-2 text-[11px]"
                disabled={running}
                onClick={() => void runNow(routine.id)}
              >
                <PlayIcon className="size-3" />
                {t("routines.list.runNow")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 flex-1 px-2 text-[11px]"
                onClick={() => {
                  // A finished one-off has no date left: the dialog picks a new one.
                  if (!routine.active && finished) {
                    setRescheduling(true)
                    return
                  }
                  void update(routine.id, { active: !routine.active })
                }}
              >
                {routine.active ? t("routines.detail.pause") : finished ? t("routines.detail.reschedule") : t("routines.detail.activate")}
              </Button>
            </div>
          </section>

          <section className="flex flex-col gap-1.5">
            <p className="text-[9.5px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t("routines.agents.title")}
            </p>
            <div className="flex items-center gap-2.5">
              {members.length > 0 ? (
                <AgentAvatars names={members} size={24} max={4} />
              ) : (
                <span className="grid size-6 place-items-center rounded-full border-2 border-card bg-muted text-muted-foreground">
                  <UsersIcon className="size-3" />
                </span>
              )}
              <div className="min-w-0">
                <p className="text-[11px] font-medium">
                  {members.length > 0 ? t("routines.chat.agentCount", { count: members.length }) : t("routines.chat.noTeam")}
                </p>
                <p className="truncate text-[10px] text-muted-foreground">
                  {members.length > 0 ? members.join(" · ") : modelName}
                </p>
              </div>
            </div>
          </section>

          <section className="flex flex-col gap-1">
            <p className="text-[9.5px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t("routines.chat.recent")}
            </p>
            {runs.length === 0 ? (
              <p className="px-1 py-2 text-[11px] text-muted-foreground">{t("routines.chat.noRuns")}</p>
            ) : (
              runs.slice(0, 8).map((run) => (
                <RunRow
                  key={run.sessionId}
                  run={run}
                  label={formatWhen(run.startedAt, i18n.language)}
                  onOpen={() => jump(run.sessionId)}
                />
              ))
            )}
          </section>
        </div>
      </div>

      <div className={cn("min-h-0 flex-1 overflow-y-auto", tab !== "config" && "hidden")}>
        <RoutineSettings key={routine.id} routine={routine} />
      </div>

      <footer className="flex shrink-0 items-center border-t border-sidebar-border/60 p-2">
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-full justify-center gap-1.5 text-xs text-destructive hover:text-destructive"
          onClick={() => setConfirming(true)}
        >
          <Trash2Icon className="size-3.5" />
          {t("routines.list.delete")}
        </Button>
      </footer>

      <RescheduleDialog routine={routine} open={rescheduling} onOpenChange={setRescheduling} />

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("routines.list.deleteTitle")}
        description={t("routines.list.deleteDescription", { title: routine.title })}
        confirmLabel={t("routines.list.delete")}
        destructive
        onConfirm={() => void remove(routine.id)}
      />
    </aside>
  )
}

function RunRow({ run, label, onOpen }: { run: RoutineRun; label: string; onOpen: () => void }) {
  const { t } = useTranslation()
  const running = run.status === "running"
  const failed = run.status === "error"
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-accent"
    >
      {running ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-blue-500" />
      ) : failed ? (
        <span className="grid size-3.5 shrink-0 place-items-center rounded-full bg-destructive/15 text-destructive">
          <XIcon className="size-2.5" />
        </span>
      ) : (
        <span className="grid size-3.5 shrink-0 place-items-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
          <CheckIcon className="size-2.5" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11.5px] font-medium">{label}</span>
        <span className="block text-[10px] text-muted-foreground">
          {t(`routines.card.status.${run.status}`)}
          {!running && run.completedAt ? ` · ${formatDuration(run.completedAt - run.startedAt)}` : ""}
        </span>
      </span>
      <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
    </button>
  )
}
