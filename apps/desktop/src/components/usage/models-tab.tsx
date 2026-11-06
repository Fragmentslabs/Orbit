import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { ArrowLeft } from "lucide-react"
import type { AnalyticsSummary, ModelDayBreakdown } from "@shared/analytics"
import { Button } from "@/components/ui/button"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { cn } from "@/lib/utils"
import { formatCost, formatTokens } from "@/src/lib/format"
import { Card, CardHeader, DayBars, EmptyNote, KpiCard, ShareRow } from "./usage-ui"
import { SessionList } from "./sessions-tab"
import {
  type Metric,
  type SeriesPoint,
  colorsByModel,
  dateKey,
  formatDayLabel,
  formatHours,
  modelKeyOf,
  parseDay,
  percent,
  pickMetric,
  projectName,
} from "./usage-utils"

export function ModelsTab({ data }: { data: AnalyticsSummary }) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language
  const [selected, setSelected] = useState<string | null>(null)
  const [rank, setRank] = useState<Metric>("tokens")
  const colors = useMemo(() => colorsByModel(data.byModel), [data.byModel])

  const sorted = useMemo(
    () => [...data.byModel].sort((a, b) => pickMetric(b, rank) - pickMetric(a, rank)),
    [data.byModel, rank],
  )
  const model = selected ? data.byModel.find((m) => modelKeyOf(m) === selected) : undefined

  if (data.byModel.length === 0) return <EmptyNote>{t("analytics.noData")}</EmptyNote>

  if (model) {
    return <ModelDetail data={data} model={model} color={colors.get(selected!) ?? SERIES_FALLBACK} onBack={() => setSelected(null)} />
  }

  const top = pickMetric(sorted[0], rank)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold">{t("usage.models.title")}</p>
          <p className="text-[11px] text-muted-foreground">{t("usage.models.hint")}</p>
        </div>
        <SegmentedControl<Metric>
          size="sm"
          value={rank}
          onChange={setRank}
          options={[
            { value: "tokens", label: t("analytics.tokens") },
            { value: "hours", label: t("analytics.hours") },
            { value: "cost", label: t("analytics.cost") },
          ]}
        />
      </div>
      <Card className="overflow-hidden p-0">
        <div className="grid grid-cols-[1.5rem_minmax(0,1.6fr)_repeat(5,minmax(0,1fr))] gap-2 border-b px-4 py-2 text-[11px] text-muted-foreground">
          <span />
          <span>{t("usage.models.model")}</span>
          <span className="text-right">{t("analytics.tokens")}</span>
          <span className="text-right">{t("analytics.hours")}</span>
          <span className="text-right">{t("usage.models.messages")}</span>
          <span className="text-right">{t("analytics.cost")}</span>
          <span className="text-right">{t("usage.models.costPerMillion")}</span>
        </div>
        {sorted.map((m, i) => {
          const key = modelKeyOf(m)
          return (
            <button
              key={key}
              type="button"
              onClick={() => setSelected(key)}
              className="grid w-full grid-cols-[1.5rem_minmax(0,1.6fr)_repeat(5,minmax(0,1fr))] items-center gap-2 border-b px-4 py-3 text-left text-xs tabular-nums transition-colors last:border-b-0 hover:bg-muted/40"
            >
              <span className="text-center text-muted-foreground">{i + 1}</span>
              <span className="flex min-w-0 flex-col gap-1.5">
                <span className="flex items-baseline gap-2">
                  <span className="truncate text-xs font-medium">{m.modelId}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{m.providerId}</span>
                </span>
                <span className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-full rounded-full"
                    style={{ width: `${Math.max(2, percent(pickMetric(m, rank), top))}%`, backgroundColor: colors.get(key) }}
                  />
                </span>
              </span>
              <span className="text-right">{formatTokens(m.tokens)}</span>
              <span className="text-right">{formatHours(m.hours, locale)}</span>
              <span className="text-right">{m.messages}</span>
              <span className="text-right">{formatCost(m.cost)}</span>
              <span className="text-right">{m.tokens > 0 ? formatCost((m.cost / m.tokens) * 1_000_000) : "—"}</span>
            </button>
          )
        })}
      </Card>
    </div>
  )
}

const SERIES_FALLBACK = "#6ea8fe"

function ModelDetail({ data, model, color, onBack }: {
  data: AnalyticsSummary
  model: ModelDayBreakdown
  color: string
  onBack: () => void
}) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language
  const key = modelKeyOf(model)

  // Hours this model worked on each day of the period, contiguous.
  const points = useMemo<SeriesPoint[]>(() => {
    if (data.days.length === 0) return []
    const first = parseDay(data.days[0].date)
    const last = parseDay(data.days[data.days.length - 1].date)
    const span = Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1
    const byDate = new Map(data.days.map((d) => [d.date, d]))
    return Array.from({ length: span }, (_, i) => {
      const d = new Date(first)
      d.setDate(first.getDate() + i)
      const dk = dateKey(d)
      const slice = byDate.get(dk)?.byModel.find((m) => modelKeyOf(m) === key)
      return {
        date: dk,
        label: formatDayLabel(dk, locale),
        value: slice?.hours ?? 0,
        hours: slice?.hours ?? 0,
        tokens: slice?.tokens ?? 0,
        cost: slice?.cost ?? 0,
        orbitHours: 0,
        userHours: 0,
      }
    })
  }, [data.days, key, locale])

  const sessions = useMemo(
    () => (data.sessions ?? []).filter((s) => modelKeyOf(s) === key).slice(0, 8),
    [data.sessions, key],
  )
  const projects = model.byProject ?? []
  const projectLabel = (id: string) => {
    const p = data.byProject.find((x) => x.projectId === id)
    return p ? projectName(p, t) : id
  }

  const kpis = [
    { label: t("analytics.tokens"), value: formatTokens(model.tokens), meta: t("usage.ofTotal", { pct: percent(model.tokens, data.totalTokens) }) },
    { label: t("analytics.hours"), value: formatHours(model.hours, locale), meta: t("usage.ofTotal", { pct: percent(model.hours, data.totalHours) }) },
    { label: t("usage.models.messages"), value: String(model.messages), meta: t("usage.models.tokensEach", { value: formatTokens(Math.round(model.tokens / Math.max(model.messages, 1))) }) },
    { label: t("analytics.cost"), value: formatCost(model.cost), meta: t("usage.ofTotal", { pct: percent(model.cost, data.totalCost) }) },
    { label: t("usage.models.costPerMillion"), value: model.tokens > 0 ? formatCost((model.cost / model.tokens) * 1_000_000) : "—", meta: t("usage.models.avgPeriod") },
    { label: t("usage.models.costPerHour"), value: model.hours > 0 ? formatCost(model.cost / model.hours) : "—", meta: t("usage.models.avgPeriod") },
  ]

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Button size="sm" variant="outline" className="gap-1" onClick={onBack}>
          <ArrowLeft className="size-3" /> {t("usage.models.back")}
        </Button>
        <span className="size-2.5 rounded-full" style={{ backgroundColor: color }} aria-hidden />
        <span className="text-sm font-semibold">{model.modelId}</span>
        <span className="text-xs text-muted-foreground">{model.providerId}</span>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        {kpis.map((k) => (
          <KpiCard key={k.label} label={k.label} value={k.value} meta={k.meta} />
        ))}
      </div>

      <Card>
        <CardHeader title={t("usage.models.hoursPerDay")} />
        <DayBars points={points} metric="hours" height={110} color={color} />
      </Card>

      <div className="grid gap-3 xl:grid-cols-[1fr_1.4fr]">
        <Card>
          <CardHeader title={t("usage.models.whereUsed")} />
          {projects.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("usage.noData")}</p>
          ) : (
            projects.map((p) => (
              <ShareRow
                key={p.projectId}
                name={projectLabel(p.projectId)}
                value={formatHours(p.hours, locale)}
                pct={percent(p.hours, model.hours)}
                color={color}
              />
            ))
          )}
        </Card>
        <Card className="overflow-hidden p-0">
          <p className={cn("px-3.5 pb-2 pt-3.5 text-[13px] font-semibold")}>{t("usage.models.recentSessions")}</p>
          <SessionList sessions={sessions} data={data} compact />
        </Card>
      </div>
    </div>
  )
}

