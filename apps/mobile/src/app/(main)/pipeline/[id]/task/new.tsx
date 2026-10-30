/**
 * New task — mirror of the desktop TaskCreateDialog as a route. Once created,
 * it goes back to the board (the main's event makes the task appear).
 */
import { useEffect } from 'react'
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react-native'
import { usePipelineStore } from '~/stores/pipeline-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { TaskForm } from '~/components/pipeline/task-form'
import { LoadError } from '~/components/pipeline/load-error'
import { useCodeOnly } from '~/components/pipeline/use-code-only'

export default function NewTaskScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  useCodeOnly()

  const { id } = useLocalSearchParams<{ id: string }>()
  const pipeline = usePipelineStore((s) => s.pipelines.find((p) => p.id === id))
  const loaded = usePipelineStore((s) => s.loaded)
  const error = usePipelineStore((s) => s.error)
  const fetch = usePipelineStore((s) => s.fetch)

  useEffect(() => {
    if (!loaded) void fetch()
  }, [loaded, fetch])

  useEffect(() => {
    if (loaded && !pipeline) router.back()
  }, [loaded, pipeline, router])

  if (!pipeline) {
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
        <Text style={[s.headerTitle, { color: tokens.foreground }]}>{t('pipeline.newTask')}</Text>
        <View style={s.headerButton} />
      </View>
      <TaskForm pipeline={pipeline} onCreated={() => router.back()} onCancel={() => router.back()} />
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
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '600' },
})
