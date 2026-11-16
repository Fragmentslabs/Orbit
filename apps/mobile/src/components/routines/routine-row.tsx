import { memo } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { CalendarClock } from 'lucide-react-native'
import type { Routine, RoutineRun } from '@orbit/shared'
import { isFinishedOnce, nextRoutineRun } from '@orbit/shared'
import { useRoutinesStore } from '~/stores/routines-store'
import { describeSchedule } from '~/lib/schedule'
import { folderName } from '~/lib/folder-name'
import { formatWhenShort } from '~/lib/format-time'
import { ListRow, StatePill, StateTile, type RowState } from '~/components/list/parts'

const AVATAR_COLORS = ['#4f46e5', '#0f766e', '#c2410c']

/** What the tile and the pill say: what needs the user's eyes first (same order as the desktop). */
export type RoutineState = 'running' | 'failed' | 'finished' | 'paused' | 'ok'

export function useRoutineState(routine: Routine): RoutineState {
  const running = useRoutinesStore((s) => s.runs.some((r) => r.routineId === routine.id && r.status === 'running'))
  const failed = useRoutinesStore((s) => {
    let last: RoutineRun | undefined
    for (const r of s.runs) if (r.routineId === routine.id && (!last || r.startedAt > last.startedAt)) last = r
    return last?.status === 'error'
  })
  if (running) return 'running'
  if (failed) return 'failed'
  if (isFinishedOnce(routine)) return 'finished'
  return routine.active ? 'ok' : 'paused'
}

const TONE: Record<RoutineState, RowState> = { running: 'run', failed: 'bad', finished: 'ok', paused: 'idle', ok: 'idle' }

function Avatars({ names }: { names: string[] }) {
  return (
    <View style={{ flexDirection: 'row' }}>
      {names.slice(0, 3).map((name, i) => (
        <View key={`${name}${i}`} style={[s.avatar, { backgroundColor: AVATAR_COLORS[i % 3], marginLeft: i === 0 ? 0 : -6 }]}>
          <Text style={s.avatarText}>{name.charAt(0).toUpperCase()}</Text>
        </View>
      ))}
    </View>
  )
}

/** One routine as a row of the list — mirror of the desktop's RoutineRow. */
export const RoutineRow = memo(function RoutineRow({ routine, onOpen }: { routine: Routine; onOpen: () => void }) {
  const { t, i18n } = useTranslation()
  const state = useRoutineState(routine)
  const next = nextRoutineRun(routine)
  const folder = routine.folders[0] ? folderName(routine.folders[0]) : null
  const members = routine.team?.members.map((m) => m.name) ?? []
  const label = t(`routines.list.state.${state}`)

  return (
    <ListRow
      onPress={onOpen}
      title={routine.title}
      tile={<StateTile state={TONE[state]} icon={CalendarClock} spinning={state === 'running'} />}
      lines={[
        { text: folder ? `${describeSchedule(routine.schedule, t)} · ${folder}` : describeSchedule(routine.schedule, t) },
        {
          quiet: true,
          text: next ? t('routines.list.next', { when: formatWhenShort(next, i18n.language) }) : t(`routines.list.state.${state === 'ok' ? 'paused' : state}`),
        },
      ]}
      right={
        <>
          {/* "active" is the quiet default: the pill only calls attention for the rest */}
          <StatePill state={state === 'ok' ? 'idle' : TONE[state]} label={label} />
          {members.length > 0 ? <Avatars names={members} /> : null}
        </>
      }
    />
  )
})

const s = StyleSheet.create({
  avatar: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'transparent' },
  avatarText: { fontSize: 10, fontWeight: '600', color: '#fff' },
})
