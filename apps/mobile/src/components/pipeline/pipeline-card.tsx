/**
 * Card of the pipeline list — mirror of the desktop PipelineList: name, phases
 * in a row, project folder and task summary, with running/error indicators.
 */
import { memo } from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { Folder, Layers, Loader2 } from 'lucide-react-native'
import type { Pipeline, Project, Task } from '@orbit/shared'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { Spin } from '~/components/ui/spin'

export const PipelineCard = memo(function PipelineCard({
  pipeline,
  project,
  tasks,
  onOpen,
}: {
  pipeline: Pipeline
  project?: Project
  tasks: Task[]
  onOpen: () => void
}) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const running = tasks.filter((x) => x.status === 'in_progress').length
  const completed = tasks.filter((x) => x.status === 'completed').length
  const hasError = tasks.some((x) => x.pauseReason === 'error')

  return (
    <Pressable
      onPress={onOpen}
      style={[s.card, { backgroundColor: tokens.card, borderColor: tokens.border }]}
    >
      <View style={s.row}>
        <Layers size={15} color={tokens.mutedForeground} />
        <Text style={[s.name, { color: tokens.foreground }]} numberOfLines={1}>
          {pipeline.name}
        </Text>
        {running > 0 && (
          <Spin>
            <Loader2 size={13} color={tokens.primary} />
          </Spin>
        )}
        {hasError && <View style={[s.dot, { backgroundColor: tokens.destructive }]} />}
        {completed > 0 && <View style={[s.dot, { backgroundColor: '#eab308' }]} />}
      </View>

      <Text style={[s.phases, { color: tokens.mutedForeground }]} numberOfLines={1}>
        {pipeline.phases.map((p) => p.name).join(' → ')}
      </Text>

      {project && project.folders.length > 0 && (
        <View style={s.row}>
          <Folder size={12} color={tokens.mutedForeground} />
          <Text style={[s.folder, { color: tokens.mutedForeground }]} numberOfLines={1}>
            {project.folders[0]}
            {project.folders.length > 1 && ` +${project.folders.length - 1}`}
          </Text>
        </View>
      )}

      <Text style={[s.summary, { color: tokens.mutedForeground }]}>
        {t('pipeline.tasksSummary', { total: tasks.length, completed: completed })}
        {pipeline.branch ? ` · ${pipeline.branch}` : ''}
      </Text>
    </Pressable>
  )
})

const s = StyleSheet.create({
  card: { borderRadius: 10, borderWidth: 1, padding: 12, gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { flex: 1, fontSize: 14, fontWeight: '600' },
  dot: { width: 6, height: 6, borderRadius: 3 },
  phases: { fontSize: 11 },
  folder: { flex: 1, fontSize: 11 },
  summary: { fontSize: 11 },
})
