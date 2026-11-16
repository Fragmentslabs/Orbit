import { useMemo } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import type { AnalyticsSummary } from '@orbit/shared'
import { useTokens } from '~/components/list/parts'
import { Empty, KpiGrid, UCard } from './usage-ui'
import { WEEKDAY_ORDER, formatHours, hoursByWeekday, percent, spanOfDays } from './usage-utils'

/** When the work happens: the numbers of the rhythm, the hours per weekday, and how the hours are counted. */
export function RhythmTab({ data }: { data: AnalyticsSummary }) {
  const { t, i18n } = useTranslation()
  const tokens = useTokens()
  const weekdays = useMemo(() => hoursByWeekday(data.days), [data.days])
  const max = Math.max(...weekdays, Number.EPSILON)

  if (data.days.length === 0) return <Empty>{t('usageScreen.noUsageInPeriod')}</Empty>
  return (
    <View style={{ gap: 10 }}>
      <KpiGrid
        items={[
          { label: t('usageScreen.peakHour'), value: `${data.peakHour}h` },
          { label: t('usageScreen.currentStreak'), value: t('usageScreen.daysCount', { count: data.currentStreak }) },
          { label: t('usageScreen.longestStreak'), value: t('usageScreen.daysCount', { count: data.longestStreak }) },
          { label: t('usageScreen.activeDays'), value: t('usageScreen.activeOf', { active: data.activeDays, total: spanOfDays(data.days) }) },
          { label: t('usageScreen.sessions'), value: String(data.totalSessions) },
          { label: t('usageScreen.messages'), value: String(data.totalMessages) },
        ]}
      />
      <UCard title={t('usageScreen.byWeekday')} subtitle={t('usageScreen.byWeekdayHint')}>
        <View style={{ gap: 11 }}>
          {WEEKDAY_ORDER.map((day) => (
            <View key={day} style={s.dayRow}>
              <Text style={{ width: 38, fontSize: 12, color: tokens.mutedForeground, textTransform: 'capitalize' }}>
                {new Date(2026, 0, 4 + day).toLocaleDateString(i18n.language, { weekday: 'short' }).replace('.', '')}
              </Text>
              <View style={[s.track, { backgroundColor: tokens.muted }]}>
                <View style={{ width: `${percent(weekdays[day], max)}%`, height: '100%', borderRadius: 99, backgroundColor: tokens.primary }} />
              </View>
              <Text style={{ width: 66, textAlign: 'right', fontSize: 12, color: tokens.foreground, fontVariant: ['tabular-nums'] }}>{formatHours(weekdays[day])}</Text>
            </View>
          ))}
        </View>
      </UCard>
      <UCard title={t('usageScreen.hoursByProjectInfoTitle')}>
        <Text style={{ fontSize: 12, lineHeight: 18, color: tokens.mutedForeground }}>{t('usageScreen.hoursByProjectInfo')}</Text>
      </UCard>
    </View>
  )
}

const s = StyleSheet.create({
  dayRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  track: { flex: 1, height: 8, borderRadius: 99, overflow: 'hidden' },
})
