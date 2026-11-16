import type { ReactNode } from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { ChevronRight } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { AnalyticsSession, AnalyticsSummary } from '@orbit/shared'
import { useTokens } from '~/components/list/parts'
import { BackBar, DayBars, KpiGrid, ListIntro, ShareRow, TextSegment, UCard, metricItems } from './usage-ui'
import { SessionRows } from './session-rows'
import { type Metric, type SeriesPoint, formatHours, parseDay } from './usage-utils'

/** The metric choice every ranking shares: tokens first, then hours and cost. */
export const RANK_METRICS: Metric[] = ['tokens', 'hours', 'cost']

export interface RankItem {
  key: string
  /** The icon tile: a provider logo, a folder… */
  tile: ReactNode
  tileColor: string
  name: string
  sub: string
  /** Share of the total by the chosen metric, 0–100. */
  pct: number
  /** The value of the chosen metric, already formatted. */
  value: string
  color: string
}

/**
 * The list pattern of Models and Projects: the same row for both — position, icon, name and
 * subtitle, a bar with the share of the total and ONE number, the one of the chosen metric.
 * Everything else lives in the detail that opens on tap.
 */
export function RankList({ title, hint, metric, onMetric, items, onOpen, footer }: { title: string; hint: string; metric: Metric; onMetric: (m: Metric) => void; items: RankItem[]; onOpen: (key: string) => void; footer?: ReactNode }) {
  const { t } = useTranslation()
  const tokens = useTokens()
  const order = metricItems(t)
  return (
    <View style={{ gap: 10 }}>
      <ListIntro title={title} hint={hint} right={<TextSegment items={RANK_METRICS.map((k) => order.find((o) => o.key === k)!)} value={metric} onChange={onMetric} />} />
      <View style={[s.list, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
        {items.map((item, i) => (
          <Pressable
            key={item.key}
            onPress={() => onOpen(item.key)}
            accessibilityRole="button"
            style={({ pressed }) => [s.row, i > 0 && { borderTopWidth: 1, borderTopColor: tokens.border }, pressed && { backgroundColor: tokens.accent }]}
          >
            <Text style={{ width: 18, textAlign: 'center', fontSize: 12, color: tokens.mutedForeground, fontVariant: ['tabular-nums'] }}>{i + 1}</Text>
            <View style={[s.tile, { backgroundColor: item.tileColor }]}>{item.tile}</View>
            <View style={{ flex: 1, minWidth: 0, gap: 7 }}>
              <View>
                <Text numberOfLines={1} style={{ fontSize: 13.5, fontWeight: '500', color: tokens.foreground }}>
                  {item.name}
                </Text>
                <Text numberOfLines={1} style={{ marginTop: 1, fontSize: 11.5, color: tokens.mutedForeground }}>
                  {item.sub}
                </Text>
              </View>
              <View style={[s.track, { backgroundColor: tokens.muted }]}>
                <View style={{ width: `${Math.max(2, item.pct)}%`, height: '100%', borderRadius: 99, backgroundColor: item.color }} />
              </View>
            </View>
            <View style={{ alignItems: 'flex-end', minWidth: 50 }}>
              <Text style={{ fontSize: 14, fontWeight: '600', color: tokens.foreground, fontVariant: ['tabular-nums'] }}>{item.value}</Text>
              <Text style={{ fontSize: 11, color: tokens.mutedForeground, fontVariant: ['tabular-nums'] }}>{item.pct}%</Text>
            </View>
            <ChevronRight size={16} color={tokens.mutedForeground} />
          </Pressable>
        ))}
      </View>
      {footer}
    </View>
  )
}

export interface DetailShare {
  key: string
  name: string
  value: string
  pct: number
}

/**
 * The detail of a model or a project — one skeleton for both: back, six number cards, hours per
 * day, a split (where the model was used / which models the project used) and the recent sessions.
 */
export function RankDetail({
  data,
  backLabel,
  title,
  subtitle,
  color,
  action,
  extra,
  kpis,
  points,
  shareTitle,
  shares,
  sessions,
  onBack,
}: {
  data: AnalyticsSummary
  backLabel: string
  title: string
  subtitle?: string
  color: string
  action?: ReactNode
  /** Under the back bar (the summary box). */
  extra?: ReactNode
  kpis: { label: string; value: string; meta?: string }[]
  points: SeriesPoint[]
  shareTitle: string
  shares: DetailShare[]
  sessions: AnalyticsSession[]
  onBack: () => void
}) {
  const { t, i18n } = useTranslation()
  const dense = points.length > 10
  const dayLabel = (date: string) => {
    const day = parseDay(date)
    return dense ? String(day.getDate()) : day.toLocaleDateString(i18n.language, { weekday: 'short' }).replace('.', '')
  }
  const tokens = useTokens()
  const peak = points.reduce((best, p) => (p.value > best.value ? p : best), points[0])
  return (
    <View style={{ gap: 10 }}>
      <BackBar label={backLabel} title={title} subtitle={subtitle} dot={color} right={action} onBack={onBack} />
      {extra}
      <KpiGrid columns={3} items={kpis} />
      <UCard title={t('usageScreen.hoursPerDay')} subtitle={peak && peak.value > 0 ? t('usageScreen.peakDay', { value: formatHours(peak.value) }) : undefined}>
        <DayBars points={points} metric="hours" color={color} format={(v) => formatHours(v)} weekday={dayLabel} />
      </UCard>
      <UCard title={shareTitle}>
        {shares.length === 0 ? (
          <Text style={{ fontSize: 12.5, color: tokens.mutedForeground }}>{t('usageScreen.noUsageInPeriod')}</Text>
        ) : (
          <View>
            {shares.map((row, i) => (
              <ShareRow key={row.key} name={row.name} value={row.value} pct={row.pct} color={color} last={i === shares.length - 1} />
            ))}
          </View>
        )}
      </UCard>
      <ListIntro title={t('usageScreen.recentSessions')} />
      {data.sessions ? (
        <View style={[s.list, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          <SessionRows sessions={sessions} data={data} showDay />
        </View>
      ) : (
        <Text style={{ padding: 12, fontSize: 12.5, color: tokens.mutedForeground }}>{t('usageScreen.sessionsNeedUpdate')}</Text>
      )}
    </View>
  )
}

const s = StyleSheet.create({
  list: { borderWidth: 1, borderRadius: 16, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 76, paddingHorizontal: 12, paddingVertical: 10 },
  tile: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  track: { height: 6, borderRadius: 99, overflow: 'hidden' },
})
