/**
 * Pipeline board — vertical layout with accordions (mobile decision): one
 * section per phase, collapsible, with the tasks moving between them. Drag &
 * drop (long-press) takes pending tasks to any phase and the ones that already
 * started only forward. Footer with the pipeline metrics (computed in the app,
 * without a request).
 */
import { useCallback, useMemo, useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useRouter } from 'expo-router'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  GitCommit,
  Loader2,
  Plus,
} from 'lucide-react-native'
import { Droppable } from 'react-native-reanimated-dnd'
import type { Pipeline, Task } from '@orbit/shared'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { usePipelineStore, EMPTY_TASKS } from '~/stores/pipeline-store'
import { formatCost, formatDuration, formatTokens } from '~/lib/format'
import { Spin } from '~/components/ui/spin'
import { TaskCard } from './task-card'
import { BoardDragProvider, DraggableCard, useBoardDrag } from './board-drag'
import { blockingDependency, nextInQueue, validPhasesForDrop } from './pipeline-utils'

export function PipelineBoard({ pipeline }: { pipeline: Pipeline }) {
  return (
    <BoardDragProvider>
      <BoardBody pipeline={pipeline} />
    </BoardDragProvider>
  )
}

function BoardBody({ pipeline }: { pipeline: Pipeline }) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const router = useRouter()
  const { registerScrollRef, registerViewport, registerScrollOffset, dragging } = useBoardDrag()

  const tasks = usePipelineStore((s) => s.tasksByPipeline[pipeline.id] ?? EMPTY_TASKS)
  const queueEnabled = usePipelineStore((s) => s.queuesEnabled[pipeline.id] ?? false)
  const progress = usePipelineStore((s) => s.progress)
  const startTask = usePipelineStore((s) => s.startTask)
  const pauseTask = usePipelineStore((s) => s.pauseTask)
  const resumeTask = usePipelineStore((s) => s.resumeTask)

  const [expanded, setExpanded] = useState<Record<string, boolean>>({ pending: true, completed: false })
  const toggle = (id: string) => setExpanded((prev) => ({ ...prev, [id]: !(prev[id] ?? true) }))

  const openTask = useCallback(
    (taskId: string) => {
      router.push({ pathname: '/(main)/pipeline/[id]/task/[taskId]', params: { id: pipeline.id, taskId } })
    },
    [router, pipeline.id],
  )

  // Dropping on a phase starts the task there. "Pending" and "Completed" have no
  // drop action (completion belongs to the engine) — they only work as zones
  // for the card to go back to its place.
  const handleDrop = useCallback(
    (zoneId: string, task: Task) => {
      if (!zoneId.startsWith('phase:')) return
      const index = Number(zoneId.slice('phase:'.length))
      if (!validPhasesForDrop(task, pipeline.phases.length).includes(index)) return
      void startTask(pipeline.id, task.id, index)
    },
    [pipeline, startTask],
  )

  // Board rule: pending goes to any phase; whatever already started only moves
  // forward; completed does not drag (nor drops anywhere).
  const canDrop = useCallback(
    (sectionId: string, task: Task) => {
      if (sectionId === 'pending') return task.status === 'pending'
      if (sectionId === 'completed') return false
      const index = Number(sectionId.slice('phase:'.length))
      return validPhasesForDrop(task, pipeline.phases.length).includes(index)
    },
    [pipeline.phases.length],
  )

  const sections = useMemo(() => {
    const pending = tasks.filter((x) => x.status === 'pending')
    const phases = pipeline.phases.map((phase, index) => ({
      id: `phase:${index}`,
      title: phase.name,
      tasks: tasks.filter(
        (x) => x.status !== 'pending' && x.status !== 'completed' && x.currentPhase === index,
      ),
    }))
    const completed = tasks.filter((x) => x.status === 'completed')
    return [
      { id: 'pending', title: t('pipeline.pendingPlural'), tasks: pending },
      ...phases,
      { id: 'completed', title: t('pipeline.completedPlural'), tasks: completed },
    ]
  }, [tasks, pipeline.phases, t])

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        ref={registerScrollRef}
        onLayout={(e) => registerViewport(e.nativeEvent.layout.height)}
        onScroll={(e) => registerScrollOffset(e.nativeEvent.contentOffset.y)}
        scrollEventThrottle={16}
        contentContainerStyle={{ padding: 12, gap: 8, paddingBottom: 96 }}
      >
        {/* Add task — full width, at the top of the board */}
        <Pressable
          onPress={() => router.push(`/(main)/pipeline/${pipeline.id}/task/new`)}
          style={[s.newTaskBtn, { backgroundColor: tokens.primary }]}
        >
          <Plus size={16} color={tokens.primaryForeground} />
          <Text style={[s.newTaskText, { color: tokens.primaryForeground }]}>
            {t('pipeline.addTask')}
          </Text>
        </Pressable>

        {sections.map((section) => {
          const isExpanded = expanded[section.id] ?? true
          return (
            <Section
              key={section.id}
              zoneId={section.id}
              title={section.title}
              count={section.tasks.length}
              expanded={isExpanded}
              onToggle={() => toggle(section.id)}
              onDrop={(task) => handleDrop(section.id, task)}
              dropDisabled={dragging != null && !canDrop(section.id, dragging)}
              tokens={tokens}
            >
              {section.tasks.map((task) => (
                <DraggableCard key={task.id} task={task}>
                  <TaskCard
                    task={task}
                    pipeline={pipeline}
                    progress={progress[task.id]}
                    waitingFor={blockingDependency(task, tasks)}
                    isNext={queueEnabled && nextInQueue(task, tasks)}
                    onOpen={() => openTask(task.id)}
                    onStart={() => void startTask(pipeline.id, task.id)}
                    onPause={() => void pauseTask(pipeline.id, task.id)}
                    onResume={() => void resumeTask(pipeline.id, task.id)}
                  />
                </DraggableCard>
              ))}
              {section.id === 'pending' && section.tasks.length === 0 && (
                <View style={s.pendingEmpty}>
                  <Text style={[s.pendingEmptyText, { color: tokens.mutedForeground }]}>
                    {t('pipeline.noPending')}
                  </Text>
                  <Pressable
                    onPress={() => router.push(`/(main)/pipeline/${pipeline.id}/task/new`)}
                    style={[s.pendingEmptyBtn, { borderColor: tokens.border }]}
                  >
                    <Plus size={13} color={tokens.foreground} />
                    <Text style={[s.pendingEmptyBtnText, { color: tokens.foreground }]}>
                      {t('pipeline.addTask')}
                    </Text>
                  </Pressable>
                </View>
              )}
            </Section>
          )
        })}

        <PipelineFooter tasks={tasks} tokens={tokens} />
      </ScrollView>
    </View>
  )
}

function Section({
  zoneId,
  title,
  count,
  expanded,
  onToggle,
  onDrop,
  dropDisabled,
  tokens,
  children,
}: {
  zoneId: string
  title: string
  count: number
  expanded: boolean
  onToggle: () => void
  onDrop: (task: Task) => void
  dropDisabled: boolean
  tokens: Record<string, string>
  children: React.ReactNode
}) {
  return (
    <Droppable
      droppableId={zoneId}
      onDrop={onDrop}
      dropDisabled={dropDisabled}
      activeStyle={{ backgroundColor: tokens.accent, borderColor: tokens.primary }}
      style={s.section}
    >
      <Pressable onPress={onToggle} style={s.sectionHeader}>
        <Text style={[s.sectionTitle, { color: tokens.foreground }]} numberOfLines={1}>
          {title}
        </Text>
        <View style={[s.counter, { backgroundColor: tokens.muted }]}>
          <Text style={[s.counterText, { color: tokens.mutedForeground }]}>{count}</Text>
        </View>
        {expanded ? (
          <ChevronDown size={15} color={tokens.mutedForeground} />
        ) : (
          <ChevronRight size={15} color={tokens.mutedForeground} />
        )}
      </Pressable>
      {expanded && <View style={{ gap: 6, paddingTop: 6 }}>{children}</View>}
    </Droppable>
  )
}

/** Board footer — mirror of the desktop PipelineFooter (summary in the app). */
function PipelineFooter({ tasks, tokens }: { tasks: Task[]; tokens: Record<string, string> }) {
  const { t } = useTranslation()
  const summary = useMemo(() => {
    const commits = new Set<string>()
    let totalTokens = 0
    let cost = 0
    let time = 0
    for (const task of tasks) {
      totalTokens += task.tokens
      cost += task.cost
      time += task.workTimeMs
      for (const note of task.notes) {
        if (note.commitHash) commits.add(note.commitHash)
      }
    }
    return {
      completed: tasks.filter((x) => x.status === 'completed').length,
      running: tasks.filter((x) => x.status === 'in_progress').length,
      failed: tasks.filter((x) => x.pauseReason === 'error').length,
      commits: [...commits],
      totalTokens,
      cost,
      time,
    }
  }, [tasks])

  if (tasks.length === 0) return null

  return (
    <View style={[s.footer, { borderTopColor: tokens.border }]}>
      <View style={s.footerRow}>
        <CheckCircle2 size={11} color="#10b981" />
        <Text style={[s.footerText, { color: tokens.mutedForeground }]}>
          {t('pipeline.completedPlural')}: {summary.completed}/{tasks.length}
        </Text>
      </View>
      {summary.running > 0 && (
        <View style={s.footerRow}>
          <Spin>
            <Loader2 size={11} color={tokens.primary} />
          </Spin>
          <Text style={[s.footerText, { color: tokens.mutedForeground }]}>
            {t('pipeline.inProgress')}: {summary.running}
          </Text>
        </View>
      )}
      {summary.failed > 0 && (
        <View style={s.footerRow}>
          <AlertTriangle size={11} color={tokens.destructive} />
          <Text style={[s.footerText, { color: tokens.mutedForeground }]}>
            {t('pipeline.failures')}: {summary.failed}
          </Text>
        </View>
      )}
      {summary.commits.length > 0 && (
        <View style={s.footerRow}>
          <GitCommit size={11} color={tokens.mutedForeground} />
          <Text style={[s.footerText, { color: tokens.mutedForeground }]}>
            {t('pipeline.commits')}:{' '}
            {summary.commits
              .slice(0, 3)
              .map((h) => h.slice(0, 7))
              .join(', ')}
            {summary.commits.length > 3 ? '…' : ''}
          </Text>
        </View>
      )}
      {summary.time > 0 && (
        <View style={s.footerRow}>
          <Clock size={11} color={tokens.mutedForeground} />
          <Text style={[s.footerText, { color: tokens.mutedForeground }]}>
            {t('pipeline.totalTime')}: {formatDuration(summary.time)}
          </Text>
        </View>
      )}
      {summary.totalTokens > 0 && (
        <Text style={[s.footerText, { color: tokens.mutedForeground }]}>
          {t('pipeline.tokens')}: {formatTokens(summary.totalTokens)}
        </Text>
      )}
      {summary.cost > 0 && (
        <Text style={[s.footerText, { color: tokens.mutedForeground }]}>
          {t('pipeline.cost')}: {formatCost(summary.cost)}
        </Text>
      )}
    </View>
  )
}

const s = StyleSheet.create({
  newTaskBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 10,
    paddingVertical: 10,
    marginBottom: 8,
  },
  newTaskText: { fontSize: 13, fontWeight: '600' },
  pendingEmpty: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 4 },
  pendingEmptyText: { flex: 1, fontSize: 11 },
  pendingEmptyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  pendingEmptyBtnText: { fontSize: 12, fontWeight: '500' },
  section: { borderRadius: 10, borderWidth: 1, borderColor: 'transparent' },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  sectionTitle: { flex: 1, fontSize: 13, fontWeight: '600' },
  counter: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  counterText: { fontSize: 10, fontWeight: '500' },
  footer: {
    borderTopWidth: 1,
    paddingTop: 10,
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 12,
    rowGap: 4,
  },
  footerRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  footerText: { fontSize: 11 },
})
