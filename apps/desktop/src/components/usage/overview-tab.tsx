import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { ArrowRight } from "lucide-react"
import type { AnalyticsSummary } from "@shared/analytics"
import { Button } from "@/components/ui/button"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { formatCost, formatTokens } from "@/src/lib/format"
import { ActivityCard, Card, CardHeader, DayBars, Delta, EmptyNote, ShareRow, StatCard } from "./usage-ui"
import { buildInsights } from "./usage-insights"
import {
  type Metric,
  type UsageSection,
  OTHERS_COLOR,
  buildSeries,
  colorsByModel,
  formatDuration,
  formatHours,
  formatMetric,
  modelKeyOf,
  percent,
  pickMetric,
  projectName,
  SERIES_COLORS,
  spanOfDays,
} from "./usage-utils"

/** How many entries a ranking card shows before folding the rest into "Others". */
const TOP = 3

export function OverviewTab({ data, onNavigate }: { data: AnalyticsSummary; onNavigate: (section: UsageSection) => void }) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language
  const [metric, setMetric] = useState<Metric>("hours")

  const series = useMemo(() => buildSeries(data.days, metric, locale), [data.days, metric, locale])
  const sparkOf = (pick: (p: (typeof series)[number]) => number) => {
    // 12 evenly spaced points of the period are enough to see the shape.
    const all = buildSeries(data.days, "hours", locale)
    if (all.length <= 12) return all.map(pick)
    const step = all.length / 12
    return Array.from({ length: 12 }, (_, i) => {
      const slice = all.slice(Math.floor(i * step), Math.floor((i + 1) * step))
      return slice.reduce((s, p) => s + pick(p), 0)
    })
  }

  const modelColors = useMemo(() => colorsByModel(data.byModel), [data.byModel])
  const previous = data.previous

  // The same metric as the "usage per day" chart rules the rankings: change it there and the
  // models and the projects are read by tokens, hours or cost too.
  const totalOf = { hours: data.totalHours, tokens: data.totalTokens, cost: data.totalCost }[metric]

  const modelRows = useMemo(() => {
    const sorted = [...data.byModel].sort((a, b) => pickMetric(b, metric) - pickMetric(a, metric))
    const top = sorted.slice(0, TOP)
    const rest = sorted.slice(TOP)
    return { top, rest, restValue: rest.reduce((s, m) => s + pickMetric(m, metric), 0) }
  }, [data.byModel, metric])

  const projectRows = useMemo(() => {
    const sorted = [...data.byProject].sort((a, b) => pickMetric(b, metric) - pickMetric(a, metric))
    const top = sorted.slice(0, TOP)
    const rest = sorted.slice(TOP)
    return { top, rest, restValue: rest.reduce((s, p) => s + pickMetric(p, metric), 0) }
  }, [data.byProject, metric])

  const nameOfProject = (id: string) => {
    const p = data.byProject.find((x) => x.projectId === id)
    return p ? projectName(p, t) : id
  }
  const insights = useMemo(
    () =>
      buildInsights(
        data,
        {
          project: nameOfProject,
          weekday: (d) => new Date(2026, 0, 4 + d).toLocaleDateString(locale, { weekday: "long" }),
          cost: formatCost,
        },
        locale,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, locale],
  )

  if (data.days.length === 0) return <EmptyNote>{t("analytics.noData")}</EmptyNote>

  const active = Math.max(data.activeDays, 1)
  const hoursTotal = data.totalHours
  const averages = [
    { label: t("usage.averages.perActiveDay"), value: `${formatHours(hoursTotal / active, locale)} · ${formatCost(data.totalCost / active)}` },
    {
      label: t("usage.averages.perSession"),
      value: `${formatDuration(hoursTotal / Math.max(data.totalSessions, 1))} · ${t("usage.averages.messages", { count: Math.round(data.totalMessages / Math.max(data.totalSessions, 1)) })}`,
    },
    { label: t("usage.averages.perMessage"), value: t("usage.averages.tokens", { value: formatTokens(Math.round(data.totalTokens / Math.max(data.totalMessages, 1))) }) },
    { label: t("usage.averages.costPerHour"), value: hoursTotal > 0 ? formatCost(data.totalCost / hoursTotal) : "—" },
    { label: t("usage.averages.sessionsPerActiveDay"), value: String(Math.round(data.totalSessions / active)) },
    { label: t("usage.averages.yourHoursPerActiveDay"), value: formatHours(data.userHours / active, locale) },
  ]

  return (
    <div className="flex flex-col gap-3 @[80rem]:gap-4">
      <div className="grid grid-cols-2 gap-3 @[48rem]:grid-cols-4 @[80rem]:gap-4">
        <StatCard
          label={t("usage.cards.tokens")}
          value={formatTokens(data.totalTokens)}
          color={SERIES_COLORS[0]}
          spark={sparkOf((p) => p.tokens)}
          footer={<Delta current={data.totalTokens} previous={previous?.tokens} />}
        />
        <StatCard
          label={t("usage.cards.orbitHours")}
          value={formatHours(data.orbitHours, locale)}
          color={SERIES_COLORS[1]}
          spark={sparkOf((p) => p.orbitHours)}
          footer={<Delta current={data.orbitHours} previous={previous?.orbitHours} />}
        />
        <StatCard
          label={t("usage.cards.yourHours")}
          value={formatHours(data.userHours, locale)}
          color={SERIES_COLORS[3]}
          spark={sparkOf((p) => p.userHours)}
          footer={<Delta current={data.userHours} previous={previous?.userHours} />}
        />
        <StatCard
          label={t("usage.cards.cost")}
          value={formatCost(data.totalCost)}
          color={SERIES_COLORS[2]}
          spark={sparkOf((p) => p.cost)}
          footer={<Delta current={data.totalCost} previous={previous?.cost} lowerIsBetter />}
        />
      </div>

      <Card>
        <CardHeader
          title={t("usage.perDay.title")}
          subtitle={t("usage.perDay.subtitle", {
            total: formatMetric(series.reduce((s, p) => s + p.value, 0), metric, locale),
          })}
          action={
            <SegmentedControl<Metric>
              size="sm"
              value={metric}
              onChange={setMetric}
              options={[
                { value: "hours", label: t("analytics.hours") },
                { value: "tokens", label: t("analytics.tokens") },
                { value: "cost", label: t("analytics.cost") },
              ]}
            />
          }
        />
        <DayBars points={series} metric={metric} />
      </Card>

      <div className="grid gap-3 @[48rem]:grid-cols-2 @[80rem]:gap-4">
        <Card className="flex flex-col">
          <CardHeader
            title={t("usage.models.title")}
            action={
              <Button size="sm" variant="outline" className="gap-1" onClick={() => onNavigate("models")}>
                {t("usage.models.seeAll")} <ArrowRight className="size-3" />
              </Button>
            }
          />
          {modelRows.top.map((m) => (
            <ShareRow
              key={modelKeyOf(m)}
              name={m.modelId}
              value={formatMetric(pickMetric(m, metric), metric, locale)}
              pct={percent(pickMetric(m, metric), totalOf)}
              color={modelColors.get(modelKeyOf(m)) ?? OTHERS_COLOR}
            />
          ))}
          {modelRows.rest.length > 0 && (
            <ShareRow
              name={t("usage.others", { count: modelRows.rest.length })}
              value={formatMetric(modelRows.restValue, metric, locale)}
              pct={percent(modelRows.restValue, totalOf)}
              color={OTHERS_COLOR}
            />
          )}
        </Card>

        <Card className="flex flex-col">
          <CardHeader
            title={t("usage.projects.title")}
            action={
              <Button size="sm" variant="outline" className="gap-1" onClick={() => onNavigate("projects")}>
                {t("usage.projects.seeAll")} <ArrowRight className="size-3" />
              </Button>
            }
          />
          {projectRows.top.map((p) => (
            <ShareRow
              key={p.projectId}
              name={projectName(p, t)}
              value={formatMetric(pickMetric(p, metric), metric, locale)}
              pct={percent(pickMetric(p, metric), totalOf)}
              color={SERIES_COLORS[0]}
            />
          ))}
          {projectRows.rest.length > 0 && (
            <ShareRow
              name={t("usage.others", { count: projectRows.rest.length })}
              value={formatMetric(projectRows.restValue, metric, locale)}
              pct={percent(projectRows.restValue, totalOf)}
              color={OTHERS_COLOR}
            />
          )}
        </Card>
      </div>

      <div className="grid gap-3 @[48rem]:grid-cols-[minmax(0,1fr)_16rem] @[80rem]:grid-cols-[minmax(0,1fr)_20rem] @[80rem]:gap-4">
        {data.year ? <ActivityCard year={data.year} projects={data.yearProjects} metric={metric} /> : null}
        <Card className="flex flex-col gap-1">
          <p className="mb-1 text-[13px] font-semibold @[80rem]:text-base">{t("usage.averages.title")}</p>
          {averages.map((a) => (
            <div key={a.label} className="flex justify-between gap-2 border-b py-1 text-[11px] @[80rem]:py-1.5 @[80rem]:text-sm last:border-b-0">
              <span className="text-muted-foreground">{a.label}</span>
              <span className="text-right tabular-nums">{a.value}</span>
            </div>
          ))}
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t("usage.averages.span", { days: spanOfDays(data.days), active: data.activeDays })}
          </p>
        </Card>
      </div>

      {insights.length > 0 && (
        <Card>
          <p className="mb-2 text-[13px] font-semibold">{t("usage.insights.title")}</p>
          <ul className="grid gap-x-8 gap-y-1.5 text-[11px] @[80rem]:text-sm text-foreground/80 @[38rem]:grid-cols-2">
            {insights.map((insight) => (
              <li key={insight.key} className="flex items-baseline gap-2 leading-snug">
                <span className="size-1.5 shrink-0 -translate-y-px rounded-full bg-primary" aria-hidden />
                {t(`usage.insights.${insight.key}`, insight.params)}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}
