/**
 * Usage screen — mirror of the desktop's usage page: the period in the header (a sheet), the
 * sections as tabs, and the overview with its four numbers, per-day chart and rankings. The
 * summary comes from the desktop over the WS, asked in its detailed form (previous period, list
 * of sessions); an older desktop answers the compact one and the screen drops what it lacks.
 */
import { useCallback, useEffect, useState } from 'react'
import { View, Text, Pressable, ScrollView, RefreshControl, ActivityIndicator, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { CalendarDays, ChevronDown } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { AnalyticsSummary, AnalyticsRange, CustomAnalyticsRange } from '@orbit/shared'
import { useConnectionStore } from '~/stores/connection-store'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { CustomRangeModal, rangeLabel } from '~/components/usage/custom-range-modal'
import { RangeSheet } from '~/components/usage/range-sheet'
import { OverviewTab } from '~/components/usage/overview-tab'
import { ModelsTab } from '~/components/usage/models-tab'
import { ProjectsTab } from '~/components/usage/projects-tab'
import { SessionsTab } from '~/components/usage/sessions-tab'
import { RhythmTab } from '~/components/usage/rhythm-tab'
import type { UsageSection } from '~/components/usage/usage-utils'
import { ListHeader, PageTabs, useTokens } from '~/components/list/parts'

export default function UsageScreen() {
  const { t, i18n } = useTranslation()
  const router = useRouter()
  const tokens = useTokens()
  const wsClient = useConnectionStore((s) => s.wsClient)

  const [range, setRange] = useState<AnalyticsRange>('7d')
  const [section, setSection] = useState<UsageSection>('overview')
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [rangeOpen, setRangeOpen] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)
  const [now] = useState(() => Date.now())

  const customRange = typeof range === 'object' && range.type === 'custom' ? (range as CustomAnalyticsRange) : null

  const fetchSummary = useCallback(
    async (target: AnalyticsRange) => {
      setLoading(true)
      try {
        const res = await wsClient.send({ type: 'analytics:summary', range: target, detailed: true })
        if (res.ok && res.data) setSummary(res.data as AnalyticsSummary)
      } catch {
        // keeps the last summary on the screen
      } finally {
        setLoading(false)
      }
    },
    [wsClient],
  )

  useEffect(() => {
    // Fetching in an effect is the documented React pattern; the setState the rule flags is the
    // loading marker that MUST happen before the await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchSummary(range)
  }, [range, fetchSummary])

  const periodLabel = customRange
    ? rangeLabel(customRange, i18n.language)
    : t(`usageScreen.${{ today: 'rangeToday', '7d': 'range7d', '30d': 'range30d', total: 'rangeTotal' }[range as 'today' | '7d' | '30d' | 'total']}`)

  return (
    <SafeScreen style={{ flex: 1 }}>
      <ListHeader
        title={t('usageScreen.title')}
        subtitle={summary ? t('usageScreen.headerActive', { count: summary.activeDays }) : undefined}
        onBack={() => router.back()}
        right={
          <Pressable
            onPress={() => setRangeOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={t('usageScreen.periodTitle')}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            style={[s.period, { borderColor: tokens.border }]}
          >
            <CalendarDays size={14} color={tokens.mutedForeground} />
            <Text numberOfLines={1} style={{ maxWidth: 150, fontSize: 13, fontWeight: '500', color: tokens.foreground }}>
              {periodLabel}
            </Text>
            <ChevronDown size={14} color={tokens.mutedForeground} />
          </Pressable>
        }
      />
      <PageTabs
        scroll
        value={section}
        onChange={setSection}
        items={[
          { key: 'overview', label: t('usageScreen.navOverview') },
          { key: 'models', label: t('usageScreen.navModels'), count: summary?.byModel.length },
          { key: 'projects', label: t('usageScreen.navProjects'), count: summary?.byProject.length },
          { key: 'sessions', label: t('usageScreen.navSessions'), count: summary?.totalSessions },
          { key: 'rhythm', label: t('usageScreen.navRhythm') },
        ]}
      />

      {!summary ? (
        <View style={s.center}>{loading ? <ActivityIndicator color={tokens.primary} /> : <Text style={{ fontSize: 13, color: tokens.mutedForeground }}>{t('usageScreen.noUsageInPeriod')}</Text>}</View>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void fetchSummary(range)} tintColor={tokens.primary} />}
        >
          {section === 'overview' && <OverviewTab data={summary} onNavigate={setSection} />}
          {section === 'models' && <ModelsTab data={summary} />}
          {section === 'projects' && <ProjectsTab data={summary} range={range} />}
          {section === 'sessions' && <SessionsTab data={summary} />}
          {section === 'rhythm' && <RhythmTab data={summary} />}
        </ScrollView>
      )}

      <RangeSheet
        open={rangeOpen}
        range={range}
        now={now}
        customLabel={customRange ? rangeLabel(customRange, i18n.language) : null}
        onClose={() => setRangeOpen(false)}
        onPick={(next) => {
          setRange(next)
          setRangeOpen(false)
        }}
        onCustom={() => {
          setRangeOpen(false)
          setCustomOpen(true)
        }}
      />
      <CustomRangeModal
        visible={customOpen}
        currentValue={customRange}
        onCancel={() => setCustomOpen(false)}
        onConfirm={(next) => {
          setRange(next)
          setCustomOpen(false)
        }}
      />
    </SafeScreen>
  )
}

const s = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  period: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 11, borderWidth: 1, borderRadius: 10, marginRight: 6 },
})
