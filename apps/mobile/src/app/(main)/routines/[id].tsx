/**
 * Routine detail — mirror of the desktop's routine panel: its own header (back, title, switch),
 * two tabs and the delete at the foot. "Runs" says when it fires again, who works in it and how
 * the last ones ended; "Settings" IS the editor (one accordion per group, autosaved). The
 * routine's one chat is what the list opens — this screen is reached from that chat's menu.
 */
import { useEffect, useMemo, useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native'
import { useConfirm } from '~/components/ui/confirm-dialog'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Check, ChevronRight, Loader2, Pause, Play, Trash2, X } from 'lucide-react-native'
import { isFinishedOnce, nextRoutineRun, type RoutineRun } from '@orbit/shared'
import { useRoutinesStore } from '~/stores/routines-store'
import { useThemeStore } from '~/stores/theme-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { describeSchedule } from '~/lib/schedule'
import { formatDateTimeShort } from '~/lib/format-time'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { Spin } from '~/components/ui/spin'
import { RoutineSettings } from '~/components/routines/routine-settings'

type Tab = 'runs' | 'config'

function duration(run: RoutineRun): string {
  if (!run.completedAt) return ''
  const seconds = Math.max(1, Math.round((run.completedAt - run.startedAt) / 1000))
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`
}

export default function RoutineDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { t, i18n } = useTranslation()
  const confirm = useConfirm()
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const routines = useRoutinesStore((s) => s.routines)
  const allRuns = useRoutinesStore((s) => s.runs)
  const loaded = useRoutinesStore((s) => s.loaded)
  const load = useRoutinesStore((s) => s.load)
  const update = useRoutinesStore((s) => s.update)
  const runNow = useRoutinesStore((s) => s.runNow)
  const remove = useRoutinesStore((s) => s.remove)

  const [tab, setTab] = useState<Tab>('config')

  const routine = routines.find((r) => r.id === id)
  const runs = useMemo(
    () => allRuns.filter((r) => r.routineId === id).sort((a, b) => b.startedAt - a.startedAt),
    [allRuns, id],
  )
  const running = runs.some((r) => r.status === 'running')

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  // Routine removed (here or in another window/desktop): goes back instead of leaving the screen
  // stuck on a detail that no longer exists.
  useEffect(() => {
    if (loaded && !routine) router.back()
  }, [loaded, routine, router])

  if (!routine) {
    return <SafeScreen style={{ flex: 1 }}>{null}</SafeScreen>
  }

  const next = nextRoutineRun(routine)
  const finished = isFinishedOnce(routine)

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

  return (
    <SafeScreen style={{ flex: 1 }}>
      {/* Header */}
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.headerBtn} accessibilityLabel={t('routines.review.back')}>
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
          </Text>
        </View>
      </View>

      {/* Tabs */}
      <View style={s.tabsWrap}>
        <View style={[s.tabs, { backgroundColor: tokens.muted }]}>
          {(['runs', 'config'] as const).map((value) => (
            <Pressable
              key={value}
              onPress={() => setTab(value)}
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === value }}
              style={[s.tab, tab === value && { backgroundColor: tokens.background }]}
            >
              <Text style={[s.tabText, { color: tab === value ? tokens.foreground : tokens.mutedForeground }, tab === value && { fontWeight: '600' }]}>
                {t(value === 'runs' ? 'routines.detail.tabRuns' : 'routines.detail.tabConfig')}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {/* Both stay mounted: a settings change waiting for its autosave survives a tab switch. */}
        <ScrollView
          style={[{ flex: 1 }, tab !== 'runs' && { display: 'none' }]}
          contentContainerStyle={{ padding: 16, gap: 20, paddingBottom: 24 }}
        >
          <View style={{ gap: 8 }}>
            <Text style={[s.section, { color: tokens.mutedForeground }]}>{t('routines.detail.next')}</Text>
            <View style={[s.nextCard, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
              <Text style={[s.nextTitle, { color: tokens.foreground }]}>
                {next
                  ? formatDateTimeShort(next, i18n.language)
                  : t(finished ? 'routines.list.state.finished' : 'routines.list.paused')}
              </Text>
              <Text style={[s.muted, { color: tokens.mutedForeground }]}>{describeSchedule(routine.schedule, t)}</Text>
            </View>
            <View style={s.actions}>
              <Pressable
                onPress={() => void runNow(routine.id)}
                disabled={running}
                style={[s.actionBtn, { borderColor: tokens.border }, running && { opacity: 0.4 }]}
              >
                {running ? (
                  <Spin>
                    <Loader2 size={15} color={tokens.foreground} />
                  </Spin>
                ) : (
                  <Play size={15} color={tokens.foreground} />
                )}
                <Text style={[s.actionText, { color: tokens.foreground }]}>{t('routines.list.runNow')}</Text>
              </Pressable>
              {(routine.active || !finished) && (
                <Pressable
                  onPress={() => void update(routine.id, { active: !routine.active })}
                  style={[s.actionBtn, { borderColor: tokens.border }]}
                >
                  {routine.active ? <Pause size={15} color={tokens.foreground} /> : <Play size={15} color={tokens.foreground} />}
                  <Text style={[s.actionText, { color: tokens.foreground }]}>
                    {t(routine.active ? 'routines.detail.pause' : 'routines.detail.activate')}
                  </Text>
                </Pressable>
              )}
            </View>
          </View>

          <View>
            <Text style={[s.section, { color: tokens.mutedForeground, paddingBottom: 4 }]}>{t('routines.detail.recent')}</Text>
            {runs.length === 0 ? (
              <Text style={[s.muted, { color: tokens.mutedForeground, paddingVertical: 8 }]}>{t('routines.detail.noRuns')}</Text>
            ) : (
              runs.slice(0, 8).map((run) => (
                <RunRow
                  key={run.sessionId}
                  run={run}
                  label={formatDateTimeShort(run.startedAt, i18n.language)}
                  onOpen={() => router.push({ pathname: '/(main)/chat/[id]', params: { id: run.sessionId } })}
                />
              ))
            )}
          </View>
        </ScrollView>

        <ScrollView
          style={[{ flex: 1 }, tab !== 'config' && { display: 'none' }]}
          contentContainerStyle={{ paddingBottom: 24 }}
          keyboardShouldPersistTaps="handled"
        >
          <RoutineSettings key={routine.id} routine={routine} />
        </ScrollView>
      </KeyboardAvoidingView>

      <View style={[s.footer, { borderTopColor: tokens.border }]}>
        <Pressable onPress={() => void confirmRemoval()} style={[s.deleteBtn, { borderColor: tokens.border }]}>
          <Trash2 size={16} color={tokens.destructive} />
          <Text style={[s.actionText, { color: tokens.destructive }]}>{t('routines.list.delete')}</Text>
        </Pressable>
      </View>
    </SafeScreen>
  )
}

function RunRow({ run, label, onOpen }: { run: RoutineRun; label: string; onOpen: () => void }) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const running = run.status === 'running'
  const failed = run.status === 'error'
  const length = duration(run)
  return (
    <Pressable onPress={onOpen} style={[s.runRow, { borderBottomColor: tokens.border }]}>
      {running ? (
        <Spin>
          <Loader2 size={16} color={tokens.primary} />
        </Spin>
      ) : failed ? (
        <View style={[s.dot, { backgroundColor: 'rgba(220,38,38,0.15)' }]}>
          <X size={12} color={tokens.destructive} />
        </View>
      ) : (
        <View style={[s.dot, { backgroundColor: 'rgba(22,163,74,0.15)' }]}>
          <Check size={12} color="#15803d" />
        </View>
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={[s.rowTitle, { color: tokens.foreground }]}>
          {label}
        </Text>
        <Text style={[s.muted, { color: failed ? tokens.destructive : tokens.mutedForeground }]}>
          {t(`routines.runs.${run.status}`)}
          {length ? ` · ${length}` : ''}
        </Text>
      </View>
      <ChevronRight size={16} color={tokens.mutedForeground} />
    </Pressable>
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

  tabsWrap: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6 },
  tabs: { flexDirection: 'row', gap: 2, padding: 3, borderRadius: 12 },
  tab: { flex: 1, height: 38, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  tabText: { fontSize: 13, fontWeight: '500' },

  section: { fontSize: 11, fontWeight: '600', letterSpacing: 0.6, textTransform: 'uppercase' },
  nextCard: { borderRadius: 14, borderWidth: 1, padding: 14, gap: 3 },
  nextTitle: { fontSize: 20, fontWeight: '600' },
  muted: { fontSize: 12 },
  actions: { flexDirection: 'row', gap: 8 },
  actionBtn: {
    flex: 1,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    borderRadius: 12,
    borderWidth: 1,
  },
  actionText: { fontSize: 14, fontWeight: '500' },

  rowTitle: { fontSize: 14, fontWeight: '500' },

  runRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, borderBottomWidth: 1 },
  dot: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },

  footer: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 12, borderTopWidth: 1 },
  deleteBtn: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
  },
})
