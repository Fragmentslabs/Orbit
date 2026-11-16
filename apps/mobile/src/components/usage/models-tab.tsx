import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AnalyticsSummary, ModelDayBreakdown } from '@orbit/shared'
import { ProviderLogo } from '~/components/ui/provider-logo'
import { formatCost, formatTokens } from '~/lib/format'
import { useSettingsStore } from '~/stores/settings-store'
import { tint } from '~/components/list/parts'
import { Empty } from './usage-ui'
import { RankDetail, RankList, type RankItem } from './rank-list'
import { type Metric, type SeriesPoint, colorsByModel, dateKey, formatHours, formatMetric, modelKeyOf, parseDay, percent, pickMetric, projectLabel } from './usage-utils'

const FALLBACK = '#6ea8fe'
const perMillion = (m: ModelDayBreakdown) => (m.tokens > 0 ? formatCost((m.cost / m.tokens) * 1_000_000) : '—')

/** The ranking of the models; a tap opens that model (where and when it was used). */
export function ModelsTab({ data }: { data: AnalyticsSummary }) {
  const { t } = useTranslation()
  const catalog = useSettingsStore((s) => s.catalog)
  const [selected, setSelected] = useState<string | null>(null)
  const [rank, setRank] = useState<Metric>('tokens')
  const colors = useMemo(() => colorsByModel(data.byModel), [data.byModel])
  const sorted = useMemo(() => [...data.byModel].sort((a, b) => pickMetric(b, rank) - pickMetric(a, rank)), [data.byModel, rank])
  const model = selected ? data.byModel.find((m) => modelKeyOf(m) === selected) : undefined
  const total = { hours: data.totalHours, tokens: data.totalTokens, cost: data.totalCost }[rank]

  if (data.byModel.length === 0) return <Empty>{t('usageScreen.noUsageInPeriod')}</Empty>
  if (model) return <ModelDetail data={data} model={model} color={colors.get(selected!) ?? FALLBACK} onBack={() => setSelected(null)} />

  const items: RankItem[] = sorted.map((m) => {
    const color = colors.get(modelKeyOf(m)) ?? FALLBACK
    return {
      key: modelKeyOf(m),
      tile: <ProviderLogo providerId={m.providerId} size={18} color={color} />,
      tileColor: tint(color, '29'),
      name: catalog?.[m.providerId]?.models[m.modelId]?.name ?? m.modelId,
      sub: t('usageScreen.modelSub', { provider: catalog?.[m.providerId]?.name ?? m.providerId, count: m.messages }),
      pct: percent(pickMetric(m, rank), total),
      value: formatMetric(pickMetric(m, rank), rank),
      color,
    }
  })
  return <RankList title={t('usageScreen.modelsTitle')} hint={t('usageScreen.modelsHint')} metric={rank} onMetric={setRank} items={items} onOpen={setSelected} />
}

function ModelDetail({ data, model, color, onBack }: { data: AnalyticsSummary; model: ModelDayBreakdown; color: string; onBack: () => void }) {
  const { t } = useTranslation()
  const catalog = useSettingsStore((s) => s.catalog)
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
      return { date: dk, value: slice?.hours ?? 0, hours: slice?.hours ?? 0, tokens: slice?.tokens ?? 0, cost: slice?.cost ?? 0, orbitHours: 0, userHours: 0 }
    })
  }, [data.days, key])

  const labelOf = (id: string) => {
    const p = data.byProject.find((x) => x.projectId === id)
    return p ? projectLabel(p, t('usageScreen.noProject')) : id
  }
  return (
    <RankDetail
      data={data}
      backLabel={t('usageScreen.modelsTitle')}
      title={catalog?.[model.providerId]?.models[model.modelId]?.name ?? model.modelId}
      subtitle={catalog?.[model.providerId]?.name ?? model.providerId}
      color={color}
      kpis={[
        { label: t('usageScreen.metricTokens'), value: formatTokens(model.tokens), meta: t('usageScreen.ofTotal', { pct: percent(model.tokens, data.totalTokens) }) },
        { label: t('usageScreen.metricHours'), value: formatHours(model.hours), meta: t('usageScreen.ofTotal', { pct: percent(model.hours, data.totalHours) }) },
        { label: t('usageScreen.replies'), value: String(model.messages), meta: t('usageScreen.tokensEach', { value: formatTokens(Math.round(model.tokens / Math.max(model.messages, 1))) }) },
        { label: t('usageScreen.metricCost'), value: formatCost(model.cost), meta: t('usageScreen.ofTotal', { pct: percent(model.cost, data.totalCost) }) },
        { label: t('usageScreen.costPerMillion'), value: perMillion(model), meta: t('usageScreen.avgPeriod') },
        { label: t('usageScreen.costPerHour'), value: model.hours > 0 ? formatCost(model.cost / model.hours) : '—', meta: t('usageScreen.avgPeriod') },
      ]}
      points={points}
      shareTitle={t('usageScreen.whereUsed')}
      shares={(model.byProject ?? []).map((p) => ({ key: p.projectId, name: labelOf(p.projectId), value: formatHours(p.hours), pct: percent(p.hours, model.hours) }))}
      sessions={(data.sessions ?? []).filter((x) => modelKeyOf(x) === key).slice(0, 8)}
      onBack={onBack}
    />
  )
}
