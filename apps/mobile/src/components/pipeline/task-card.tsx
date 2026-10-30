/**
 * Task card on the board — mirror of the desktop TaskCard: title with an action
 * button (pause/start/resume, grey icon), translucent state chips (bg-primary/10
 * etc.) and a live feed of the tail of the running phase's text.
 */
import { memo } from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Clock, Loader2, Pause, Play } from 'lucide-react-native'
import type { Pipeline, Task } from '@orbit/shared'
import { getThemeTokens, withAlpha } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { formatDuration, formatTokens } from '~/lib/format'
import { Spin } from '~/components/ui/spin'

type ChipTone = 'primary' | 'destructive' | 'warning' | 'muted'

export const TaskCard = memo(function TaskCard({
  task,
  pipeline,
  progress,
  waitingFor,
  isNext,
  onOpen,
  onStart,
  onPause,
  onResume,
  dimmed,
}: {
  task: Task
  pipeline: Pipeline
  progress?: string
  /** Title of the dependency blocking the task. */
  waitingFor?: string
  isNext?: boolean
  onOpen: () => void
  onStart: () => void
  onPause: () => void
  onResume: () => void
  /** Dim when the card is the origin of a drag in progress. */
  dimmed?: boolean
}) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const dark = useThemeStore((s) => s.resolved) === 'dark'

  const running = task.status === 'in_progress'
  const hasError = task.pauseReason === 'error'
  const phaseName = task.currentPhase != null ? (pipeline.phases[task.currentPhase]?.name ?? '') : undefined

  // Chips with a background (like the desktop: translucent) vs. plain-text
  // extras (time, tokens, dependencies — no background on the desktop).
  const chips: { key: string; icon?: 'clock' | 'play' | 'pause' | 'alert'; text: string; tone: ChipTone }[] = []
  const extras: { key: string; icon?: 'clock'; text: string }[] = []

  if (waitingFor) chips.push({ key: 'waiting', icon: 'clock', text: t('pipeline.waiting', { title: waitingFor }), tone: 'muted' })
  if (isNext) chips.push({ key: 'next', icon: 'play', text: t('pipeline.next'), tone: 'primary' })
  if (running && phaseName) chips.push({ key: 'phase', icon: 'play', text: phaseName, tone: 'primary' })
  if (hasError) chips.push({ key: 'error', icon: 'alert', text: t('pipeline.error'), tone: 'destructive' })
  if (task.pushError) chips.push({ key: 'push', icon: 'alert', text: t('pipeline.pushFailed'), tone: 'warning' })
  if (task.commitError) chips.push({ key: 'commit', icon: 'alert', text: t('pipeline.commitFailed'), tone: 'warning' })
  if (task.status === 'paused' && !hasError) chips.push({ key: 'paused', icon: 'pause', text: phaseName ?? t('pipeline.paused'), tone: 'muted' })
  if (task.workTimeMs > 0) extras.push({ key: 'time', icon: 'clock', text: formatDuration(task.workTimeMs) })
  if (task.tokens > 0) extras.push({ key: 'tokens', text: `${formatTokens(task.tokens)} tok` })
  if (task.dependsOn.length > 0) extras.push({ key: 'deps', text: `· ${t('pipeline.dependencies', { count: task.dependsOn.length })}` })

  const chipColors = (tone: ChipTone): { background: string; text: string } => {
    if (tone === 'primary') return { background: withAlpha(tokens.primary, 0.1), text: tokens.primary }
    if (tone === 'destructive') return { background: withAlpha(tokens.destructive, 0.1), text: tokens.destructive }
    if (tone === 'warning') return { background: withAlpha('#eab308', 0.15), text: dark ? '#facc15' : '#ca8a04' }
    return { background: tokens.muted, text: tokens.mutedForeground }
  }

  return (
    <View
      style={[
        s.card,
        {
          backgroundColor: tokens.card,
          borderColor: hasError ? withAlpha(tokens.destructive, 0.5) : tokens.border,
          opacity: dimmed ? 0.4 : 1,
        },
      ]}
    >
      <View style={s.titleRow}>
        <Pressable onPress={onOpen} style={{ minWidth: 0, flex: 1 }}>
          <Text style={[s.title, { color: tokens.foreground }]} numberOfLines={1}>
            {task.title}
          </Text>
        </Pressable>
        {running ? (
          <Pressable onPress={onPause} hitSlop={8} accessibilityLabel={t('pipeline.pause')} style={s.actionButton}>
            <Pause size={13} color={tokens.mutedForeground} />
          </Pressable>
        ) : task.status === 'paused' ? (
          <Pressable onPress={onResume} hitSlop={8} accessibilityLabel={t('pipeline.resume')} style={s.actionButton}>
            <Play size={13} color={tokens.mutedForeground} />
          </Pressable>
        ) : task.status === 'pending' ? (
          <Pressable onPress={onStart} hitSlop={8} accessibilityLabel={t('pipeline.start')} style={s.actionButton}>
            <Play size={13} color={tokens.mutedForeground} />
          </Pressable>
        ) : null}
      </View>

      <View style={s.badges}>
        {chips.map((chip) => {
          const colors = chipColors(chip.tone)
          return (
            <View key={chip.key} style={[s.chip, { backgroundColor: colors.background }]}>
              {chip.icon === 'clock' && <Clock size={10} color={colors.text} />}
              {chip.icon === 'play' && !running && <Play size={10} color={colors.text} />}
              {chip.icon === 'pause' && <Pause size={10} color={colors.text} />}
              {chip.icon === 'alert' && <AlertTriangle size={10} color={colors.text} />}
              {chip.key === 'phase' && running && (
                <Spin>
                  <Loader2 size={10} color={colors.text} />
                </Spin>
              )}
              <Text style={[s.chipText, { color: colors.text }]} numberOfLines={1}>
                {chip.text}
              </Text>
            </View>
          )
        })}
        {extras.map((x) => (
          <View key={x.key} style={s.extra}>
            {x.icon === 'clock' && <Clock size={10} color={tokens.mutedForeground} />}
            <Text style={[s.chipText, { color: tokens.mutedForeground }]} numberOfLines={1}>
              {x.text}
            </Text>
          </View>
        ))}
      </View>

      {running && progress ? (
        <Text style={[s.feed, { color: withAlpha(tokens.mutedForeground, 0.8) }]} numberOfLines={2}>
          {progress.slice(-160)}
        </Text>
      ) : null}
    </View>
  )
})

const s = StyleSheet.create({
  card: {
    borderRadius: 8,
    borderWidth: 1,
    padding: 10,
    gap: 6,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, fontSize: 12, fontWeight: '500' },
  actionButton: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
  },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 3,
    maxWidth: '100%',
  },
  extra: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  chipText: { fontSize: 10, fontWeight: '500' },
  feed: { fontSize: 10, lineHeight: 14 },
})
