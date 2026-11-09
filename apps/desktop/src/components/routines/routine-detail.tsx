import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  FolderIcon,
  FolderOpenIcon,
  Loader2,
  MoreHorizontalIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"
import type { SessionInfo } from "@shared/chat"
import { isScriptTriggered, nextRoutineRun, ROUTINE_CHAT_MODES, scriptApproved, type Routine, type RoutineRun } from "@shared/routines"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/alert-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Truncate } from "@/components/ui/truncated-text"
import { cn } from "@/lib/utils"
import { routinesApi } from "@/src/lib/ipc"
import { useStartChatWith } from "@/src/hooks/use-creation-chat"
import { formatCost, formatDuration, formatWhen } from "@/src/lib/format"
import { routineStats } from "@/src/lib/routine-stats"
import { useProviderStore } from "@/src/stores/provider-store"
import { useRoutinesStore } from "@/src/stores/routines-store"
import { useSessionStore } from "@/src/stores/session-store"
import { EditRoutineDialog } from "./edit-routine-dialog"
import { LastResult } from "./last-result"
import { ScriptActivityCard } from "./script-activity"
import { ScriptCard } from "./script-card"
import { describeWhen } from "./schedule"
import { ModeBadges } from "./schedule-editor"
import { useOpenRun } from "./use-open-run"

/**
 * Routine detail, in the side panel: a header with the actions and three tabs. The overview is
 * what the person comes for (the last answer, the numbers, the latest runs); the runs tab is the
 * whole history; the configuration tab is what the routine is made of.
 *
 * The execution list is DERIVED from the chat sessions (`routineId`), with the metrics from
 * `runs` matched by sessionId: deleting the session in the sidebar removes the row here without
 * leaving a "deleted" record behind.
 */

type DetailTab = "overview" | "runs" | "scripts" | "config"
/** How many runs the overview lists before sending to the runs tab. */
const RECENT_RUNS = 3

/** One execution; `steps` are the chats its workers ran in (a routine with a team). */
type Execution = { session: SessionInfo; run?: RoutineRun; steps: SessionInfo[] }

export function RoutineDetail({ routine, onClose }: { routine: Routine; /** Absent when the container already has its own close (the side panel tab). */ onClose?: () => void }) {
  const { t, i18n } = useTranslation()
  const update = useRoutinesStore((s) => s.update)
  const runNow = useRoutinesStore((s) => s.runNow)
  const remove = useRoutinesStore((s) => s.remove)
  const allRuns = useRoutinesStore((s) => s.runs)
  const approveScript = useRoutinesStore((s) => s.approveScript)
  const removeScript = useRoutinesStore((s) => s.removeScript)
  const startChat = useStartChatWith()
  const activity = useRoutinesStore((s) => s.activity[routine.id])
  const sessions = useSessionStore((s) => s.sessions)
  const modelName = useProviderStore(
    (s) => s.catalog[routine.model.providerId]?.models[routine.model.modelId]?.name ?? routine.model.modelId,
  )
  const [tab, setTab] = useState<DetailTab>("overview")
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const runs = useMemo(() => allRuns.filter((r) => r.routineId === routine.id), [allRuns, routine.id])
  const running = runs.some((r) => r.status === "running")
  const executions: Execution[] = useMemo(() => {
    const metrics = new Map(runs.map((r) => [r.sessionId, r]))
    return sessions
      .filter((s) => s.routineId === routine.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((session) => ({
        session,
        run: metrics.get(session.id),
        steps: sessions.filter((s) => s.parentId === session.id).sort((a, b) => a.createdAt - b.createdAt),
      }))
  }, [sessions, runs, routine.id])
  const stats = useMemo(() => routineStats(runs, Date.now()), [runs])
  const next = nextRoutineRun(routine)
  const available = routine.mode === "chat" ? ROUTINE_CHAT_MODES : undefined

  const scripts = routine.scripts ?? []
  const watched = isScriptTriggered(routine)
  const unapproved = scripts.filter((s) => !scriptApproved(s)).length

  const numbers = [
    {
      label: t("routines.detail.next"),
      value: watched ? t("routines.scripts.whenItFires") : next ? formatWhen(next, i18n.language) : t("routines.list.paused"),
    },
    {
      label: t("routines.detail.success"),
      value: stats.successRate === null ? "—" : `${Math.round(stats.successRate * 100)}%`,
    },
    { label: t("routines.detail.averageCost"), value: stats.averageCost === null ? "—" : formatCost(stats.averageCost) },
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-col gap-2">
        <div className="flex items-start gap-1.5">
          <h2 className="flex min-w-0 flex-1 items-start gap-2 break-words text-[17px] font-semibold leading-snug text-foreground">
            <span className="line-clamp-2 min-w-0">{routine.title}</span>
            {running && <Loader2 className="mt-1 size-3.5 shrink-0 animate-spin text-primary" />}
          </h2>
          <Button size="sm" variant="outline" disabled={running} onClick={() => void runNow(routine.id)}>
            <PlayIcon className="size-3.5" />
            {t("routines.list.runNow")}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
              <MoreHorizontalIcon className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuItem onClick={() => void update(routine.id, { active: !routine.active })}>
                {routine.active ? <PauseIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
                {routine.active ? t("routines.detail.pause") : t("routines.detail.activate")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setEditing(true)}>
                <PencilIcon className="size-3.5" />
                {t("routines.list.edit")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setConfirming(true)}>
                <Trash2Icon className="size-3.5" />
                {t("routines.list.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {onClose && (
            <Button variant="ghost" size="icon-sm" className="size-8" onClick={onClose} aria-label={t("routines.detail.close")}>
              <XIcon className="size-4" />
            </Button>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {!routine.active && <Chip>{t("routines.list.paused")}</Chip>}
          <Chip>{describeWhen(routine, t)}</Chip>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as DetailTab)} className="min-h-0 flex-1 gap-3">
        <TabsList variant="line" className="shrink-0 border-b">
          <TabsTrigger value="overview">{t("routines.detail.overview")}</TabsTrigger>
          <TabsTrigger value="runs">
            {t("routines.runs.title")}
            <span className="text-[10px] tabular-nums text-muted-foreground">{executions.length}</span>
          </TabsTrigger>
          {scripts.length > 0 && (
            <TabsTrigger value="scripts">
              {t("routines.scripts.tab")}
              <span className={cn("text-[10px] tabular-nums", unapproved > 0 ? "text-amber-600" : "text-muted-foreground")}>{scripts.length}</span>
            </TabsTrigger>
          )}
          <TabsTrigger value="config">{t("routines.detail.config")}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="flex min-h-0 flex-col gap-3 overflow-y-auto">
          {watched && <ScriptActivityCard activity={activity} />}
          <LastResult run={stats.last} />
          <div className="grid shrink-0 grid-cols-3 gap-2">
            {numbers.map((n) => (
              <div key={n.label} className="min-w-0 rounded-lg border bg-card px-3 py-2.5">
                <p className="text-[11px] text-muted-foreground">{n.label}</p>
                <p className="mt-0.5 break-words text-[13px] font-medium leading-snug">{n.value}</p>
              </div>
            ))}
          </div>
          {executions.length > 0 && (
            <div className="overflow-hidden rounded-lg border bg-card">
              <div className="flex items-center px-4 py-2.5">
                <p className="flex-1 text-[13px] font-semibold">{t("routines.detail.recent")}</p>
                {executions.length > RECENT_RUNS && (
                  <button
                    type="button"
                    onClick={() => setTab("runs")}
                    className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
                  >
                    {t("routines.detail.seeAll")}
                  </button>
                )}
              </div>
              {executions.slice(0, RECENT_RUNS).map(({ session, run, steps }) => (
                <RunRow key={session.id} session={session} run={run} steps={steps} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="runs" className="min-h-0 overflow-y-auto">
          {executions.length === 0 ? (
            <p className="rounded-lg border border-dashed px-4 py-5 text-center text-xs text-muted-foreground">{t("routines.runs.empty")}</p>
          ) : (
            <div className="overflow-hidden rounded-lg border bg-card">
              {executions.map(({ session, run, steps }) => (
                <RunRow key={session.id} session={session} run={run} steps={steps} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="scripts" className="flex min-h-0 flex-col gap-3 overflow-y-auto">
          {scripts.map((script) => (
            <ScriptCard
              key={script.id}
              script={script}
              trigger={routine.trigger?.kind === "script" && routine.trigger.scriptId === script.id}
              onApprove={() => void approveScript(routine.id, script.id)}
              onTest={() => routinesApi.testScript(routine.id, script.id)}
              onEdit={() =>
                void startChat(
                  t("routines.scripts.editTitle", { script: script.name }),
                  t("routines.scripts.editStarter", { script: script.name, routine: routine.title, id: routine.id }),
                )
              }
              onRemove={
                routine.trigger?.kind === "script" && routine.trigger.scriptId === script.id
                  ? undefined
                  : () => void removeScript(routine.id, script.id)
              }
            />
          ))}
        </TabsContent>

        <TabsContent value="config" className="flex min-h-0 flex-col gap-3 overflow-y-auto">
          <div className="rounded-lg border bg-card px-4 py-3.5">
            <p className="mb-1.5 text-[11px] text-muted-foreground">{t("routines.detail.what")}</p>
            <RoutinePrompt text={routine.prompt} />
            <div className="mt-2.5">
              <ModeBadges modes={routine.modes} permission available={available} />
            </div>
          </div>
          <div className="flex flex-col gap-2 rounded-lg border bg-card px-4 py-3.5 text-xs">
            <ConfigRow label={t("routines.detail.when")}>{describeWhen(routine, t)}</ConfigRow>
            <ConfigRow label={t("routines.detail.model")}>{modelName}</ConfigRow>
            <ConfigRow label={t("routines.detail.folders")}>
              {routine.folders.length === 0 ? (
                <span className="text-muted-foreground">{t("proposal.noFolder")}</span>
              ) : (
                <span className="flex flex-col gap-1">
                  {routine.folders.map((folder) => (
                    <Truncate key={folder} text={folder}>
                      <span className="flex items-center gap-1.5">
                        <FolderIcon className="size-3 shrink-0" />
                        <span className="truncate">{folder.split(/[\\/]/).filter(Boolean).pop() ?? folder}</span>
                      </span>
                    </Truncate>
                  ))}
                </span>
              )}
            </ConfigRow>
          </div>
          <Button variant="outline" size="sm" className="self-start" onClick={() => setEditing(true)}>
            <PencilIcon className="size-3.5" />
            {t("routines.list.edit")}
          </Button>
        </TabsContent>
      </Tabs>

      <EditRoutineDialog routine={routine} open={editing} onOpenChange={setEditing} />
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("routines.list.deleteTitle")}
        description={t("routines.list.deleteDescription", { title: routine.title })}
        confirmLabel={t("routines.list.delete")}
        destructive
        onConfirm={() => void remove(routine.id)}
      />
    </div>
  )
}

function ConfigRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  )
}

/**
 * The prompt of the routine. A long one shows its first lines and unfolds on request (and then
 * scrolls inside its own box), so it cannot push the history out of the screen.
 */
function RoutinePrompt({ text }: { text: string }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const long = text.length > 280 || text.split("\n").length > 4
  return (
    <>
      <p
        className={cn(
          "whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/85",
          long && !expanded && "line-clamp-4",
          long && expanded && "max-h-64 overflow-y-auto pr-1",
        )}
      >
        {text}
      </p>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? t("routines.detail.showLess") : t("routines.detail.showMore")}
        </button>
      )}
    </>
  )
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-[11px] text-foreground/80">
      {children}
    </span>
  )
}

/** One execution, as a row of the history table: state, when, what it did, how long, cost. */
function RunRow({ session, run, steps }: { session: SessionInfo; run?: RoutineRun; steps: SessionInfo[] }) {
  const { t, i18n } = useTranslation()
  // The live status comes from the session store — it is the same source as the
  // sidebar's spinner. `run` only has the final snapshot (tokens, cost, duration).
  const sessionStatus = useSessionStore((s) => s.status[session.id])
  const running =
    sessionStatus === "submitted" ||
    sessionStatus === "streaming" ||
    sessionStatus === "fallback" ||
    run?.status === "running"
  const status = running ? "running" : (run?.status ?? "ok")

  const openRun = useOpenRun()
  const openChat = () => void openRun(session.id)

  const duration = run?.completedAt && run.startedAt ? formatDuration(run.completedAt - run.startedAt) : "—"
  const note =
    status === "running" ? t("routines.runs.running") : status === "error" ? run?.error || t("routines.runs.error") : session.title

  return (
    <>
    <button
      type="button"
      onClick={openChat}
      title={t("routines.runs.openChat")}
      className="grid w-full grid-cols-[0.5rem_minmax(0,1fr)_auto] items-center gap-x-3 border-t px-4 py-2.5 text-left transition-colors hover:bg-muted/40"
    >
      <span
        className={cn(
          "size-2 rounded-full",
          status === "running" && "bg-blue-400",
          status === "error" && "bg-destructive",
          status === "ok" && "bg-emerald-500",
        )}
        aria-hidden
      />
      <span className="min-w-0">
        <span className="block truncate text-xs">{formatWhen(run?.startedAt ?? session.createdAt, i18n.language)}</span>
        <Truncate text={note}>
          <span className={cn("block truncate text-[11px]", status === "error" ? "text-destructive" : "text-muted-foreground")}>{note}</span>
        </Truncate>
      </span>
      <span className="text-right text-[11px] tabular-nums text-muted-foreground">
        <span className="block">{status === "running" ? "—" : duration}</span>
        <span className="block font-medium text-foreground">{run && run.cost > 0 ? formatCost(run.cost) : "—"}</span>
      </span>
    </button>
    {run?.folder && (
      <button
        type="button"
        onClick={() => void window.ipcRenderer.invoke("shell:showItemInFolder", run.folder)}
        className="flex w-full items-center gap-1.5 px-4 pb-2 pl-9 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <FolderOpenIcon className="size-3" aria-hidden />
        {t("routines.runs.openFolder")}
      </button>
    )}
    {steps.map((step) => (
      <StepRow key={step.id} step={step} onOpen={openRun} />
    ))}
    </>
  )
}

/** A step of a run (a worker's chat), nested under the run; it opens as a chat of its own. */
function StepRow({ step, onOpen }: { step: SessionInfo; onOpen: (sessionId: string) => void }) {
  const { t } = useTranslation()
  const status = useSessionStore((s) => s.status[step.id])
  const busy = status === "submitted" || status === "streaming" || status === "fallback"
  return (
    <button
      type="button"
      onClick={() => onOpen(step.id)}
      title={t("routines.runs.openChat")}
      className="flex w-full items-center gap-2 border-t border-dashed py-1.5 pl-9 pr-4 text-left text-[11px] text-muted-foreground transition-colors hover:bg-muted/40"
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", busy ? "bg-blue-400" : status === "error" ? "bg-destructive" : "bg-muted-foreground/50")} aria-hidden />
      <span className="min-w-0 flex-1 truncate">{step.orchestration?.task ?? step.title}</span>
    </button>
  )
}
