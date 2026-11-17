import { memo, useState } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { CalendarClock, Pause, Play, Settings, Trash2 } from 'lucide-react-native'
import { ActionMenu, type ActionMenuItem } from '~/components/ui/action-menu'
import { useConfirm } from '~/components/ui/confirm-dialog'
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
export const RoutineRow = memo(function RoutineRow({
  routine,
  onOpen,
  onSettings,
}: {
  routine: Routine
  onOpen: () => void
  /** Opens the routine's details and settings screen. */
  onSettings: () => void
}) {
  const { t, i18n } = useTranslation()
  const confirm = useConfirm()
  const state = useRoutineState(routine)
  const update = useRoutinesStore((s) => s.update)
  const runNow = useRoutinesStore((s) => s.runNow)
  const remove = useRoutinesStore((s) => s.remove)
  const [menuTop, setMenuTop] = useState<number | null>(null)
  const next = nextRoutineRun(routine)
  const finished = isFinishedOnce(routine)
  const folder = routine.folders[0] ? folderName(routine.folders[0]) : null
  const members = routine.team?.members.map((m) => m.name) ?? []
  const label = t(`routines.list.state.${state}`)

  const confirmRemoval = async () => {
    const ok = await confirm({
      title: t('routines.list.deleteTitle'),
      description: t('routines.list.deleteDescription', { title: routine.title }),
      confirmLabel: t('routines.list.delete'),
      cancelLabel: t('sidebar.cancel'),
      destructive: true,
    })
    if (ok) void remove(routine.id)
  }

  // The same options as the desktop's card dropdown. A finished one-off has no date left to
  // resume: "reschedule" takes it to the settings, where the schedule is picked again.
  const items: ActionMenuItem[] = [
    ...(state === 'running' ? [] : [{ icon: Play, label: t('routines.list.runNow'), onPress: () => void runNow(routine.id) }]),
    routine.active
      ? { icon: Pause, label: t('routines.detail.pause'), onPress: () => void update(routine.id, { active: false }) }
      : finished
        ? { icon: CalendarClock, label: t('routines.detail.reschedule'), onPress: onSettings }
        : { icon: Play, label: t('routines.detail.activate'), onPress: () => void update(routine.id, { active: true }) },
    { icon: Settings, label: t('routines.chat.settings'), onPress: onSettings },
    { icon: Trash2, label: t('routines.list.delete'), destructive: true, onPress: () => void confirmRemoval() },
  ]

  return (
    <>
    <ListRow
      onPress={onOpen}
      onLongPress={(pageY) => setMenuTop(pageY)}
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
    <ActionMenu
      visible={menuTop !== null}
      onClose={() => setMenuTop(null)}
      items={items}
      anchor={{ top: Math.max(60, (menuTop ?? 0) - 20), right: 16 }}
    />
    </>
  )
})

const s = StyleSheet.create({
  avatar: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'transparent' },
  avatarText: { fontSize: 10, fontWeight: '600', color: '#fff' },
})
