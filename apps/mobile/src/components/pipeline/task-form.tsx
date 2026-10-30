/**
 * New task — mirror of the desktop TaskCreateDialog as a route: title,
 * description (the full brief — the task runs without a chat) and dependencies.
 */
import { useState } from 'react'
import { View, Text, Pressable, ScrollView, ActivityIndicator, KeyboardAvoidingView, Platform, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react-native'
import type { Pipeline, Task } from '@orbit/shared'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { usePipelineStore, EMPTY_TASKS } from '~/stores/pipeline-store'
import { DependencyPicker } from './task-detail'

export function TaskForm({
  pipeline,
  onCreated,
  onCancel,
}: {
  pipeline: Pipeline
  onCreated: (task: Task) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const tasks = usePipelineStore((s) => s.tasksByPipeline[pipeline.id] ?? EMPTY_TASKS)
  const createTask = usePipelineStore((s) => s.createTask)

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [dependsOn, setDependsOn] = useState<string[]>([])
  const [depPicker, setDepPicker] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canCreate = title.trim().length > 0 && !saving

  const create = async () => {
    if (!canCreate) return
    setSaving(true)
    setError(null)
    try {
      const task = await createTask(pipeline.id, title.trim(), description.trim(), dependsOn)
      onCreated(task)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const dependencies = tasks.filter((x) => dependsOn.includes(x.id))

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 64 }} keyboardShouldPersistTaps="handled">
        <View style={{ gap: 6 }}>
          <Text style={[s.label, { color: tokens.foreground }]}>{t('pipeline.taskTitle')}</Text>
          <Input
            value={title}
            onChangeText={setTitle}
            placeholder={t('pipeline.taskTitleExample')}
            autoFocus
          />
        </View>

        <View style={{ gap: 6 }}>
          <Text style={[s.label, { color: tokens.foreground }]}>{t('pipeline.taskDescription')}</Text>
          <Text style={[s.hint, { color: tokens.mutedForeground }]}>{t('pipeline.taskDescriptionHint')}</Text>
          <Textarea
            value={description}
            onChangeText={setDescription}
            style={{ minHeight: 140, maxHeight: 280 }}
          />
        </View>

        <View style={{ gap: 6 }}>
          <Text style={[s.label, { color: tokens.foreground }]}>{t('pipeline.taskDependencies')}</Text>
          <Text style={[s.hint, { color: tokens.mutedForeground }]}>{t('pipeline.taskDependenciesHint')}</Text>
          {dependencies.length > 0 ? (
            <View style={s.chips}>
              {dependencies.map((dep) => (
                <View key={dep.id} style={[s.chip, { backgroundColor: tokens.muted }]}>
                  <Text style={[s.chipText, { color: tokens.mutedForeground }]} numberOfLines={1}>
                    {dep.title}
                  </Text>
                  <Pressable onPress={() => setDependsOn((prev) => prev.filter((x) => x !== dep.id))} hitSlop={8}>
                    <X size={11} color={tokens.mutedForeground} />
                  </Pressable>
                </View>
              ))}
            </View>
          ) : (
            <Text style={[s.hint, { color: tokens.mutedForeground }]}>{t('pipeline.selectDependencies')}</Text>
          )}
          <Pressable
            onPress={() => setDepPicker(true)}
            disabled={tasks.length === 0}
            style={{ alignSelf: 'flex-start' }}
          >
            <Text style={[s.hint, { color: tasks.length === 0 ? tokens.mutedForeground : tokens.primary }]}>
              {tasks.length === 0 ? t('pipeline.noTasksForDependency') : `+ ${t('pipeline.addDependency')}`}
            </Text>
          </Pressable>
        </View>

        {error && <Text style={[s.error, { color: tokens.destructive }]}>{error}</Text>}

        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 4 }}>
          <Pressable onPress={onCancel} style={{ padding: 8 }}>
            <Text style={[s.secondaryButton, { color: tokens.foreground }]}>{t('sidebar.cancel')}</Text>
          </Pressable>
          <Pressable
            onPress={() => void create()}
            disabled={!canCreate}
            style={[s.primaryButton, { backgroundColor: tokens.primary, opacity: canCreate ? 1 : 0.4 }]}
          >
            {saving ? (
              <ActivityIndicator size="small" color={tokens.primaryForeground} />
            ) : (
              <Text style={[s.primaryButtonText, { color: tokens.primaryForeground }]}>{t('pipeline.createTask')}</Text>
            )}
          </Pressable>
        </View>
      </ScrollView>

      {depPicker && (
        <DependencyPicker
          onClose={() => setDepPicker(false)}
          tasks={tasks}
          selected={dependsOn}
          onChange={(ids) => setDependsOn(ids)}
        />
      )}
    </KeyboardAvoidingView>
  )
}

const s = StyleSheet.create({
  label: { fontSize: 12, fontWeight: '600' },
  hint: { fontSize: 11, lineHeight: 15 },
  error: { fontSize: 12 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    maxWidth: '100%',
  },
  chipText: { fontSize: 11, fontWeight: '500', maxWidth: 220 },
  secondaryButton: { fontSize: 13, fontWeight: '500' },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  primaryButtonText: { fontSize: 13, fontWeight: '600' },
})
