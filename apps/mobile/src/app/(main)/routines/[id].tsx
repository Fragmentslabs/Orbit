/**
 * Routine detail — mirror of the desktop's RoutineDetail: its own header
 * (back, title, switch, menu), prompt, badges, "Run now" and the session
 * history (derived from the sessions with routineId, run metrics matched by
 * sessionId). Tapping a session opens the chat of that execution.
 */
import { useEffect, useMemo, useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native'
import { useConfirm } from '~/components/ui/confirm-dialog'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  Folder,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  Trash2,
} from 'lucide-react-native'
import { nextRoutineRun } from '@orbit/shared'
import { useSessionStore } from '~/stores/session-store'
import { useRoutinesStore } from '~/stores/routines-store'
import { useSettingsStore } from '~/stores/settings-store'
import { useThemeStore } from '~/stores/theme-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { describeSchedule } from '~/lib/schedule'
import { formatDateTimeShort } from '~/lib/format-time'
import { formatCost, formatDuration, formatTokens } from '~/lib/format'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { Spin } from '~/components/ui/spin'
import { ActionMenu, type ActionMenuItem } from '~/components/ui/action-menu'
import { ActiveSwitch, ModeBadges } from '~/components/routines/schedule-editor'

export default function RoutineDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { t, i18n } = useTranslation()
  const confirm = useConfirm()
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const routines = useRoutinesStore((s) => s.routines)
  const runs = useRoutinesStore((s) => s.runs)
  const loaded = useRoutinesStore((s) => s.loaded)
  const load = useRoutinesStore((s) => s.load)
  const update = useRoutinesStore((s) => s.update)
  const runNow = useRoutinesStore((s) => s.runNow)
  const remove = useRoutinesStore((s) => s.remove)
  const sessions = useSessionStore((s) => s.sessions)
  const status = useSessionStore((s) => s.status)
  const catalog = useSettingsStore((s) => s.catalog)

  const [menuOpen, setMenuOpen] = useState(false)

  const routine = routines.find((r) => r.id === id)
  const running = runs.some((r) => r.routineId === id && r.status === 'running')

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  // Routine removed (here or in another window/desktop): goes back to the list
  // instead of leaving the screen stuck on a detail that no longer exists.
  useEffect(() => {
    if (loaded && !routine) router.back()
  }, [loaded, routine, router])

  const executions = useMemo(() => {
    if (!routine) return []
    const metrics = new Map(runs.filter((r) => r.routineId === routine.id).map((r) => [r.sessionId, r]))
    return sessions
      .filter((s) => s.routineId === routine.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((session) => ({ session, run: metrics.get(session.id) }))
  }, [sessions, runs, routine])

  if (!routine) {
    return <SafeScreen style={{ flex: 1 }}>{null}</SafeScreen>
  }

  const next = nextRoutineRun(routine)
  const modelName = catalog?.[routine.model.providerId]?.models[routine.model.modelId]?.name ?? routine.model.modelId

  const confirmRemoval = async () => {
    const ok = await confirm({
      title: t('routines.list.deleteTitle'),
      description: t('routines.list.deleteDescription', { title: routine.title }),
      confirmLabel: t('routines.list.delete'),
      cancelLabel: t('sidebar.cancel'),
      destructive: true,
    })
    if (!ok) return
    void remove(routine.id).then(() => router.back())
  }

  const menuItems: ActionMenuItem[] = [
    { icon: Pencil, label: t('routines.list.edit'), onPress: () => router.push(`/(main)/routines/${routine.id}/edit`) },
    { icon: Trash2, label: t('routines.list.delete'), destructive: true, onPress: confirmRemoval },
  ]

  return (
    <SafeScreen style={{ flex: 1 }}>
      {/* Header */}
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.headerBtn}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <View style={s.headerTitle}>
          <View style={s.titleRow}>
            <Text numberOfLines={1} style={[s.title, { color: tokens.foreground }]}>
              {routine.title}
            </Text>
            {running && (
              <Spin>
                <Loader2 size={14} color={tokens.primary} />
              </Spin>
            )}
          </View>
          <Text numberOfLines={1} style={[s.subtitle, { color: tokens.mutedForeground }]}>
            {describeSchedule(routine.schedule, t)}
            {' · '}
            {next
              ? t('routines.list.next', { when: formatDateTimeShort(next, i18n.language) })
              : t('routines.list.paused')}
          </Text>
        </View>
        <ActiveSwitch active={routine.active} onChange={(v) => void update(routine.id, { active: v })} />
        <Pressable onPress={() => setMenuOpen(true)} style={s.headerBtn}>
          <MoreHorizontal size={20} color={tokens.mutedForeground} />
        </Pressable>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }}>
        {/* Routine card */}
        <View style={[s.infoCard, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          <Text style={[s.prompt, { color: tokens.mutedForeground }]}>{routine.prompt}</Text>
          <View style={s.badgesRow}>
            <ModeBadges modes={routine.modes} permission />
          </View>
          <Text numberOfLines={1} style={[s.muted, { color: tokens.mutedForeground }]}>
            {modelName}
          </Text>
          {routine.folders.length > 0 && (
            <View style={s.folderRow}>
              <Folder size={13} color={tokens.mutedForeground} />
              <Text numberOfLines={1} style={[s.muted, { color: tokens.mutedForeground, flex: 1 }]}>
                {routine.folders.join(', ')}
              </Text>
            </View>
          )}
        </View>

        {/* Run now */}
        <Pressable
          onPress={() => void runNow(routine.id)}
          disabled={running}
          style={[
            s.runButton,
            { borderColor: tokens.border },
            running && { opacity: 0.4 },
          ]}
        >
          {running ? (
            <Spin>
              <Loader2 size={15} color={tokens.foreground} />
            </Spin>
          ) : (
            <Play size={15} color={tokens.foreground} />
          )}
          <Text style={[s.runButtonText, { color: tokens.foreground }]}>{t('routines.list.runNow')}</Text>
        </Pressable>

        {/* Execution history */}
        <Text style={[s.runsTitle, { color: tokens.foreground }]}>{t('routines.runs.title')}</Text>

        {executions.length === 0 ? (
          <Text style={[s.muted, { color: tokens.mutedForeground }]}>{t('routines.runs.empty')}</Text>
        ) : (
          executions.map(({ session, run }) => {
            const sessionStatus = status[session.id]
            const runRunning = sessionStatus === 'submitted' || sessionStatus === 'streaming' || run?.status === 'running'
            const runStatus = runRunning ? 'running' : run?.status === 'error' || sessionStatus === 'error' ? 'error' : 'ok'
            const duration =
              run?.completedAt && run.startedAt ? formatDuration(run.completedAt - run.startedAt) : undefined

            return (
              <Pressable
                key={session.id}
                onPress={() => router.push({ pathname: '/(main)/chat/[id]', params: { id: session.id } })}
                style={[s.runRow, { borderColor: tokens.border, backgroundColor: tokens.card }]}
              >
                {runStatus === 'running' ? (
                  <Spin>
                    <Loader2 size={14} color={tokens.primary} />
                  </Spin>
                ) : runStatus === 'error' ? (
                  <AlertCircle size={14} color={tokens.destructive} />
                ) : (
                  <CheckCircle2 size={14} color={tokens.mutedForeground} />
                )}
                <View style={{ minWidth: 0, flex: 1 }}>
                  <Text numberOfLines={1} style={[s.runDate, { color: tokens.foreground }]}>
                    {formatDateTimeShort(run?.startedAt ?? session.createdAt, i18n.language)}
                  </Text>
                  <Text
                    numberOfLines={1}
                    style={[s.runStatus, { color: runStatus === 'error' ? tokens.destructive : tokens.mutedForeground }]}
                  >
                    {runStatus === 'running'
                      ? t('routines.runs.running')
                      : runStatus === 'error'
                        ? run?.error || t('routines.runs.error')
                        : [duration, run && run.tokens > 0 ? t('routines.runs.tokens', { value: formatTokens(run.tokens) }) : null, run && run.cost > 0 ? formatCost(run.cost) : null]
                            .filter(Boolean)
                            .join(' · ') || t('routines.runs.ok')}
                  </Text>
                </View>
                <View style={s.openRow}>
                  <Text style={[s.openText, { color: tokens.mutedForeground }]}>{t('routines.runs.openChat')}</Text>
                  <ExternalLink size={12} color={tokens.mutedForeground} />
                </View>
              </Pressable>
            )
          })
        )}
      </ScrollView>

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
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  headerBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { minWidth: 0, flex: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { fontSize: 16, fontWeight: '600', flexShrink: 1 },
  subtitle: { fontSize: 12, marginTop: 1 },

  infoCard: { borderRadius: 10, borderWidth: 1, padding: 12, gap: 8 },
  prompt: { fontSize: 12, lineHeight: 17 },
  badgesRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  modeBadge: { borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 },
  modeBadgeText: { fontSize: 11, fontWeight: '500' },
  muted: { fontSize: 12 },
  folderRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },

  runButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 11,
  },
  runButtonText: { fontSize: 13, fontWeight: '600' },

  runsTitle: { fontSize: 14, fontWeight: '600', marginTop: 4 },
  runRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  runDate: { fontSize: 13 },
  runStatus: { fontSize: 12, marginTop: 1 },
  openRow: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 },
  openText: { fontSize: 12 },
})
