import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import {
  AlertCircleIcon,
  CalendarClockIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  FolderIcon,
  Loader2,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlayIcon,
  TerminalIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"
import type { SessionInfo } from "@shared/chat"
import type { Routine, RoutineModes, RoutineRun, Schedule } from "@shared/routines"
import { nextRoutineRun, parseTime, ROUTINE_CHAT_MODES } from "@shared/routines"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { ConfirmDialog } from "@/components/ui/alert-dialog"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useWorkspace } from "@/lib/workspace-context"
import { cn } from "@/lib/utils"
import { formatCost, formatDateTimeShort, formatDuration, formatTokens } from "@/src/lib/format"
import { ModelPicker } from "@/src/components/model-picker"
import { useProviderStore, type SelectedModel } from "@/src/stores/provider-store"
import { useSessionStore } from "@/src/stores/session-store"
import { useRoutinesStore } from "@/src/stores/routines-store"
import { describeSchedule } from "./schedule"
import { ActiveSwitch, ModeBadges, ModesEditor, ReuseChatField, ScheduleEditor } from "./schedule-editor"
import { Truncate } from "@/components/ui/truncated-text"

/**
 * Routine list and the detail sub-page with the session history.
 *
 * The list of sessions is DERIVED from the chat sessions (`routineId`), with
 * the metrics from `runs` matched by sessionId. A single source of truth:
 * deleting the session in the sidebar removes the row here without leaving a
 * "deleted" record behind.
 */

// ─── List ────────────────────────────────────────────────────────────────────

/** The search of the page: title, prompt or the schedule as the user reads it. */
export function routineMatches(routine: Routine, query: string, t: TFunction): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    routine.title.toLowerCase().includes(q) ||
    routine.prompt.toLowerCase().includes(q) ||
    describeSchedule(routine.schedule, t).toLowerCase().includes(q)
  )
}

export function RoutineList({ routines, scope, query, selectedId, onSelect, onCreateNew }: {
  routines: Routine[]
  scope: "chat" | "code" | "all"
  query: string
  selectedId: string | null
  /** A click on the open routine closes it (back to the summary). */
  onSelect: (id: string | null) => void
  onCreateNew: () => void
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
          showMode={scope === "all"}
          selected={routine.id === selectedId}
          onOpen={() => onSelect(routine.id === selectedId ? null : routine.id)}
        />
      ))}
    </div>
  )
}

function RoutineCard({ routine, showMode, selected, onOpen }: {
  routine: Routine
  /** The page lists both modes: say which one this is. */
  showMode?: boolean
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
  const modelName = useProviderStore(
    (s) => s.catalog[routine.model.providerId]?.models[routine.model.modelId]?.name ?? routine.model.modelId,
  )

  const next = nextRoutineRun(routine)

  return (
    <div className={cn("flex flex-col gap-2 rounded-lg border bg-card p-3 transition-colors hover:border-ring", selected && "border-primary/70")}>
      <div className="flex items-center gap-2">
        <CalendarClockIcon className="size-4 shrink-0 text-muted-foreground" />
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 truncate text-left text-sm font-medium">
          {routine.title}
        </button>
        {showMode && (
          <span
            title={routine.mode === "chat" ? t("routines.mode.chat") : t("routines.mode.code")}
            className="inline-flex shrink-0 items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
          >
            {routine.mode === "chat" ? <MessageSquareIcon className="size-3" /> : <TerminalIcon className="size-3" />}
            {routine.mode === "chat" ? t("viewScope.chat") : t("viewScope.code")}
          </span>
        )}
        {failed && (
          <span className="shrink-0 rounded-md bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
            {t("routines.list.failed")}
          </span>
        )}
        {running && (
          <span title={t("routines.runs.running")}>
            <Loader2 className="size-3 shrink-0 animate-spin text-primary" />
          </span>
        )}
        <ActiveSwitch active={routine.active} onChange={(v) => void update(routine.id, { active: v })} />
      </div>

      <button type="button" onClick={onOpen} className="min-w-0 space-y-1.5 text-left">
        <Truncate>
          <p className="truncate text-[11px] text-muted-foreground">{describeSchedule(routine.schedule, t)}</p>
        </Truncate>
        <p className="line-clamp-2 text-[11px] text-muted-foreground/80">{routine.prompt}</p>
        <ModeBadges
          modes={routine.modes}
          permission
          available={routine.mode === "chat" ? ROUTINE_CHAT_MODES : undefined}
        />
        <Truncate>
          <p className="truncate text-[11px] text-muted-foreground">{modelName}</p>
        </Truncate>
        <Truncate>
          <p className="truncate text-[11px] text-muted-foreground">
            {next
              ? t("routines.list.next", { when: formatDateTimeShort(next, i18n.language) })
              : t("routines.list.paused")}
          </p>
        </Truncate>
      </button>
    </div>
  )
}

// ─── Editing ─────────────────────────────────────────────────────────────────

function EditRoutineDialog({
  routine,
  open,
  onOpenChange,
}: {
  routine: Routine
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const update = useRoutinesStore((s) => s.update)
  const [title, setTitle] = useState(routine.title)
  const [prompt, setPrompt] = useState(routine.prompt)
  const [schedule, setSchedule] = useState<Schedule>(routine.schedule)
  const [modes, setModes] = useState<RoutineModes>(routine.modes)
  const [model, setModel] = useState<SelectedModel | null>(routine.model)
  const [reuseChat, setReuseChat] = useState(!!routine.reuseChat)

  // Reopening the dialog starts over from the persisted routine (the scheduler
  // may have touched it while it was closed).
  const key = `${routine.id}:${open}`
  const [lastKey, setLastKey] = useState(key)
  if (key !== lastKey) {
    setLastKey(key)
    if (open) {
      setTitle(routine.title)
      setPrompt(routine.prompt)
      setSchedule(routine.schedule)
      setModes(routine.modes)
      setModel(routine.model)
      setReuseChat(!!routine.reuseChat)
    }
  }

  const canSave = title.trim().length > 0 && prompt.trim().length > 0 && !!parseTime(schedule.time) && !!model

  const save = async () => {
    if (!canSave || !model) return
    await update(routine.id, {
      title: title.trim(),
      prompt: prompt.trim(),
      schedule,
      modes,
      model,
      reuseChat,
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>{t("routines.list.edit")}</DialogTitle>
        <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1">
          <div className="space-y-1">
            <p className="text-xs font-medium">{t("routines.review.titleField")}</p>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} className="h-8 text-sm" />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium">{t("routines.review.promptField")}</p>
            <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} className="max-h-56 min-h-28" />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium">{t("routines.review.schedule")}</p>
            <ScheduleEditor schedule={schedule} onChange={setSchedule} />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium">{t("routines.review.modes")}</p>
            <ModesEditor
              modes={modes}
              onChange={setModes}
              available={routine.mode === "chat" ? ROUTINE_CHAT_MODES : undefined}
            />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium">{t("routines.create.model")}</p>
            <ModelPicker value={model} onValueChange={setModel} />
          </div>
          <ReuseChatField value={reuseChat} onChange={setReuseChat} />
        </div>
        <div className="flex justify-end gap-2 border-t pt-3">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" disabled={!canSave} onClick={() => void save()}>
            {t("routines.list.save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── Detail sub-page ─────────────────────────────────────────────────────────

/**
 * Routine detail as a PAGE: it replaces the whole routines screen, with its own
 * header (back, title, schedule, switch, run, ellipsis). The list header
 * disappears — whoever is here is inside ONE routine.
 */
export function RoutineDetail({ routine, onClose }: { routine: Routine; onClose: () => void }) {
  const { t, i18n } = useTranslation()
  const update = useRoutinesStore((s) => s.update)
  const runNow = useRoutinesStore((s) => s.runNow)
  const remove = useRoutinesStore((s) => s.remove)
  const runs = useRoutinesStore((s) => s.runs)
  const running = runs.some((r) => r.routineId === routine.id && r.status === "running")
  const sessions = useSessionStore((s) => s.sessions)
  const modelName = useProviderStore(
    (s) => s.catalog[routine.model.providerId]?.models[routine.model.modelId]?.name ?? routine.model.modelId,
  )
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)

  // List DERIVED from the sessions: a session deleted in the sidebar disappears
  // from here on its own, with no "deleted" state hanging on the routine record.
  const executions = useMemo(() => {
    const metrics = new Map(runs.filter((r) => r.routineId === routine.id).map((r) => [r.sessionId, r]))
    return sessions
      .filter((s) => s.routineId === routine.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((session) => ({ session, run: metrics.get(session.id) }))
  }, [sessions, runs, routine.id])

  const next = nextRoutineRun(routine)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          <Truncate>
            <h2 className="flex items-center gap-2 truncate text-base font-semibold text-foreground">
              {routine.title}
              {running && <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />}
            </h2>
          </Truncate>
          <Truncate>
            <p className="truncate text-xs text-muted-foreground">
              {describeSchedule(routine.schedule, t)}
              {" · "}
              {next
                ? t("routines.list.next", { when: formatDateTimeShort(next, i18n.language) })
                : t("routines.list.paused")}
            </p>
          </Truncate>
        </div>
        <ActiveSwitch active={routine.active} onChange={(v) => void update(routine.id, { active: v })} />
        <Button size="sm" variant="outline" disabled={running} onClick={() => void runNow(routine.id)}>
          <PlayIcon className="size-3.5" />
          {t("routines.list.runNow")}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
            <MoreHorizontalIcon className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40">
            <DropdownMenuItem onClick={() => setEditing(true)}>
              <PencilIcon className="size-3.5" />
              {t("routines.list.edit")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setConfirming(true)}>
              <Trash2Icon className="size-3.5" />
              {t("routines.list.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t("routines.detail.close")}>
          <XIcon className="size-4" />
        </Button>
      </div>

      <div className="shrink-0 space-y-1.5 rounded-lg border bg-card p-3">
        <p className="whitespace-pre-wrap text-[11px] text-muted-foreground">{routine.prompt}</p>
        <span className="flex flex-wrap items-center gap-1">
          <ModeBadges
            modes={routine.modes}
            permission
            available={routine.mode === "chat" ? ROUTINE_CHAT_MODES : undefined}
          />
          {routine.mode === "chat" && (
            <span className="inline-flex items-center rounded-md border border-transparent bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {t("routines.mode.chat")}
            </span>
          )}
        </span>
        <Truncate text={modelName}>
          <p className="truncate text-[11px] text-muted-foreground">{modelName}</p>
        </Truncate>
        {routine.folders.length > 0 && (
          <Truncate>
            <p className="flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
              <FolderIcon className="size-3 shrink-0" />
              <Truncate text={routine.folders.join(", ")}>
                <span className="truncate">{routine.folders.join(", ")}</span>
              </Truncate>
            </p>
          </Truncate>
        )}
      </div>

      <p className="shrink-0 text-xs font-medium">{t("routines.runs.title")}</p>

      {executions.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{t("routines.runs.empty")}</p>
      ) : (
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
          {executions.map(({ session, run }) => (
            <RunRow key={session.id} session={session} run={run} />
          ))}
        </div>
      )}

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

function RunRow({ session, run }: { session: SessionInfo; run?: RoutineRun }) {
  const { t, i18n } = useTranslation()
  const { mode, setMode, setView, setFolders } = useWorkspace()
  // The live status comes from the session store — it is the same source as the
  // sidebar's spinner. `run` only has the final snapshot (tokens, cost, duration).
  const sessionStatus = useSessionStore((s) => s.status[session.id])
  const running =
    sessionStatus === "submitted" ||
    sessionStatus === "streaming" ||
    sessionStatus === "fallback" ||
    run?.status === "running"
  const status = running ? "running" : (run?.status ?? "ok")

  const openChat = () => {
    // Same path as the sidebar's SessionRow: it activates the session in its
    // own mode (a chat routine opens in chat; a code one opens in code) and
    // leaves the routines page for the conversation.
    const targetMode = session.mode
    if (targetMode !== mode) setMode(targetMode)
    if (session.directory) setFolders([session.directory, ...(session.extraDirectories ?? [])])
    void useSessionStore.getState().selectSession(targetMode, session.id)
    setView("chat")
  }

  const duration = run?.completedAt && run.startedAt ? formatDuration(run.completedAt - run.startedAt) : undefined

  return (
    <button
      type="button"
      onClick={openChat}
      className="flex w-full items-center gap-2 rounded-lg border bg-card px-3 py-2 text-left transition-colors hover:border-ring"
    >
      {status === "running" ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
      ) : status === "error" ? (
        <AlertCircleIcon className="size-3.5 shrink-0 text-destructive" />
      ) : (
        <CheckCircle2Icon className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        <Truncate>
          <p className="truncate text-xs">
            {formatDateTimeShort(run?.startedAt ?? session.createdAt, i18n.language)}
          </p>
        </Truncate>
        <Truncate>
          <p className={cn("truncate text-[11px]", status === "error" ? "text-destructive" : "text-muted-foreground")}>
            {status === "running"
              ? t("routines.runs.running")
              : status === "error"
                ? run?.error || t("routines.runs.error")
                : [
                    duration,
                    run && run.tokens > 0 ? t("routines.runs.tokens", { value: formatTokens(run.tokens) }) : null,
                    run && run.cost > 0 ? formatCost(run.cost) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || t("routines.runs.ok")}
          </p>
        </Truncate>
      </div>
      <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
        {t("routines.runs.openChat")}
        <ExternalLinkIcon className="size-3" />
      </span>
    </button>
  )
}
