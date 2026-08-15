import { useCallback, useEffect, useState } from 'react'
import { View, Text, Pressable, ScrollView, RefreshControl, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { ProviderLogo } from '~/components/ui/provider-logo'
import {
  ArrowLeft,
  BarChart3,
  MessageSquare,
  Coins,
  Clock,
  Flame,
  CalendarDays,
  Layers,
} from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { AnalyticsSummary, AnalyticsRange } from '@orbit/shared'
import { useConnectionStore } from '~/stores/connection-store'
import { useSettingsStore } from '~/stores/settings-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { SafeScreen } from '~/components/layout/SafeScreen'

function useRanges(): { id: AnalyticsRange; label: string }[] {
  const { t } = useTranslation()
  return [
    { id: 'today', label: t('usageScreen.rangeToday') },
    { id: '7d', label: t('usageScreen.range7d') },
    { id: '30d', label: t('usageScreen.range30d') },
    { id: 'total', label: t('usageScreen.rangeTotal') },
  ]
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatCost(cost: number): string {
  if (cost >= 100) return `$${cost.toFixed(0)}`
  if (cost >= 0.01) return `$${cost.toFixed(2)}`
  if (cost > 0) return `$${cost.toFixed(4)}`
  return '$0'
}

function formatHours(hours: number): string {
  if (hours >= 1) return `${hours.toFixed(1)}h`
  return `${Math.round(hours * 60)}min`
}

export default function UsageScreen() {
  const { t } = useTranslation()
  const RANGES = useRanges()
  const router = useRouter()
  const wsClient = useConnectionStore((s) => s.wsClient)
  const catalog = useSettingsStore((s) => s.catalog)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const [range, setRange] = useState<AnalyticsRange>('7d')
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null)
  const [loading, setLoading] = useState(false)

  const fetchSummary = useCallback(
    async (target: AnalyticsRange) => {
      setLoading(true)
      try {
        const res = await wsClient.send({ type: 'analytics:summary', range: target })
        if (res.ok && res.data) {
          setSummary(res.data as AnalyticsSummary)
        }
      } catch {
      } finally {
        setLoading(false)
      }
    },
    [wsClient],
  )

  useEffect(() => {
    void fetchSummary(range)
  }, [range, fetchSummary])

  const topModels = [...(summary?.byModel ?? [])].sort((a, b) => b.tokens - a.tokens).slice(0, 8)
  const maxTokens = topModels[0]?.tokens ?? 1

  return (
    <SafeScreen style={s.container}>
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.headerBtn}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <Text style={[s.headerTitle, { color: tokens.foreground }]}>{t('usageScreen.title')}</Text>
        <View style={s.headerBtn} />
      </View>

      <View style={[s.rangeRow, { backgroundColor: tokens.border }]}>
        {RANGES.map((r) => (
          <Pressable
            key={r.id}
            onPress={() => setRange(r.id)}
            style={[
              s.rangeBtn,
              range === r.id && { backgroundColor: tokens.background, borderWidth: 1, borderColor: tokens.muted },
            ]}
          >
            <Text style={[s.rangeText, { color: range === r.id ? tokens.foreground : tokens.mutedForeground }]}>{r.label}</Text>
          </Pressable>
        ))}
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 48 }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void fetchSummary(range)} tintColor={tokens.primary} />}
      >
        <View style={s.grid}>
          <StatCard icon={MessageSquare} label={t('usageScreen.messages')} value={String(summary?.totalMessages ?? 0)} />
          <StatCard icon={Layers} label={t('usageScreen.tokens')} value={formatTokens(summary?.totalTokens ?? 0)} />
          <StatCard icon={Coins} label={t('usageScreen.cost')} value={formatCost(summary?.totalCost ?? 0)} />
          <StatCard icon={Clock} label={t('usageScreen.hoursOfUse')} value={formatHours(summary?.totalHours ?? 0)} />
          <StatCard icon={CalendarDays} label={t('usageScreen.activeDays')} value={String(summary?.activeDays ?? 0)} />
          <StatCard
            icon={Flame}
            label={t('usageScreen.streak')}
            value={`${summary?.currentStreak ?? 0}d`}
            hint={summary?.longestStreak ? t('usageScreen.record', { days: summary.longestStreak }) : undefined}
          />
        </View>

        <Text style={[s.sectionLabel, { color: tokens.mutedForeground }]}>{t('usageScreen.byModel')}</Text>
        <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          {topModels.length === 0 ? (
            <View style={s.emptyBox}>
              <BarChart3 size={24} color={tokens.mutedForeground} />
              <Text style={[s.emptyText, { color: tokens.mutedForeground }]}>{t('usageScreen.noUsageInPeriod')}</Text>
            </View>
          ) : (
            topModels.map((model, index) => {
              const name =
                catalog?.[model.providerId]?.models[model.modelId]?.name ?? model.modelId
              const pct = Math.max(4, Math.round((model.tokens / maxTokens) * 100))
              return (
                <View
                  key={`${model.providerId}/${model.modelId}`}
                  style={[s.modelRow, index < topModels.length - 1 && { borderBottomWidth: 1, borderBottomColor: tokens.border }]}
                >
                  <ProviderLogo providerId={model.providerId} size={16} color={tokens.mutedForeground} />
                  <View style={{ flex: 1, gap: 4 }}>
                    <View style={s.modelTopRow}>
                      <Text style={[s.modelName, { color: tokens.foreground }]} numberOfLines={1}>{name}</Text>
                      <Text style={[s.modelTokens, { color: tokens.mutedForeground }]}>{t('usageScreen.tokensLabel', { tokens: formatTokens(model.tokens) })}</Text>
                    </View>
                    <View style={[s.barTrack, { backgroundColor: tokens.muted }]}>
                      <View style={[s.barFill, { width: `${pct}%`, backgroundColor: tokens.primary }]} />
                    </View>
                    <Text style={[s.modelMeta, { color: tokens.mutedForeground }]}>
                      {t('usageScreen.modelMeta', { messages: model.messages, hours: formatHours(model.hours), cost: formatCost(model.cost) })}
                    </Text>
                  </View>
                </View>
              )
            })
          )}
        </View>

        <Text style={[s.sectionLabel, { color: tokens.mutedForeground }]}>{t('usageScreen.sessions')}</Text>
        <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          <View style={s.inlineRow}>
            <Text style={[s.inlineLabel, { color: tokens.foreground }]}>{t('usageScreen.sessionsInPeriod')}</Text>
            <Text style={[s.inlineValue, { color: tokens.primary }]}>{summary?.totalSessions ?? 0}</Text>
          </View>
          <View style={[s.rowDivider, { backgroundColor: tokens.border }]} />
          <View style={s.inlineRow}>
            <Text style={[s.inlineLabel, { color: tokens.foreground }]}>{t('usageScreen.peakHour')}</Text>
            <Text style={[s.inlineValue, { color: tokens.primary }]}>
              {summary?.peakHour !== undefined ? `${String(summary.peakHour).padStart(2, '0')}:00` : '—'}
            </Text>
          </View>
        </View>
      </ScrollView>
    </SafeScreen>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof BarChart3
  label: string
  value: string
  hint?: string
}) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  return (
    <View style={[s.statCard, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
      <View style={s.statIconWrap}>
        <Icon size={15} color={tokens.primary} />
      </View>
      <Text style={[s.statValue, { color: tokens.foreground }]}>{value}</Text>
      <Text style={[s.statLabel, { color: tokens.mutedForeground }]}>{label}</Text>
      {hint ? <Text style={[s.statHint, { color: tokens.mutedForeground }]}>{hint}</Text> : null}
    </View>
  )
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  headerBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 16, fontWeight: '600' },

  rangeRow: {
    flexDirection: 'row',
    gap: 6,
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 12,
    padding: 3,
  },
  rangeBtn: { flex: 1, alignItems: 'center', borderRadius: 9, paddingVertical: 7 },
  rangeText: { fontSize: 12, fontWeight: '500' },

  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  statCard: {
    flexBasis: '30%',
    flexGrow: 1,
    borderRadius: 14,
    borderWidth: 1,
    padding: 12,
    gap: 2,
  },
  statIconWrap: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: 'rgba(245,166,35,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  statValue: { fontSize: 18, fontWeight: '700' },
  statLabel: { fontSize: 11 },
  statHint: { fontSize: 10, opacity: 0.7 },

  sectionLabel: {
    paddingHorizontal: 20,
    paddingTop: 22,
    paddingBottom: 8,
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  card: {
    marginHorizontal: 16,
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
  },

  emptyBox: { alignItems: 'center', gap: 8, paddingVertical: 28 },
  emptyText: { fontSize: 13 },

  modelRow: { flexDirection: 'row', gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  modelTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  modelName: { flex: 1, fontSize: 13, fontWeight: '600' },
  modelTokens: { fontSize: 11, fontFamily: 'monospace' },
  barTrack: { height: 4, borderRadius: 2, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 2 },
  modelMeta: { fontSize: 10 },

  inlineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  inlineLabel: { fontSize: 14 },
  inlineValue: { fontSize: 14, fontWeight: '600' },
  rowDivider: { height: 1, marginLeft: 16 },
})
