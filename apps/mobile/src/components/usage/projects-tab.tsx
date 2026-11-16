import { useMemo, useState } from 'react'
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { AlertCircle, Folder, Info, Sparkles } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { AnalyticsRange, AnalyticsSummary, ProjectBreakdown } from '@orbit/shared'
import { BottomSheet } from '~/components/ui/bottom-sheet'
import { formatCost, formatTokens } from '~/lib/format'
import { useConnectionStore } from '~/stores/connection-store'
import { tint, useTokens } from '~/components/list/parts'
import { Empty } from './usage-ui'
import { RankDetail, RankList, type RankItem } from './rank-list'
import { type Metric, type SeriesPoint, SERIES_COLORS, dateKey, formatHours, formatMetric, modelKeyOf, parseDay, percent, pickMetric, projectLabel } from './usage-utils'

const COLOR = SERIES_COLORS[0]

type SummaryState = { status: 'loading' } | { status: 'done'; text: string } | { status: 'error'; error: 'no-aux-model' | 'nothing' | 'failed'; message?: string }

/** Asks the desktop's auxiliary model for the "what was done" of a project over the period. */
function useSummary(projectId: string, range: AnalyticsRange, language: string) {
  const wsClient = useConnectionStore((s) => s.wsClient)
  const [state, setState] = useState<SummaryState | undefined>()
  const run = async () => {
    setState({ status: 'loading' })
    try {
      const res = await wsClient.send({ type: 'analytics:summarize', input: { projectId, range, language } })
      const result = res.data as { ok: boolean; text?: string; error?: 'no-aux-model' | 'nothing' | 'failed'; message?: string } | undefined
      setState(res.ok && result?.ok ? { status: 'done', text: result.text ?? '' } : { status: 'error', error: result?.error ?? 'failed', message: result?.message ?? res.error })
    } catch (err) {
      setState({ status: 'error', error: 'failed', message: err instanceof Error ? err.message : String(err) })
    }
  }
  return { state, run, close: () => setState(undefined) }
}

function SummaryButton({ state, onRun, onClose }: { state?: SummaryState; onRun: () => void; onClose: () => void }) {
  const { t } = useTranslation()
  const tokens = useTokens()
  const loading = state?.status === 'loading'
  return (
    <Pressable disabled={loading} onPress={state?.status === 'done' ? onClose : onRun} accessibilityRole="button" style={[s.sumBtn, { borderColor: tokens.border }, loading && { opacity: 0.6 }]}>
      {loading ? <ActivityIndicator size="small" color={tokens.foreground} /> : <Sparkles size={13} color={tokens.foreground} />}
      <Text style={{ fontSize: 12.5, fontWeight: '500', color: tokens.foreground }}>
        {loading ? t('usageScreen.summary.loading') : state?.status === 'done' ? t('usageScreen.summary.hide') : t('usageScreen.summary.short')}
      </Text>
    </Pressable>
  )
}

function SummaryBox({ state }: { state?: SummaryState }) {
  const { t } = useTranslation()
  const tokens = useTokens()
  if (!state || state.status === 'loading') return null
  if (state.status === 'done') {
    return (
      <View style={[s.sumBox, { borderColor: tint(tokens.primary, '4D'), backgroundColor: tint(tokens.primary, '0D') }]}>
        <Text style={{ marginBottom: 4, fontSize: 11, color: tokens.mutedForeground }}>{t('usageScreen.summary.generated')}</Text>
        <Text style={{ fontSize: 13, lineHeight: 19, color: tokens.foreground }}>{state.text}</Text>
      </View>
    )
  }
  return (
    <View style={[s.sumBox, { flexDirection: 'row', gap: 6, borderColor: tint(tokens.destructive, '66'), backgroundColor: tint(tokens.destructive, '1A') }]}>
      <AlertCircle size={14} color={tokens.destructive} style={{ marginTop: 2 }} />
      <Text style={{ flex: 1, fontSize: 12.5, color: tokens.destructive }}>{state.error === 'failed' && state.message ? state.message : t(`usageScreen.summary.error.${state.error}`)}</Text>
    </View>
  )
}

/** Every project of the period — the same list as the models; a tap opens that project. */
export function ProjectsTab({ data, range }: { data: AnalyticsSummary; range: AnalyticsRange }) {
  const { t } = useTranslation()
  const tokens = useTokens()
  const [selected, setSelected] = useState<string | null>(null)
  const [rank, setRank] = useState<Metric>('tokens')
  const [infoOpen, setInfoOpen] = useState(false)
  const sorted = useMemo(() => [...data.byProject].sort((a, b) => pickMetric(b, rank) - pickMetric(a, rank)), [data.byProject, rank])
  const project = selected ? data.byProject.find((p) => p.projectId === selected) : undefined
  const total = { hours: data.totalHours, tokens: data.totalTokens, cost: data.totalCost }[rank]

  if (data.byProject.length === 0) return <Empty>{t('usageScreen.noUsageInPeriod')}</Empty>
  if (project) return <ProjectDetail data={data} project={project} range={range} onBack={() => setSelected(null)} />

  const items: RankItem[] = sorted.map((p) => ({
    key: p.projectId,
    tile: <Folder size={18} color={tokens.mutedForeground} />,
    tileColor: tokens.muted,
    name: projectLabel(p, t('usageScreen.noProject')),
    sub: t('usageScreen.sessionsCount', { count: p.sessions }),
    pct: percent(pickMetric(p, rank), total),
    value: formatMetric(pickMetric(p, rank), rank),
    color: COLOR,
  }))
  return (
    <>
      <RankList
        title={t('usageScreen.projectsTitle')}
        hint={t('usageScreen.projectsHint')}
        metric={rank}
        onMetric={setRank}
        items={items}
        onOpen={setSelected}
        footer={
          <Pressable onPress={() => setInfoOpen(true)} accessibilityRole="button" style={s.note}>
            <Info size={14} color={tokens.mutedForeground} style={{ marginTop: 2 }} />
            <Text style={{ flex: 1, fontSize: 11.5, lineHeight: 17, color: tokens.mutedForeground }}>{t('usageScreen.hoursNote')}</Text>
          </Pressable>
        }
      />
      <BottomSheet
        open={infoOpen}
        onClose={() => setInfoOpen(false)}
        title={<Text style={{ fontSize: 17, fontWeight: '600', color: tokens.foreground, paddingVertical: 8 }}>{t('usageScreen.hoursByProjectInfoTitle')}</Text>}
      >
        <Text style={{ fontSize: 13, lineHeight: 20, color: tokens.mutedForeground }}>{t('usageScreen.hoursByProjectInfo')}</Text>
      </BottomSheet>
    </>
  )
}

function ProjectDetail({ data, project, range, onBack }: { data: AnalyticsSummary; project: ProjectBreakdown; range: AnalyticsRange; onBack: () => void }) {
  const { t, i18n } = useTranslation()
  const language = i18n.language.toLowerCase().startsWith('pt') ? 'Portuguese' : 'English'
  const summary = useSummary(project.projectId, range, language)

  // Hours this project worked on each day of the period, contiguous.
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
      const slice = byDate.get(dk)?.byProject.find((p) => p.projectId === project.projectId)
      return { date: dk, value: slice?.hours ?? 0, hours: slice?.hours ?? 0, tokens: slice?.tokens ?? 0, cost: slice?.cost ?? 0, orbitHours: slice?.orbitHours ?? 0, userHours: slice?.userHours ?? 0 }
    })
  }, [data.days, project.projectId])

  // Which models the project used: the slices of each model that belong to it.
  const shares = useMemo(
    () =>
      data.byModel
        .map((m) => ({ m, hours: m.byProject?.find((x) => x.projectId === project.projectId)?.hours ?? 0 }))
        .filter((x) => x.hours > 0)
        .sort((a, b) => b.hours - a.hours)
        .map(({ m, hours }) => ({ key: modelKeyOf(m), name: m.modelId, value: formatHours(hours), pct: percent(hours, project.hours) })),
    [data.byModel, project],
  )

  return (
    <RankDetail
      data={data}
      backLabel={t('usageScreen.projectsTitle')}
      title={projectLabel(project, t('usageScreen.noProject'))}
      subtitle={project.directory}
      color={COLOR}
      action={<SummaryButton state={summary.state} onRun={() => void summary.run()} onClose={summary.close} />}
      extra={<SummaryBox state={summary.state} />}
      kpis={[
        { label: t('usageScreen.metricTokens'), value: formatTokens(project.tokens), meta: t('usageScreen.ofTotal', { pct: percent(project.tokens, data.totalTokens) }) },
        { label: t('usageScreen.metricHours'), value: formatHours(project.hours), meta: t('usageScreen.ofTotal', { pct: percent(project.hours, data.totalHours) }) },
        { label: t('usageScreen.projSessions'), value: String(project.sessions), meta: t('usageScreen.eachSession', { value: formatHours(project.hours / Math.max(project.sessions, 1)) }) },
        { label: t('usageScreen.metricCost'), value: formatCost(project.cost), meta: t('usageScreen.ofTotal', { pct: percent(project.cost, data.totalCost) }) },
        { label: t('usageScreen.costPerMillion'), value: project.tokens > 0 ? formatCost((project.cost / project.tokens) * 1_000_000) : '—', meta: t('usageScreen.avgPeriod') },
        { label: t('usageScreen.costPerHour'), value: project.hours > 0 ? formatCost(project.cost / project.hours) : '—', meta: t('usageScreen.avgPeriod') },
      ]}
      points={points}
      shareTitle={t('usageScreen.modelsUsed')}
      shares={shares}
      sessions={(data.sessions ?? []).filter((x) => x.projectId === project.projectId).sort((a, b) => b.startAt - a.startAt).slice(0, 8)}
      onBack={onBack}
    />
  )
}

const s = StyleSheet.create({
  note: { flexDirection: 'row', gap: 8, paddingHorizontal: 4 },
  sumBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 36, paddingHorizontal: 11, borderWidth: 1, borderRadius: 10 },
  sumBox: { padding: 12, borderWidth: 1, borderRadius: 12 },
})
