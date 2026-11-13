/**
 * Task detail — mirror of the desktop TaskModal as a screen: error/push banners,
 * editable title and description (saved on blur), phase tabs with a markdown note
 * and live execution, telemetry, dependencies and actions
 * (start/pause/resume/delete).
 */
import { useMemo, useState } from 'react'
import { View, Text, Pressable, ScrollView, ActivityIndicator, Alert, StyleSheet } from 'react-native'
import { useConfirm } from '~/components/ui/confirm-dialog'
import { useTranslation } from 'react-i18next'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AlertTriangle, Check, Loader2, Pause, Play, RotateCcw, Search, Terminal, Trash2, X } from 'lucide-react-native'
import type { Pipeline, PhaseNote, Task } from '@orbit/shared'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import { Badge } from '~/components/ui/badge'
import { BottomSheet } from '~/components/ui/bottom-sheet'
import { Spin } from '~/components/ui/spin'
import { AssistantMarkdown } from '~/components/chat/AssistantMarkdown'
import { Shimmer } from '~/components/ai/Shimmer'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { usePipelineStore, EMPTY_TASKS } from '~/stores/pipeline-store'
import { formatCost, formatDuration, formatTokens } from '~/lib/format'
import { formatDateTimeShort } from '~/lib/format-time'

export function TaskDetail({
  pipeline,
  task,
  onClose,
}: {
  pipeline: Pipeline
  task: Task
  /** Called after deleting (goes back to the board). */
  onClose: () => void
}) {
  const { t, i18n } = useTranslation()
  const confirm = useConfirm()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const insets = useSafeAreaInsets()

  const tasks = usePipelineStore((s) => s.tasksByPipeline[pipeline.id] ?? EMPTY_TASKS)
  const updateTask = usePipelineStore((s) => s.updateTask)
  const removeTask = usePipelineStore((s) => s.removeTask)
  const startTask = usePipelineStore((s) => s.startTask)
  const pauseTask = usePipelineStore((s) => s.pauseTask)
  const resumeTask = usePipelineStore((s) => s.resumeTask)
  const retryIntegration = usePipelineStore((s) => s.retryIntegration)
  const reopenTask = usePipelineStore((s) => s.reopenTask)

  // Initial state from the props: the route mounts it with key={task.id}, so
  // switching task remounts and clears everything (no reset effect).
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description)
  const [activePhase, setActivePhase] = useState(task.currentPhase ?? 0)
  const [depPicker, setDepPicker] = useState(false)
  const [depError, setDepError] = useState<string | null>(null)

  // Delivered (archived) tasks are history: read-only, with "Reopen" as the way back.
  const archived = !!task.deliveryId
  const hasError = task.pauseReason === 'error'
  const running = task.status === 'in_progress'

  const saveField = async (patch: Partial<Pick<Task, 'title' | 'description'>>) => {
    try {
      await updateTask(pipeline.id, task.id, patch)
    } catch {
      // No optimistic edit: the main's event comes back with the confirmed value.
    }
  }

  const noteByPhase = useMemo(() => {
    const map = new Map<string, PhaseNote>()
    for (const note of task.notes) map.set(note.phaseId, note)
    return map
  }, [task.notes])

  const note = noteByPhase.get(pipeline.phases[activePhase]?.id ?? '')

  const changeDependencies = async (next: string[]) => {
    try {
      await updateTask(pipeline.id, task.id, { dependsOn: next })
      setDepError(null)
    } catch (err) {
      setDepError(err instanceof Error ? err.message : String(err))
    }
  }

  const reopen = async () => {
    try {
      await reopenTask(pipeline.id, task.id)
      onClose()
    } catch (err) {
      Alert.alert(err instanceof Error ? err.message : String(err))
    }
  }

  const retry = async () => {
    try {
      await retryIntegration(pipeline.id, task.id)
    } catch (err) {
      Alert.alert(err instanceof Error ? err.message : String(err))
    }
  }

  const confirmDeletion = async () => {
    const ok = await confirm({
      title: t('pipeline.confirmTaskDeletion', { title: task.title }),
      description: t('pipeline.taskDeletionDescription'),
      confirmLabel: t('pipeline.deleteTask'),
      cancelLabel: t('sidebar.cancel'),
      destructive: true,
    })
    if (!ok) return
    void removeTask(pipeline.id, task.id).then(onClose)
  }

  const diffLines = useMemo(() => {
    if (!task.diff?.patch) return { added: 0, removed: 0 }
    let added = 0
    let removed = 0
    for (const line of task.diff.patch.split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
    return { added, removed }
  }, [task.diff])

  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 14, gap: 12, paddingBottom: 96 + insets.bottom }}>
        {hasError && (
          <View style={[s.banner, { backgroundColor: tokens.muted, borderColor: tokens.destructive }]}>
            <AlertTriangle size={16} color={tokens.destructive} />
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={[s.bannerTitle, { color: tokens.destructive }]}>{t('pipeline.pausedByError')}</Text>
              {!!task.error && (
                <Text style={[s.bannerText, { color: tokens.mutedForeground }]} numberOfLines={3}>
                  {task.error}
                </Text>
              )}
            </View>
            <Pressable onPress={() => void resumeTask(pipeline.id, task.id)} style={[s.bannerButton, { backgroundColor: tokens.primary }]}>
              <Text style={[s.bannerButtonText, { color: tokens.primaryForeground }]}>{t('pipeline.resume')}</Text>
            </Pressable>
          </View>
        )}

        {task.integration?.state === 'failed' && (
          <View style={[s.banner, { backgroundColor: tokens.muted, borderColor: tokens.destructive }]}>
            <AlertTriangle size={16} color={tokens.destructive} />
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={[s.bannerTitle, { color: tokens.foreground }]}>{t('pipeline.integration.failed')}</Text>
              {!!task.integration.detail && (
                <Text style={[s.bannerText, { color: tokens.mutedForeground }]} numberOfLines={4}>
                  {task.integration.detail}
                </Text>
              )}
            </View>
            <Pressable onPress={() => void retry()} style={[s.bannerButton, { backgroundColor: tokens.primary }]}>
              <Text style={[s.bannerButtonText, { color: tokens.primaryForeground }]}>{t('pipeline.integration.retry')}</Text>
            </Pressable>
          </View>
        )}

        {!!task.commitError && (
          <View style={[s.banner, { backgroundColor: tokens.muted, borderColor: '#eab308' }]}>
            <AlertTriangle size={16} color="#eab308" />
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={[s.bannerTitle, { color: tokens.foreground }]}>{t('pipeline.commitFailed')}</Text>
              <Text style={[s.bannerText, { color: tokens.mutedForeground }]} numberOfLines={3}>
                {task.commitError}
              </Text>
            </View>
          </View>
        )}

        {/* Editable title + status badge */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Input
            value={title}
            onChangeText={setTitle}
            onBlur={() => title.trim() !== task.title && title.trim() && void saveField({ title: title.trim() })}
            editable={!archived}
            style={{ flex: 1 }}
          />
          <Badge variant="secondary">{archived ? t('pipeline.archived') : t(`pipeline.status.${task.status}`)}</Badge>
        </View>

        {task.diff && task.diff.files.length > 0 && (
          <Text style={[s.info, { color: tokens.mutedForeground }]}>
            {t('pipeline.changedFiles', { count: task.diff.files.length })}
            {diffLines.added > 0 && <Text style={{ color: '#10b981' }}> +{diffLines.added}</Text>}
            {diffLines.removed > 0 && <Text style={{ color: tokens.destructive }}> -{diffLines.removed}</Text>}
          </Text>
        )}

        {/* Editable description */}
        <View style={{ gap: 5 }}>
          <Text style={[s.label, { color: tokens.foreground }]}>{t('pipeline.description')}</Text>
          <Textarea
            value={description}
            onChangeText={setDescription}
            onBlur={() => description !== task.description && void saveField({ description })}
            editable={!archived}
            style={{ minHeight: 72, maxHeight: 200 }}
          />
        </View>

        {/* Phase tabs — underline like the desktop (border-b-2), not pills */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ borderBottomWidth: 1, borderBottomColor: tokens.border }}
          contentContainerStyle={{ gap: 4, paddingHorizontal: 2 }}
        >
          {pipeline.phases.map((phase, index) => {
            const phaseNote = noteByPhase.get(phase.id)
            const active = activePhase === index
            const isCurrent = running && task.currentPhase === index
            return (
              <Pressable
                key={phase.id}
                onPress={() => setActivePhase(index)}
                style={[s.tab, { borderBottomColor: active ? tokens.primary : 'transparent' }]}
              >
                {phaseNote?.status === 'ok' && <Check size={12} color="#10b981" />}
                {phaseNote?.status === 'error' && <AlertTriangle size={12} color={tokens.destructive} />}
                {phaseNote?.status === 'skipped' && (
                  <Text style={[s.tabSkipped, { color: tokens.mutedForeground }]}>↷</Text>
                )}
                {isCurrent && (
                  <View style={[s.tabDot, { backgroundColor: tokens.primary }]} />
                )}
                <Text
                  style={[s.tabText, { color: active ? tokens.foreground : tokens.mutedForeground }]}
                  numberOfLines={1}
                >
                  {phase.name}
                </Text>
              </Pressable>
            )
          })}
        </ScrollView>

        {/* Phase panel */}
        {running && task.currentPhase === activePhase ? (
          <LiveRun taskId={task.id} phaseIndex={activePhase} />
        ) : note ? (
          <View style={{ gap: 8 }}>
            <AssistantMarkdown text={note.content} />
            {note.controlledCommands.length > 0 && (
              <View style={[s.commands, { backgroundColor: tokens.muted }]}>
                <Text style={[s.label, { color: tokens.foreground }]}>{t('pipeline.controlledCommands')}</Text>
                {note.controlledCommands.map((cmd, i) => (
                  <Text key={i} style={[s.command, { color: tokens.mutedForeground }]}>
                    {cmd}
                  </Text>
                ))}
              </View>
            )}
          </View>
        ) : (
          <Text style={[s.info, { color: tokens.mutedForeground }]}>{t('pipeline.noNote')}</Text>
        )}

        {/* Telemetry */}
        <View style={[s.telemetry, { borderTopColor: tokens.border }]}>
          <TelemetryRow label={t('pipeline.createdAt')} value={formatDateTimeShort(new Date(task.createdAt).getTime(), i18n.language)} tokens={tokens} />
          <TelemetryRow label={t('pipeline.completedAt')} value={task.completedAt ? formatDateTimeShort(new Date(task.completedAt).getTime(), i18n.language) : '—'} tokens={tokens} />
          <TelemetryRow label={t('pipeline.workTime')} value={formatDuration(task.workTimeMs)} tokens={tokens} />
          <TelemetryRow label={t('pipeline.tokens')} value={formatTokens(task.tokens)} tokens={tokens} />
          <TelemetryRow label={t('pipeline.cost')} value={formatCost(task.cost)} tokens={tokens} />
        </View>

        {/* Dependencies */}
        <View style={{ gap: 6 }}>
          <Text style={[s.label, { color: tokens.foreground }]}>{t('pipeline.dependenciesTitle')}</Text>
          {task.dependsOn.length === 0 ? (
            <Text style={[s.info, { color: tokens.mutedForeground }]}>{t('pipeline.noDependencies')}</Text>
          ) : (
            task.dependsOn.map((id) => {
              const dep = tasks.find((x) => x.id === id)
              if (!dep) return null
              return (
                <View key={id} style={[s.depRow, { borderColor: tokens.border }]}>
                  <View style={[s.depDot, { backgroundColor: dep.status === 'completed' ? '#10b981' : '#eab308' }]} />
                  <Text style={[s.depTitle, { color: tokens.foreground }]} numberOfLines={1}>
                    {dep.title}
                  </Text>
                  <Pressable onPress={() => void changeDependencies(task.dependsOn.filter((x) => x !== id))} hitSlop={8}>
                    <X size={13} color={tokens.mutedForeground} />
                  </Pressable>
                </View>
              )
            })
          )}
          <Pressable onPress={() => setDepPicker(true)} style={{ alignSelf: 'flex-start' }}>
            <Text style={[s.info, { color: tokens.primary }]}>+ {t('pipeline.addDependency')}</Text>
          </Pressable>
          {depError && <Text style={[s.error, { color: tokens.destructive }]}>{depError}</Text>}
        </View>
      </ScrollView>

      {/* Action footer — lifted off the bottom by the safe area */}
      <View
        style={[
          s.actions,
          { borderTopColor: tokens.border, backgroundColor: tokens.background, paddingBottom: 12 + insets.bottom },
        ]}
      >
        {archived && (
          <Pressable onPress={() => void reopen()} style={[s.primaryAction, { backgroundColor: tokens.primary }]}>
            <RotateCcw size={16} color={tokens.primaryForeground} />
            <Text style={[s.primaryActionText, { color: tokens.primaryForeground }]}>{t('pipeline.reopen')}</Text>
          </Pressable>
        )}
        {!archived && task.status !== 'completed' && (
          <Pressable
            onPress={() => {
              if (task.status === 'in_progress') void pauseTask(pipeline.id, task.id)
              else if (task.status === 'paused') void resumeTask(pipeline.id, task.id)
              else void startTask(pipeline.id, task.id)
            }}
            style={[s.primaryAction, { backgroundColor: tokens.primary }]}
          >
            {running ? (
              <Pause size={16} color={tokens.primaryForeground} />
            ) : (
              <Play size={16} color={tokens.primaryForeground} />
            )}
            <Text style={[s.primaryActionText, { color: tokens.primaryForeground }]}>
              {running ? t('pipeline.pause') : task.status === 'paused' ? t('pipeline.resume') : t('pipeline.start')}
            </Text>
          </Pressable>
        )}
        {!archived && (
          <Pressable onPress={confirmDeletion} style={[s.deleteAction, { borderColor: tokens.border }]}>
            <Trash2 size={15} color={tokens.destructive} />
          </Pressable>
        )}
      </View>

      {depPicker && (
        <DependencyPicker
          onClose={() => setDepPicker(false)}
          tasks={tasks.filter((x) => x.id !== task.id)}
          selected={task.dependsOn}
          onChange={(ids) => void changeDependencies(ids)}
        />
      )}
    </View>
  )
}

function TelemetryRow({ label, value, tokens }: { label: string; value: string; tokens: Record<string, string> }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
      <Text style={[s.info, { color: tokens.mutedForeground }]}>{label}</Text>
      <Text style={[s.info, { color: tokens.foreground }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  )
}

/** Live execution of the phase — the same visual vocabulary as the desktop chat:
 *  thinking in streaming + tools with state. */
function LiveRun({ taskId, phaseIndex }: { taskId: string; phaseIndex: number }) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const activity = usePipelineStore((s) => s.activity[taskId])
  const current = activity && activity.phaseIndex === phaseIndex ? activity : undefined

  if (!current) {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Spin>
          <Loader2 size={13} color={tokens.primary} />
        </Spin>
        <Text style={[s.info, { color: tokens.mutedForeground }]}>{t('pipeline.starting')}</Text>
      </View>
    )
  }

  const empty = current.thinking.length === 0 && current.tools.length === 0

  return (
    <View style={{ gap: 8 }}>
      <View style={[s.runningChip, { borderColor: tokens.primary }]}>
        <Shimmer className="text-xs font-semibold">{t('pipeline.running')}</Shimmer>
        <Spin>
          <Loader2 size={12} color={tokens.primary} />
        </Spin>
      </View>

      {empty && (
        <Text style={[s.info, { color: tokens.mutedForeground }]}>{t('pipeline.starting')}</Text>
      )}

      {!!current.thinking && (
        <View style={{ gap: 4 }}>
          <Shimmer className="text-xs font-semibold">{t('chatAssistant.reasoning')}</Shimmer>
          <AssistantMarkdown text={current.thinking} streaming muted size={12} />
        </View>
      )}

      {current.tools.map((tool) => (
        <View key={tool.toolCallId} style={{ gap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {tool.state === 'running' ? (
              <ActivityIndicator size="small" color={tokens.primary} />
            ) : tool.state === 'error' ? (
              <AlertTriangle size={13} color={tokens.destructive} />
            ) : (
              <Terminal size={13} color={tokens.mutedForeground} />
            )}
            {tool.state === 'running' ? (
              <Shimmer className="text-xs font-semibold">{tool.tool}</Shimmer>
            ) : (
              <Text style={[s.toolName, { color: tool.state === 'error' ? tokens.destructive : tokens.foreground }]}>
                {tool.tool}
              </Text>
            )}
          </View>
          {!!tool.summary && (
            <Text style={[s.info, { color: tokens.mutedForeground }]} numberOfLines={3}>
              {tool.summary}
            </Text>
          )}
          {tool.state === 'error' && !!tool.detail && (
            <Text style={[s.info, { color: tokens.destructive }]} numberOfLines={3}>
              {tool.detail}
            </Text>
          )}
        </View>
      ))}
    </View>
  )
}

/** Dependency picker — a large BottomSheet with search on top and the list
 *  below, like the desktop popover: the choices apply live (no confirm button)
 *  and it closes on an outside tap. Mounted conditionally by the parent: the
 *  initial state comes from the props. */
export function DependencyPicker({
  onClose,
  tasks,
  selected,
  onChange,
}: {
  onClose: () => void
  tasks: Task[]
  selected: string[]
  onChange: (ids: string[]) => void
}) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<string[]>(selected)

  const filtered = tasks.filter((x) => x.title.toLowerCase().includes(query.trim().toLowerCase()))

  const toggle = (id: string) => {
    const next = chosen.includes(id)
      ? chosen.filter((x) => x !== id)
      : [...chosen, id]
    setChosen(next)
    onChange(next)
  }

  return (
    <BottomSheet
      open
      onClose={onClose}
      title={
        <Text style={[s.sheetTitle, { color: tokens.foreground }]}>{t('pipeline.taskDependencies')}</Text>
      }
    >
      <View style={[s.searchBox, { borderColor: tokens.border }]}>
        <Search size={14} color={tokens.mutedForeground} />
        <Input
          value={query}
          onChangeText={setQuery}
          placeholder={t('pipeline.searchTask')}
          autoFocus
          style={{ flex: 1, borderWidth: 0, height: 34, paddingHorizontal: 0 }}
        />
      </View>
      <ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 8 }}>
        {filtered.length === 0 ? (
          <Text style={[s.info, { color: tokens.mutedForeground, textAlign: 'center', paddingVertical: 14 }]}>
            {t('pipeline.noTasks')}
          </Text>
        ) : (
          filtered.map((x) => {
            const marked = chosen.includes(x.id)
            return (
              <Pressable key={x.id} onPress={() => toggle(x.id)} style={s.depOption}>
                <View
                  style={[
                    s.checkbox,
                    { borderColor: marked ? tokens.primary : tokens.border },
                    marked && { backgroundColor: tokens.primary },
                  ]}
                >
                  {marked && <Check size={10} color={tokens.primaryForeground} />}
                </View>
                <Text style={[s.depOptionTitle, { color: tokens.foreground }]} numberOfLines={1}>
                  {x.title}
                </Text>
                <Text style={[s.info, { color: tokens.mutedForeground }]}>
                  {t(`pipeline.status.${x.status}`)}
                </Text>
              </Pressable>
            )
          })
        )}
      </ScrollView>
    </BottomSheet>
  )
}

const s = StyleSheet.create({
  banner: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 10, borderWidth: 1, padding: 10 },
  bannerTitle: { fontSize: 12, fontWeight: '600' },
  bannerText: { fontSize: 11, lineHeight: 15 },
  bannerButton: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  bannerButtonText: { fontSize: 12, fontWeight: '600' },
  info: { fontSize: 11 },
  label: { fontSize: 12, fontWeight: '600' },
  error: { fontSize: 11 },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderBottomWidth: 2,
    paddingHorizontal: 10,
    paddingVertical: 8,
    maxWidth: 170,
  },
  tabText: { fontSize: 12, fontWeight: '500' },
  tabSkipped: { fontSize: 12 },
  tabDot: { width: 6, height: 6, borderRadius: 3 },
  commands: { borderRadius: 8, padding: 10, gap: 4 },
  command: { fontFamily: 'monospace', fontSize: 11 },
  telemetry: { borderTopWidth: 1, paddingTop: 10, gap: 4 },
  depRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  depDot: { width: 7, height: 7, borderRadius: 4 },
  depTitle: { flex: 1, fontSize: 12 },
  actions: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    gap: 10,
    borderTopWidth: 1,
    padding: 12,
  },
  primaryAction: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 10,
    paddingVertical: 11,
  },
  primaryActionText: { fontSize: 14, fontWeight: '600' },
  deleteAction: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 16,
  },
  runningChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  toolName: { fontSize: 12, fontWeight: '600' },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
  },
  depOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 9,
    borderRadius: 8,
  },
  depOptionTitle: { flex: 1, fontSize: 13 },
  checkbox: {
    width: 15,
    height: 15,
    borderRadius: 4,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetTitle: { fontSize: 15, fontWeight: '600', marginBottom: 10 },
})
