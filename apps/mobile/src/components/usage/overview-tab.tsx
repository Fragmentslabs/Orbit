import { useMemo, useState } from 'react'
import { View, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import type { AnalyticsSummary } from '@orbit/shared'
import { formatCost, formatTokens } from '~/lib/format'
import { Delta, DayBars, KeyRow, ShareRow, SeeAll, StatCard, TextSegment, UCard, metricItems, Empty } from './usage-ui'
import {
  type Metric,
  type UsageSection,
  OTHERS_COLOR,
  SERIES_COLORS,
  buildSeries,
  colorsByModel,
  formatHours,
  formatMetric,
  modelKeyOf,
  percent,
  pickMetric,
  projectLabel,
  sample,
  spanOfDays,
} from './usage-utils'

/** How many entries a ranking card shows before folding the rest into "Others". */
const TOP = 3

function weekdayShort(date: string, locale: string, dense: boolean): string {
  const [y, m, d] = date.split('-').map(Number)
  const day = new Date(y, m - 1, d)
  return dense ? String(day.getDate()) : day.toLocaleDateString(locale, { weekday: 'short' }).replace('.', '')
}

/** The summary of everything — the same four numbers, per-day chart and rankings as the desktop. */
export function OverviewTab({ data, onNavigate }: { data: AnalyticsSummary; onNavigate: (section: UsageSection) => void }) {
  const { t, i18n } = useTranslation()
  const [metric, setMetric] = useState<Metric>('hours')

  const series = useMemo(() => buildSeries(data.days, metric), [data.days, metric])
  const sparks = useMemo(() => {
    const all = buildSeries(data.days, 'hours')
    return {
      tokens: sample(all.map((p) => p.tokens)),
      orbit: sample(all.map((p) => p.orbitHours)),
      user: sample(all.map((p) => p.userHours)),
      cost: sample(all.map((p) => p.cost)),
    }
  }, [data.days])
  const modelColors = useMemo(() => colorsByModel(data.byModel), [data.byModel])
  const previous = data.previous
  const totalOf = { hours: data.totalHours, tokens: data.totalTokens, cost: data.totalCost }[metric]

  const rank = <T extends { hours?: number; tokens?: number; cost?: number }>(list: T[]) => {
    const sorted = [...list].sort((a, b) => pickMetric(b, metric) - pickMetric(a, metric))
    const rest = sorted.slice(TOP)
    return { top: sorted.slice(0, TOP), rest, restValue: rest.reduce((sum, x) => sum + pickMetric(x, metric), 0) }
  }
  const modelRows = useMemo(() => rank(data.byModel), [data.byModel, metric]) // eslint-disable-line react-hooks/exhaustive-deps
  const projectRows = useMemo(() => rank(data.byProject), [data.byProject, metric]) // eslint-disable-line react-hooks/exhaustive-deps

  if (data.days.length === 0) return <Empty>{t('usageScreen.noUsageInPeriod')}</Empty>

  const active = Math.max(data.activeDays, 1)
  const sessions = Math.max(data.totalSessions, 1)
  const dense = series.length > 10
  const averages = [
    { label: t('usageScreen.avgPerActiveDay'), value: `${formatHours(data.totalHours / active)} · ${formatCost(data.totalCost / active)}` },
    { label: t('usageScreen.avgPerSession'), value: `${formatHours(data.totalHours / sessions)} · ${t('usageScreen.avgMessages', { count: Math.round(data.totalMessages / sessions) })}` },
    { label: t('usageScreen.avgPerMessage'), value: t('usageScreen.avgTokens', { value: formatTokens(Math.round(data.totalTokens / Math.max(data.totalMessages, 1))) }) },
    { label: t('usageScreen.avgCostPerHour'), value: data.totalHours > 0 ? formatCost(data.totalCost / data.totalHours) : '—' },
    { label: t('usageScreen.avgYourHours'), value: formatHours(data.userHours / active) },
  ]

  return (
    <View style={{ gap: 10 }}>
      <View style={s.pair}>
        <StatCard label={t('usageScreen.cardTokens')} value={formatTokens(data.totalTokens)} color={SERIES_COLORS[0]} spark={sparks.tokens} footer={<Delta current={data.totalTokens} previous={previous?.tokens} />} />
        <StatCard label={t('usageScreen.cardOrbitHours')} value={formatHours(data.orbitHours)} color={SERIES_COLORS[1]} spark={sparks.orbit} footer={<Delta current={data.orbitHours} previous={previous?.orbitHours} />} />
      </View>
      <View style={s.pair}>
        <StatCard label={t('usageScreen.cardYourHours')} value={formatHours(data.userHours)} color={SERIES_COLORS[3]} spark={sparks.user} footer={<Delta current={data.userHours} previous={previous?.userHours} />} />
        <StatCard label={t('usageScreen.cardCost')} value={formatCost(data.totalCost)} color={SERIES_COLORS[2]} spark={sparks.cost} footer={<Delta current={data.totalCost} previous={previous?.cost} lowerIsBetter />} />
      </View>

      <UCard
        title={t('usageScreen.perDayTitle')}
        subtitle={t('usageScreen.perDayTotal', { total: formatMetric(series.reduce((sum, p) => sum + p.value, 0), metric) })}
        action={<TextSegment items={metricItems(t)} value={metric} onChange={setMetric} />}
      >
        <DayBars points={series} metric={metric} format={(v) => formatMetric(v, metric)} weekday={(date) => weekdayShort(date, i18n.language, dense)} />
      </UCard>

      <UCard title={t('usageScreen.modelsTitle')} action={<SeeAll label={t('usageScreen.seeAll')} onPress={() => onNavigate('models')} />}>
        <View>
          {modelRows.top.map((m, i) => (
            <ShareRow
              key={modelKeyOf(m)}
              name={m.modelId}
              value={formatMetric(pickMetric(m, metric), metric)}
              pct={percent(pickMetric(m, metric), totalOf)}
              color={modelColors.get(modelKeyOf(m)) ?? OTHERS_COLOR}
              last={i === modelRows.top.length - 1 && modelRows.rest.length === 0}
            />
          ))}
          {modelRows.rest.length > 0 ? (
            <ShareRow name={t('usageScreen.others', { count: modelRows.rest.length })} value={formatMetric(modelRows.restValue, metric)} pct={percent(modelRows.restValue, totalOf)} color={OTHERS_COLOR} last />
          ) : null}
        </View>
      </UCard>

      <UCard title={t('usageScreen.projectsTitle')} action={<SeeAll label={t('usageScreen.seeAll')} onPress={() => onNavigate('projects')} />}>
        <View>
          {projectRows.top.map((p, i) => (
            <ShareRow
              key={p.projectId}
              name={projectLabel(p, t('usageScreen.noProject'))}
              value={formatMetric(pickMetric(p, metric), metric)}
              pct={percent(pickMetric(p, metric), totalOf)}
              color={SERIES_COLORS[0]}
              last={i === projectRows.top.length - 1 && projectRows.rest.length === 0}
            />
          ))}
          {projectRows.rest.length > 0 ? (
            <ShareRow name={t('usageScreen.others', { count: projectRows.rest.length })} value={formatMetric(projectRows.restValue, metric)} pct={percent(projectRows.restValue, totalOf)} color={OTHERS_COLOR} last />
          ) : null}
        </View>
      </UCard>

      <UCard title={t('usageScreen.averagesTitle')} subtitle={t('usageScreen.averagesSpan', { days: spanOfDays(data.days), active: data.activeDays })}>
        <View>
          {averages.map((a, i) => (
            <KeyRow key={a.label} label={a.label} value={a.value} last={i === averages.length - 1} />
          ))}
        </View>
      </UCard>
    </View>
  )
}

const s = StyleSheet.create({
  pair: { flexDirection: 'row', gap: 8 },
})
