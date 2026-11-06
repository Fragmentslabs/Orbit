import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import type { AnalyticsSession, AnalyticsSummary } from "@shared/analytics"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/lib/workspace-context"
import { formatCost, formatTime } from "@/src/lib/format"
import { useSessionStore } from "@/src/stores/session-store"
import { Card, EmptyNote } from "./usage-ui"
import { formatDayLabel, formatDuration, projectName } from "./usage-utils"

const PAGE = 40

/** Opens the conversation of a history entry — in the mode it was born in. */
export function useOpenSession() {
  const { mode, setMode, setView } = useWorkspace()
  const sessions = useSessionStore((s) => s.sessions)
  const selectSession = useSessionStore((s) => s.selectSession)
  return (id: string): boolean => {
    const session = sessions.find((s) => s.id === id)
    if (!session) return false
    if (session.mode !== mode) setMode(session.mode)
    setView("chat")
    void selectSession(session.mode, session.id)
    return true
  }
}

/**
 * Rows of conversations (one per conversation and day). A conversation that no longer exists
 * (deleted after the work was done) stays in the history but cannot be opened.
 */
export function SessionList({ sessions, data, compact, showDay }: {
  sessions: AnalyticsSession[]
  data: AnalyticsSummary
  /** Fewer columns, for a card beside others. */
  compact?: boolean
  /** The "when" column starts with the day (the flat list); in a day group the time is enough. */
  showDay?: boolean
}) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language
  const open = useOpenSession()
  const existing = useSessionStore((s) => s.sessions)
  const alive = useMemo(() => new Set(existing.map((s) => s.id)), [existing])

  if (sessions.length === 0) return <p className="px-4 pb-4 text-xs text-muted-foreground">{t("usage.noData")}</p>

  const grid = compact
    ? "grid-cols-[4.5rem_minmax(0,1fr)_4.5rem_4.5rem]"
    : "grid-cols-[6.5rem_minmax(0,1fr)_8rem_9rem_3.5rem_4.5rem_4.5rem]"

  return (
    <div>
      {sessions.map((s) => {
        const openable = alive.has(s.id)
        const project = data.byProject.find((p) => p.projectId === s.projectId)
        const when = showDay ? `${formatDayLabel(s.date, locale)} ${formatTime(s.startAt, locale)}` : formatTime(s.startAt, locale)
        return (
          <button
            key={`${s.id}:${s.date}`}
            type="button"
            disabled={!openable}
            title={openable ? t("usage.sessions.open") : t("usage.sessions.deleted")}
            onClick={() => open(s.id)}
            className={cn(
              "grid w-full items-center gap-2.5 border-t px-4 py-2.5 text-left text-xs tabular-nums transition-colors",
              grid,
              openable ? "hover:bg-muted/40" : "cursor-default opacity-60",
            )}
          >
            <span className="text-muted-foreground">{when}</span>
            <span className="truncate">{s.title || t("usage.sessions.untitled")}</span>
            {!compact && <span className="truncate text-muted-foreground">{project ? projectName(project, t) : "—"}</span>}
            {!compact && <span className="truncate text-muted-foreground">{s.modelId}</span>}
            {!compact && <span className="text-right text-muted-foreground">{s.messages}</span>}
            <span className="text-right">{formatDuration(s.hours)}</span>
            <span className="text-right font-medium">{formatCost(s.cost)}</span>
          </button>
        )
      })}
    </div>
  )
}

export function SessionsTab({ data }: { data: AnalyticsSummary }) {
  const { t } = useTranslation()
  const [query, setQuery] = useState("")
  const [project, setProject] = useState<string>("all")
  const [shown, setShown] = useState(PAGE)

  const all = useMemo(() => data.sessions ?? [], [data.sessions])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return all.filter((s) => (project === "all" || s.projectId === project) && (!q || s.title.toLowerCase().includes(q)))
  }, [all, query, project])

  if (all.length === 0) return <EmptyNote>{t("analytics.noData")}</EmptyNote>

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setShown(PAGE)
          }}
          placeholder={t("usage.sessions.search")}
          aria-label={t("usage.sessions.search")}
          className="h-8 w-60 text-xs"
        />
        <div className="flex flex-wrap gap-1">
          {[{ id: "all", label: t("usage.sessions.allProjects") }, ...data.byProject.map((p) => ({ id: p.projectId, label: projectName(p, t) }))].map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => {
                setProject(opt.id)
                setShown(PAGE)
              }}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs transition-colors",
                project === opt.id ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <span className="ml-auto text-xs text-muted-foreground">{t("usage.sessions.count", { shown: Math.min(shown, filtered.length), total: filtered.length })}</span>
      </div>

      <Card className="overflow-hidden p-0">
        <div className="grid grid-cols-[6.5rem_minmax(0,1fr)_8rem_9rem_3.5rem_4.5rem_4.5rem] gap-2.5 px-4 py-2 text-[11px] text-muted-foreground">
          <span>{t("usage.sessions.when")}</span>
          <span>{t("usage.sessions.session")}</span>
          <span>{t("usage.projects.project")}</span>
          <span>{t("usage.models.model")}</span>
          <span className="text-right">{t("usage.models.messages")}</span>
          <span className="text-right">{t("usage.sessions.duration")}</span>
          <span className="text-right">{t("analytics.cost")}</span>
        </div>
        <SessionList sessions={filtered.slice(0, shown)} data={data} showDay />
      </Card>

      {shown < filtered.length && (
        <Button variant="outline" size="sm" className="self-center" onClick={() => setShown((n) => n + PAGE)}>
          {t("usage.sessions.showMore")}
        </Button>
      )}
    </div>
  )
}
