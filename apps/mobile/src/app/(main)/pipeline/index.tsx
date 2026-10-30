/**
 * Pipeline list — mirror of the desktop PipelineList: cards with name, phases in
 * a row, project folder and task summary. "New pipeline" opens the
 * /pipeline/new route; opening a card goes to the board /pipeline/[id].
 */
import { useEffect } from 'react'
import { View, Text, Pressable, FlatList, ActivityIndicator, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Layers, Plus } from 'lucide-react-native'
import { usePipelineStore } from '~/stores/pipeline-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { PipelineCard } from '~/components/pipeline/pipeline-card'
import { LoadError } from '~/components/pipeline/load-error'
import { useCodeOnly } from '~/components/pipeline/use-code-only'

export default function PipelineListScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  useCodeOnly()

  const pipelines = usePipelineStore((s) => s.pipelines)
  const projects = usePipelineStore((s) => s.projects)
  const tasksByPipeline = usePipelineStore((s) => s.tasksByPipeline)
  const loading = usePipelineStore((s) => s.loading)
  const loaded = usePipelineStore((s) => s.loaded)
  const error = usePipelineStore((s) => s.error)
  const fetch = usePipelineStore((s) => s.fetch)

  useEffect(() => {
    if (!loaded) void fetch()
  }, [loaded, fetch])

  return (
    <SafeScreen style={{ flex: 1 }}>
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.headerButton}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <View style={{ minWidth: 0, flex: 1, gap: 1 }}>
          <Text style={[s.title, { color: tokens.foreground }]}>{t('pipeline.title')}</Text>
          <Text style={[s.subtitle, { color: tokens.mutedForeground }]}>{t('pipeline.subtitle')}</Text>
        </View>
        <Pressable onPress={() => router.push('/(main)/pipeline/new')} style={[s.newButton, { backgroundColor: tokens.primary }]}>
          <Plus size={15} color={tokens.primaryForeground} />
          <Text style={[s.newButtonText, { color: tokens.primaryForeground }]}>{t('pipeline.newPipeline')}</Text>
        </Pressable>
      </View>

      {error ? (
        <LoadError />
      ) : !loaded && loading ? (
        <View style={s.centerBox}>
          <ActivityIndicator color={tokens.primary} />
        </View>
      ) : pipelines.length === 0 ? (
        <View style={s.centerBox}>
          <Layers size={36} color={tokens.mutedForeground} style={{ opacity: 0.5 }} />
          <Text style={[s.emptyTitle, { color: tokens.foreground }]}>{t('pipeline.emptyTitle')}</Text>
          <Text style={[s.emptyDescription, { color: tokens.mutedForeground }]}>{t('pipeline.emptySubtitle')}</Text>
          <Pressable
            onPress={() => router.push('/(main)/pipeline/new')}
            style={[s.emptyButton, { borderColor: tokens.border }]}
          >
            <Layers size={15} color={tokens.foreground} />
            <Text style={[s.emptyButtonText, { color: tokens.foreground }]}>{t('pipeline.createFirst')}</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={pipelines}
          keyExtractor={(p) => p.id}
          renderItem={({ item }) => (
            <View style={{ marginBottom: 10 }}>
              <PipelineCard
                pipeline={item}
                project={projects.find((p) => p.id === item.projectId)}
                tasks={tasksByPipeline[item.id] ?? []}
                onOpen={() => router.push(`/(main)/pipeline/${item.id}`)}
              />
            </View>
          )}
          contentContainerStyle={{ padding: 14, paddingBottom: 32 }}
        />
      )}
    </SafeScreen>
  )
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  headerButton: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 16, fontWeight: '600' },
  subtitle: { fontSize: 11 },
  newButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 9,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  newButtonText: { fontSize: 13, fontWeight: '600' },
  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 28 },
  emptyTitle: { fontSize: 15, fontWeight: '600' },
  emptyDescription: { fontSize: 12, textAlign: 'center', lineHeight: 18 },
  emptyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginTop: 6,
  },
  emptyButtonText: { fontSize: 13, fontWeight: '500' },
})
