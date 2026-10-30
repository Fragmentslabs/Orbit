/**
 * Task detail — mirror of the desktop TaskModal as a screen: notes per phase,
 * live execution, telemetry, dependencies and actions.
 */
import { useEffect } from 'react'
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { ArrowLeft } from 'lucide-react-native'
import { usePipelineStore, EMPTY_TASKS } from '~/stores/pipeline-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { TaskDetail } from '~/components/pipeline/task-detail'
import { LoadError } from '~/components/pipeline/load-error'
import { useCodeOnly } from '~/components/pipeline/use-code-only'

export default function TaskDetailScreen() {
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  useCodeOnly()

  const { id, taskId } = useLocalSearchParams<{ id: string; taskId: string }>()
  const pipeline = usePipelineStore((s) => s.pipelines.find((p) => p.id === id))
  const tasks = usePipelineStore((s) => s.tasksByPipeline[id ?? ''] ?? EMPTY_TASKS)
  const task = tasks.find((x) => x.id === taskId)
  const loaded = usePipelineStore((s) => s.loaded)
  const error = usePipelineStore((s) => s.error)
  const fetch = usePipelineStore((s) => s.fetch)

  useEffect(() => {
    if (!loaded) void fetch()
  }, [loaded, fetch])

  // Pipeline or task removed: goes back to the board.
  useEffect(() => {
    if (loaded && (!pipeline || !task)) router.back()
  }, [loaded, pipeline, task, router])

  if (!pipeline || !task) {
    return (
      <SafeScreen style={{ flex: 1 }}>
        {error ? (
          <LoadError />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color={tokens.primary} />
          </View>
        )}
      </SafeScreen>
    )
  }

  return (
    <SafeScreen style={{ flex: 1 }}>
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.headerButton}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <Text style={[s.headerTitle, { color: tokens.foreground }]} numberOfLines={1}>
          {task.title}
        </Text>
        <View style={s.headerButton} />
      </View>
      <TaskDetail key={task.id} pipeline={pipeline} task={task} onClose={() => router.back()} />
    </SafeScreen>
  )
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  headerButton: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 15, fontWeight: '600' },
})
