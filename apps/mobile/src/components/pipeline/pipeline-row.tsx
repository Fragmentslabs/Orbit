import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { Layers } from 'lucide-react-native'
import type { Pipeline, Project, Task } from '@orbit/shared'
import { folderName } from '~/lib/folder-name'
import { Text } from 'react-native'
import { ListRow, StatePill, StateTile, useTokens, type RowState } from '~/components/list/parts'

/** Tasks of the board, not the ones that are a delivery of the merge flow. */
export const realTasks = (tasks: Task[]) => tasks.filter((x) => !x.deliveryId)

export function pipelineCounts(tasks: Task[]) {
  const running = tasks.filter((x) => x.status === 'in_progress').length
  const failed = tasks.filter((x) => x.status === 'paused' && x.pauseReason === 'error').length
  const paused = tasks.filter((x) => x.status === 'paused' && x.pauseReason !== 'error').length
  const completed = tasks.filter((x) => x.status === 'completed').length
  return { running, failed, paused, completed, total: tasks.length }
}

/** One pipeline as a row of the list — mirror of the desktop's PipelineRow. */
export const PipelineRow = memo(function PipelineRow({
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
  const tokens = useTokens()
  const real = realTasks(tasks)
  const c = pipelineCounts(real)
  const allDone = c.total > 0 && c.completed === c.total
  const state: 'failed' | 'running' | 'done' | 'paused' | 'idle' =
    c.failed > 0 ? 'failed' : c.running > 0 ? 'running' : allDone ? 'done' : c.paused > 0 ? 'paused' : 'idle'
  const tone: Record<typeof state, RowState> = { failed: 'bad', running: 'run', done: 'ok', paused: 'warn', idle: 'idle' }
  const label =
    state === 'running'
      ? t('pipeline.list.running', { count: c.running })
      : state === 'failed'
        ? t('pipeline.list.failed', { count: c.failed })
        : state === 'done'
          ? t('pipeline.list.done')
          : state === 'paused'
            ? t('pipeline.list.pausedCount', { count: c.paused })
            : t('pipeline.list.idle')
  const folder = project?.folders[0] ? folderName(project.folders[0]) : null
  const where = [folder, pipeline.branch].filter(Boolean).join(' · ')

  return (
    <ListRow
      onPress={onOpen}
      title={pipeline.name}
      tile={<StateTile state={tone[state]} icon={Layers} spinning={state === 'running'} />}
      lines={[{ text: pipeline.phases.map((p) => p.name).join(' → ') }, ...(where ? [{ text: where, quiet: true }] : [])]}
      right={
        <>
          <StatePill state={tone[state]} label={label} />
          <Text style={{ fontSize: 12, color: tokens.mutedForeground }}>
            {t('pipeline.list.tasksOf', { done: c.completed, total: c.total })}
          </Text>
        </>
      }
    />
  )
})
