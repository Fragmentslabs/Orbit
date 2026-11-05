/**
 * Pipeline board — accordions per phase (Pending → phases → Completed),
 * drag & drop by long-press and the automatic queue control in the header.
 */
import { useEffect, useState } from 'react'
import { View, Text, Pressable, Alert, ActivityIndicator, StyleSheet } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, MoreHorizontal, Pause, Pencil, Play, Trash2 } from 'lucide-react-native'
import { usePipelineStore } from '~/stores/pipeline-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { ActionMenu, type ActionMenuItem } from '~/components/ui/action-menu'
import { PipelineBoard } from '~/components/pipeline/board'
import { LoadError } from '~/components/pipeline/load-error'
import { useCodeOnly } from '~/components/pipeline/use-code-only'

export default function PipelineBoardScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  useCodeOnly()

  const { id } = useLocalSearchParams<{ id: string }>()
  const pipeline = usePipelineStore((s) => s.pipelines.find((p) => p.id === id))
  const loaded = usePipelineStore((s) => s.loaded)
  const error = usePipelineStore((s) => s.error)
  const fetch = usePipelineStore((s) => s.fetch)
  const queueEnabled = usePipelineStore((s) => s.queuesEnabled[id ?? ''] ?? false)
  const toggleQueue = usePipelineStore((s) => s.toggleQueue)
  const removePipeline = usePipelineStore((s) => s.removePipeline)

  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (!loaded) void fetch()
  }, [loaded, fetch])

  // Pipeline removed (from here, from the desktop or from another screen): goes
  // back to the list.
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

  const menuItems: ActionMenuItem[] = [
    {
      icon: Pencil,
      label: t('pipeline.editPipeline'),
      onPress: () => router.push(`/(main)/pipeline/${pipeline.id}/edit`),
    },
    {
      icon: Trash2,
      label: t('pipeline.removePipeline'),
      destructive: true,
      onPress: () =>
        Alert.alert(
          t('pipeline.removePipeline'),
          t('pipeline.confirmRemoval', { name: pipeline.name }),
          [
            { text: t('sidebar.cancel'), style: 'cancel' },
            {
              text: t('pipeline.removePipeline'),
              style: 'destructive',
              onPress: () => {
                void removePipeline(pipeline.id).then(() => router.back())
              },
            },
          ],
        ),
    },
  ]

  return (
    <SafeScreen style={{ flex: 1 }}>
      {/* Pipeline header: back + name + controls */}
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.headerButton} accessibilityLabel={t('pipeline.back')}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <View style={{ minWidth: 0, flex: 1, gap: 1 }}>
          <Text style={[s.title, { color: tokens.foreground }]} numberOfLines={1}>
            {pipeline.name}
          </Text>
          <Text style={[s.subtitle, { color: tokens.mutedForeground }]} numberOfLines={1}>
            {pipeline.phases.map((p) => p.name).join(' → ')}
            {(pipeline.integration?.branch ?? pipeline.branch) ? ` · ${pipeline.integration?.branch ?? pipeline.branch}` : ''}
          </Text>
        </View>
        {/* Automatic queue: ghost icon — grey play (off) / yellow pause (on) */}
        <Pressable
          onPress={() => void toggleQueue(pipeline.id, !queueEnabled)}
          accessibilityLabel={t('pipeline.queueHint')}
          style={[s.headerButton, queueEnabled && { backgroundColor: tokens.muted }]}
          hitSlop={6}
        >
          {queueEnabled ? (
            <Pause size={18} color={tokens.primary} />
          ) : (
            <Play size={18} color={tokens.mutedForeground} />
          )}
        </Pressable>
        <Pressable onPress={() => setMenuOpen(true)} style={s.headerButton}>
          <MoreHorizontal size={20} color={tokens.mutedForeground} />
        </Pressable>
      </View>

      <PipelineBoard pipeline={pipeline} />

      <ActionMenu
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        items={menuItems}
        anchor={{ top: 52, right: 12 }}
      />
    </SafeScreen>
  )
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  headerButton: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 15, fontWeight: '600' },
  subtitle: { fontSize: 11 },
})
