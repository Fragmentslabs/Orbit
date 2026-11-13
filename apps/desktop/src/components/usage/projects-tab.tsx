import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { AlertCircle, ArrowLeft, ArrowRight, LoaderCircle, Sparkles } from "lucide-react"
import type { AnalyticsRange, AnalyticsSession, AnalyticsSummary, ProjectBreakdown } from "@shared/analytics"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { formatCost, formatTokens } from "@/src/lib/format"
import { analyticsApi } from "@/src/lib/ipc"
import { LOCALE_PROMPT_NAME, useLocaleStore } from "@/src/stores/locale-store"
import { Card, CardHeader, EmptyNote, KpiCard } from "./usage-ui"
import { SessionList } from "./sessions-tab"
import { dateKey, formatDayLabel, formatHours, parseDay, percent, projectName, SERIES_COLORS } from "./usage-utils"

const ORBIT = SERIES_COLORS[0]
const YOU = SERIES_COLORS[1]

type SummaryState = { status: "loading" } | { status: "done"; text: string } | { status: "error"; error: "no-aux-model" | "nothing" | "failed"; message?: string }

/** Asks the auxiliary model for the "what was done" of a project, on a day or over the period. */
function useSummaries(projectId: string, range: AnalyticsRange) {
  const [state, setState] = useState<Record<string, SummaryState>>({})
  const run = async (key: string, day?: string) => {
    setState((s) => ({ ...s, [key]: { status: "loading" } }))
    try {
      const language = LOCALE_PROMPT_NAME[useLocaleStore.getState().activeLocale]
      const result = await analyticsApi.summarize({ projectId, ...(day ? { day } : { range }), language })
      setState((s) => ({
        ...s,
        [key]: result.ok ? { status: "done", text: result.text } : { status: "error", error: result.error, message: result.message },
      }))
    } catch (err) {
      setState((s) => ({ ...s, [key]: { status: "error", error: "failed", message: err instanceof Error ? err.message : String(err) } }))
    }
  }
  return { state, run, close: (key: string) => setState((s) => { const { [key]: _gone, ...rest } = s; return rest }) }
}

function SummaryButton({ state, onRun, onClose, label }: { state?: SummaryState; onRun: () => void; onClose: () => void; label: string }) {
  const { t } = useTranslation()
  const loading = state?.status === "loading"
  return (
    <Button
      size="sm"
      variant="outline"
      className="gap-1.5"
      disabled={loading}
      onClick={state?.status === "done" ? onClose : onRun}
    >
      {loading ? <LoaderCircle className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
      {loading ? t("usage.summary.loading") : state?.status === "done" ? t("usage.summary.hide") : label}
    </Button>
  )
}

function SummaryBox({ state }: { state?: SummaryState }) {
  const { t } = useTranslation()
  if (!state || state.status === "loading") return null
  if (state.status === "done") {
    return (
      <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-xs leading-relaxed text-foreground/90">
        <p className="mb-1 text-[11px] text-muted-foreground">{t("usage.summary.generated")}</p>
        {state.text}
      </div>
    )
  }
  return (
    <p className="flex items-start gap-1.5 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      <AlertCircle className="mt-px size-3.5 shrink-0" />
      <span>{state.error === "failed" && state.message ? state.message : t(`usage.summary.error.${state.error}`)}</span>
    </p>
  )
}

export function ProjectsTab({ data, range }: { data: AnalyticsSummary; range: AnalyticsRange }) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language
  const [selected, setSelected] = useState<string | null>(null)
  const project = selected ? data.byProject.find((p) => p.projectId === selected) : undefined

  if (data.byProject.length === 0) return <EmptyNote>{t("analytics.noData")}</EmptyNote>
  if (project) return <ProjectDetail data={data} project={project} range={range} onBack={() => setSelected(null)} />

  const maxHours = Math.max(...data.byProject.map((p) => p.hours), Number.EPSILON)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold">{t("usage.projects.title")}</p>
          <p className="text-[11px] text-muted-foreground">{t("usage.projects.hint")}</p>
        </div>
        <Legend />
      </div>
      {data.byProject.map((p) => (
        <button
          key={p.projectId}
          type="button"
          onClick={() => setSelected(p.projectId)}
          className="flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-xl border bg-card px-3.5 py-3 text-left transition-colors hover:border-primary/40"
        >
          <span className="flex min-w-[14rem] flex-1 flex-col gap-2">
            <span className="truncate text-xs font-semibold">{projectName(p, t)}</span>
            <HoursBar value={p.orbitHours} max={maxHours} color={ORBIT} label={formatHours(p.orbitHours, locale)} />
            <HoursBar value={p.userHours} max={maxHours} color={YOU} label={formatHours(p.userHours, locale)} />
          </span>
          <span className="grid shrink-0 grid-cols-3 gap-2 text-right text-xs tabular-nums">
            <Figure label={t("usage.projects.sessions")} value={String(p.sessions)} />
            <Figure label={t("analytics.tokens")} value={formatTokens(p.tokens)} />
            <Figure label={t("usage.projects.spent")} value={formatCost(p.cost)} />
          </span>
          <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      ))}
    </div>
  )
}

function Legend() {
  const { t } = useTranslation()
  return (
    <>
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="size-2 rounded-sm" style={{ backgroundColor: ORBIT }} /> {t("usage.legend.orbit")}
      </span>
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="size-2 rounded-sm" style={{ backgroundColor: YOU }} /> {t("usage.legend.you")}
      </span>
    </>
  )
}

function HoursBar({ value, max, color, label }: { value: number; max: number; color: string; label: string }) {
  return (
    <span className="flex items-center gap-2">
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full" style={{ width: `${Math.max(1, percent(value, max))}%`, backgroundColor: color }} />
      </span>
      <span className="w-14 text-right text-xs tabular-nums">{label}</span>
    </span>
  )
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <span className="w-20">
      <span className="block text-[11px] text-muted-foreground">{label}</span>
      {value}
    </span>
  )
}

function ProjectDetail({ data, project, range, onBack }: {
  data: AnalyticsSummary
  project: ProjectBreakdown
  range: AnalyticsRange
  onBack: () => void
}) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language
  const summaries = useSummaries(project.projectId, range)

  // The last 14 days of the period (calendar days, empty ones included), orbit × user.
  const pairs = useMemo(() => {
    const last = data.days.length ? parseDay(data.days[data.days.length - 1].date) : new Date()
    const byDate = new Map(data.days.map((d) => [d.date, d]))
    return Array.from({ length: 14 }, (_, i) => {
      const d = new Date(last)
      d.setDate(last.getDate() - (13 - i))
      const key = dateKey(d)
      const slice = byDate.get(key)?.byProject.find((p) => p.projectId === project.projectId)
      return { key, orbit: slice?.orbitHours ?? 0, you: slice?.userHours ?? 0 }
    })
  }, [data.days, project.projectId])
  const pairMax = Math.max(...pairs.map((p) => Math.max(p.orbit, p.you)), Number.EPSILON)

  // History: the project's conversations grouped by day, newest first.
  const history = useMemo(() => {
    const groups = new Map<string, AnalyticsSession[]>()
    for (const s of data.sessions ?? []) {
      if (s.projectId !== project.projectId) continue
      const list = groups.get(s.date) ?? []
      list.push(s)
      groups.set(s.date, list)
    }
    return [...groups.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([date, sessions]) => {
        const slice = data.days.find((d) => d.date === date)?.byProject.find((p) => p.projectId === project.projectId)
        return {
          date,
          sessions: sessions.sort((a, b) => b.startAt - a.startAt),
          orbit: slice?.orbitHours ?? 0,
          you: slice?.userHours ?? 0,
          cost: slice?.cost ?? 0,
        }
      })
  }, [data.sessions, data.days, project.projectId])

  const kpis = [
    { label: t("usage.cards.orbitHours"), value: formatHours(project.orbitHours, locale), meta: t("usage.projects.agentRunning") },
    { label: t("usage.cards.yourHours"), value: formatHours(project.userHours, locale), meta: t("usage.cards.estimated") },
    { label: t("usage.projects.sessions"), value: String(project.sessions), meta: t("usage.projects.inPeriod") },
    { label: t("analytics.tokens"), value: formatTokens(project.tokens), meta: t("usage.projects.inputOutput") },
    { label: t("usage.projects.spent"), value: formatCost(project.cost), meta: project.hours > 0 ? t("usage.projects.perHour", { value: formatCost(project.cost / project.hours) }) : "—" },
  ]

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Button size="sm" variant="outline" className="gap-1" onClick={onBack}>
          <ArrowLeft className="size-3" /> {t("usage.projects.back")}
        </Button>
        <span className="truncate text-sm font-semibold">{projectName(project, t)}</span>
        <span className="flex-1" />
        <SummaryButton
          state={summaries.state.period}
          label={t("usage.summary.period")}
          onRun={() => void summaries.run("period")}
          onClose={() => summaries.close("period")}
        />
      </div>
      <SummaryBox state={summaries.state.period} />

      <div className="grid grid-cols-2 gap-3 @[38rem]:grid-cols-5">
        {kpis.map((k) => (
          <KpiCard key={k.label} label={k.label} value={k.value} meta={k.meta} />
        ))}
      </div>

      <Card>
        <CardHeader
          title={t("usage.projects.perDay")}
          action={
            <span className="flex items-center gap-3">
              <Legend />
            </span>
          }
        />
        <div className="flex h-24 items-end gap-2.5 border-b">
          {pairs.map((p) => (
            <div
              key={p.key}
              title={`${formatDayLabel(p.key, locale)} — ${t("usage.legend.orbit")} ${formatHours(p.orbit, locale)} · ${t("usage.legend.you")} ${formatHours(p.you, locale)}`}
              className="flex h-full min-w-0 flex-1 items-end gap-0.5"
            >
              <span className="flex-1 rounded-t-sm" style={{ height: `${Math.max(2, percent(p.orbit, pairMax))}%`, backgroundColor: ORBIT, opacity: p.orbit === 0 ? 0.2 : 1 }} />
              <span className="flex-1 rounded-t-sm" style={{ height: `${Math.max(2, percent(p.you, pairMax))}%`, backgroundColor: YOU, opacity: p.you === 0 ? 0.2 : 1 }} />
            </div>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">{t("usage.projects.estimateNote")}</p>
      </Card>

      <div>
        <p className="mb-2 text-[13px] font-semibold">{t("usage.projects.history")}</p>
        {history.length === 0 ? (
          <EmptyNote>{t("usage.noData")}</EmptyNote>
        ) : (
          <div className="flex flex-col gap-3">
            {history.map((g) => {
              const key = `day:${g.date}`
              return (
                <div key={g.date} className="overflow-hidden rounded-xl border">
                  <div className="flex items-center gap-3 bg-card px-3.5 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold">{formatDayLabel(g.date, locale)}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {t("usage.projects.dayMeta", {
                          orbit: formatHours(g.orbit, locale),
                          you: formatHours(g.you, locale),
                          sessions: g.sessions.length,
                          cost: formatCost(g.cost),
                        })}
                      </p>
                    </div>
                    <SummaryButton
                      state={summaries.state[key]}
                      label={t("usage.summary.day")}
                      onRun={() => void summaries.run(key, g.date)}
                      onClose={() => summaries.close(key)}
                    />
                  </div>
                  {summaries.state[key] && summaries.state[key].status !== "loading" && (
                    <div className={cn("border-t px-4 py-3")}>
                      <SummaryBox state={summaries.state[key]} />
                    </div>
                  )}
                  <SessionList sessions={g.sessions} data={data} compact />
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
