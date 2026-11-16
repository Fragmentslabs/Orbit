/**
 * Pipeline page — mirror of the desktop's: two tabs. "Pipelines" is the list (the numbers on top,
 * search, counts, rows, foot line) and "Phases" is the library. "New" opens the menu that leads to
 * the creation chat first (or the form).
 */
import { useEffect, useMemo, useState } from 'react'
import { View, Text, Pressable, FlatList, ActivityIndicator, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { Info, Layers, Plus } from 'lucide-react-native'
import { usePipelineStore } from '~/stores/pipeline-store'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { LoadError } from '~/components/pipeline/load-error'
import { useCodeOnly } from '~/components/pipeline/use-code-only'
import { PipelineRow, pipelineCounts, realTasks } from '~/components/pipeline/pipeline-row'
import { PhaseLibrary } from '~/components/pipeline/phase-library'
import { CreateSheet } from '~/components/list/create-sheet'
import { CountLine, FootLine, HeaderButton, ListHeader, PageTabs, SearchField, Stat, useTokens } from '~/components/list/parts'
import { formatCost } from '~/lib/format'
import { useStartCreationChat } from '~/hooks/useCreationChat'

type Tab = 'pipelines' | 'phases'
const DAY_MS = 86_400_000

export default function PipelineListScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const tokens = useTokens()
  useCodeOnly()
  const pipelines = usePipelineStore((s) => s.pipelines)
  const projects = usePipelineStore((s) => s.projects)
  const templates = usePipelineStore((s) => s.templates)
  const tasksByPipeline = usePipelineStore((s) => s.tasksByPipeline)
  const loading = usePipelineStore((s) => s.loading)
  const loaded = usePipelineStore((s) => s.loaded)
  const error = usePipelineStore((s) => s.error)
  const fetch = usePipelineStore((s) => s.fetch)
  const startCreation = useStartCreationChat()

  const [tab, setTab] = useState<Tab>('pipelines')
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [now] = useState(() => Date.now())

  useEffect(() => {
    if (!loaded) void fetch()
  }, [loaded, fetch])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return pipelines
    return pipelines.filter((pipeline) => {
      const project = projects.find((p) => p.id === pipeline.projectId)
      return [pipeline.name, pipeline.branch, ...pipeline.phases.map((p) => p.name), ...(project?.folders ?? [])].some((field) =>
        field?.toLowerCase().includes(q),
      )
    })
  }, [pipelines, projects, query])

  const stats = useMemo(() => {
    const since = now - 30 * DAY_MS
    let running = 0
    let failed = 0
    let cost = 0
    let total = 0
    for (const pipeline of pipelines) {
      const tasks = realTasks(tasksByPipeline[pipeline.id] ?? [])
      const c = pipelineCounts(tasks)
      total += c.total
      running += c.running
      failed += c.failed
      for (const task of tasks) if (task.startedAt && Date.parse(task.startedAt) >= since) cost += task.cost
    }
    return { total, running, failed, cost }
  }, [pipelines, tasksByPipeline, now])

  const open = (id: string) => router.push(`/(main)/pipeline/${id}`)
  const counts = [
    t('pipeline.list.count', { count: pipelines.length }),
    ...(stats.running > 0 ? [t('pipeline.list.runningCount', { count: stats.running })] : []),
    ...(stats.failed > 0 ? [t('pipeline.list.failedCount', { count: stats.failed })] : []),
  ].join(' · ')

  const body = () => {
    if (error) return <LoadError />
    if (!loaded && loading) {
      return (
        <View style={s.center}>
          <ActivityIndicator color={tokens.primary} />
        </View>
      )
    }
    if (pipelines.length === 0 && tab !== 'phases') {
      return (
        <View style={s.center}>
          <Layers size={36} color={tokens.mutedForeground} style={{ opacity: 0.5 }} />
          <Text style={[s.emptyTitle, { color: tokens.foreground }]}>{t('pipeline.emptyTitle')}</Text>
          <Text style={[s.emptyText, { color: tokens.mutedForeground }]}>{t('pipeline.emptySubtitle')}</Text>
          <Pressable onPress={() => setCreating(true)} style={[s.emptyBtn, { borderColor: tokens.border }]}>
            <Layers size={15} color={tokens.foreground} />
            <Text style={{ fontSize: 13, fontWeight: '500', color: tokens.foreground }}>{t('pipeline.createFirst')}</Text>
          </Pressable>
        </View>
      )
    }
    if (tab === 'phases') return <PhaseLibrary templates={templates} />
    return (
      <>
        <View style={s.bar}>
          <SearchField value={query} onChange={setQuery} placeholder={t('pipeline.search')} />
        </View>
        <View style={s.stats}>
          <Stat label={t('pipeline.stats.pipelines')} value={String(pipelines.length)} />
          <Stat label={t('pipeline.stats.tasks')} value={String(stats.total)} />
          <Stat label={t('pipeline.stats.running')} value={String(stats.running)} />
          <Stat label={t('pipeline.stats.failed')} value={String(stats.failed)} bad={stats.failed > 0} />
        </View>
        <CountLine>{counts}</CountLine>
        {visible.length === 0 ? (
          <Text style={[s.noResults, { color: tokens.mutedForeground, borderColor: tokens.border }]}>
            {t('pipeline.noResults', { query: query.trim() })}
          </Text>
        ) : (
          <FlatList
            data={visible}
            keyExtractor={(p) => p.id}
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 12 }}
            renderItem={({ item }) => (
              <PipelineRow
                pipeline={item}
                project={projects.find((p) => p.id === item.projectId)}
                tasks={tasksByPipeline[item.id] ?? []}
                onOpen={() => open(item.id)}
              />
            )}
          />
        )}
        <FootLine icon={Info} text={t('pipeline.list.tail')} aside={t('pipeline.stats.spentFooter', { cost: formatCost(stats.cost) })} />
      </>
    )
  }

  return (
    <SafeScreen style={{ flex: 1 }}>
      <ListHeader
        title={t('pipeline.title')}
        subtitle={t('pipeline.headerSubtitle')}
        onBack={() => router.back()}
        right={<HeaderButton icon={Plus} label={t('pipeline.list.newShort')} onPress={() => setCreating(true)} />}
      />
      <PageTabs
        value={tab}
        onChange={setTab}
        items={[
          { key: 'pipelines', label: t('pipeline.tabPipelines'), count: pipelines.length },
          { key: 'phases', label: t('pipeline.tabPhases'), count: templates.length },
        ]}
      />
      {body()}
      <CreateSheet kind="pipeline" open={creating} onClose={() => setCreating(false)} onChat={(text) => void startCreation('pipeline', text)} onForm={() => router.push('/(main)/pipeline/new')} />
    </SafeScreen>
  )
}

const s = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 28 },
  emptyTitle: { fontSize: 15, fontWeight: '600' },
  emptyText: { fontSize: 12, textAlign: 'center', lineHeight: 18 },
  emptyBtn: { flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 44, borderRadius: 12, borderWidth: 1, paddingHorizontal: 16, marginTop: 6 },
  bar: { flexDirection: 'row', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  stats: { flexDirection: 'row', gap: 6, paddingHorizontal: 16, paddingBottom: 4 },
  noResults: { margin: 16, padding: 24, borderWidth: 1, borderStyle: 'dashed', borderRadius: 12, textAlign: 'center', fontSize: 12.5 },
})
