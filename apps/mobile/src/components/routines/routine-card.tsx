import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { CalendarClock, Loader2 } from 'lucide-react-native'
import type { Routine } from '@orbit/shared'
import { nextRoutineRun, ROUTINE_CHAT_MODES } from '@orbit/shared'
import { useSettingsStore } from '~/stores/settings-store'
import { useRoutinesStore } from '~/stores/routines-store'
import { useThemeStore } from '~/stores/theme-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { describeSchedule } from '~/lib/schedule'
import { formatDateTimeShort } from '~/lib/format-time'
import { Spin } from '~/components/ui/spin'
import { ModeBadges, ActiveSwitch } from './schedule-editor'

/** Card of ONE routine in the list — mirror of the desktop's RoutineCard. */
export function RoutineCard({ routine, onOpen }: { routine: Routine; onOpen: () => void }) {
  const { t, i18n } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const update = useRoutinesStore((s) => s.update)
  const running = useRoutinesStore((s) => s.runs.some((r) => r.routineId === routine.id && r.status === 'running'))
  const catalog = useSettingsStore((s) => s.catalog)
  const modelName = catalog?.[routine.model.providerId]?.models[routine.model.modelId]?.name ?? routine.model.modelId

  const next = nextRoutineRun(routine)

  return (
    <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
      <View style={s.titleRow}>
        <CalendarClock size={16} color={tokens.mutedForeground} />
        <Pressable onPress={onOpen} style={{ minWidth: 0, flex: 1 }}>
          <Text numberOfLines={1} style={[s.title, { color: tokens.foreground }]}>
            {routine.title}
          </Text>
        </Pressable>
        {running && (
          <Spin>
            <Loader2 size={14} color={tokens.primary} />
          </Spin>
        )}
        <ActiveSwitch active={routine.active} onChange={(v) => void update(routine.id, { active: v })} />
      </View>

      <Pressable onPress={onOpen} style={{ gap: 6 }}>
        <Text numberOfLines={1} style={[s.muted, { color: tokens.mutedForeground }]}>
          {describeSchedule(routine.schedule, t)}
        </Text>
        <Text numberOfLines={2} style={[s.prompt, { color: tokens.mutedForeground }]}>
          {routine.prompt}
        </Text>
        <ModeBadges modes={routine.modes} permission available={routine.mode === 'chat' ? ROUTINE_CHAT_MODES : undefined} />
        <Text numberOfLines={1} style={[s.muted, { color: tokens.mutedForeground }]}>
          {modelName}
        </Text>
        <Text numberOfLines={1} style={[s.muted, { color: tokens.mutedForeground }]}>
          {next
            ? t('routines.list.next', { when: formatDateTimeShort(next, i18n.language) })
            : t('routines.list.paused')}
        </Text>
      </Pressable>
    </View>
  )
}

const s = StyleSheet.create({
  card: { borderRadius: 10, borderWidth: 1, padding: 12, gap: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 15, fontWeight: '500' },
  muted: { fontSize: 12 },
  prompt: { fontSize: 12, lineHeight: 16, opacity: 0.8 },
})
