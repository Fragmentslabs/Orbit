/**
 * Routines screen — mirror of the desktop's RoutinesView: search and the list/agenda switch, the
 * numbers, the rows and the foot line. "New" opens the menu that leads to the creation chat first
 * (or the form). Opening a routine is the /routines/[id] route.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, Pressable, FlatList, ActivityIndicator, RefreshControl, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { CalendarClock, CalendarDays, Clock, List, Plus } from 'lucide-react-native'
import { isFinishedOnce } from '@orbit/shared'
import { useSessionStore } from '~/stores/session-store'
import { useRoutinesStore } from '~/stores/routines-store'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { RoutineRow } from '~/components/routines/routine-row'
import { RoutinesAgenda } from '~/components/routines/routines-agenda'
import { CreateSheet } from '~/components/list/create-sheet'
import { CountLine, FootLine, HeaderButton, ListHeader, SearchField, Segment, Stat, useTokens } from '~/components/list/parts'
import { describeSchedule } from '~/lib/schedule'
import { formatCost } from '~/lib/format'
import { useStartCreationChat } from '~/hooks/useCreationChat'

const DAY_MS = 86_400_000

export default function RoutinesScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const tokens = useTokens()
  const routines = useRoutinesStore((s) => s.routines)
  const runs = useRoutinesStore((s) => s.runs)
  const loading = useRoutinesStore((s) => s.loading)
  const loaded = useRoutinesStore((s) => s.loaded)
  const load = useRoutinesStore((s) => s.load)
  const startCreation = useStartCreationChat()

  const [query, setQuery] = useState('')
  const [layout, setLayout] = useState<'list' | 'agenda'>('list')
  const [creating, setCreating] = useState(false)
  const [now] = useState(() => Date.now())

  useEffect(() => {
    void load()
  }, [load])

  // Pruning of orphan metrics on open: an execution session may have been
  // deleted from the sidebar — since the list is derived from the sessions, the
  // surviving record would be invisible and eternal. (Same rule as the desktop.)
  useEffect(() => {
    void (async () => {
      await useSessionStore.getState().fetchSessions()
      useRoutinesStore
        .getState()
        .prune(useSessionStore.getState().sessions.map((s) => s.id))
        .catch(() => {})
    })()
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const sorted = [...routines].sort((a, b) => b.createdAt - a.createdAt)
    if (!q) return sorted
    return sorted.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        r.prompt.toLowerCase().includes(q) ||
        describeSchedule(r.schedule, t).toLowerCase().includes(q),
    )
  }, [routines, query, t])

  const stats = useMemo(() => {
    const byId = new Set(routines.map((r) => r.id))
    const mine = runs.filter((r) => byId.has(r.routineId))
    return {
      active: routines.filter((r) => r.active).length,
      running: new Set(mine.filter((r) => r.status === 'running').map((r) => r.routineId)).size,
      failures: mine.filter((r) => r.status === 'error' && r.startedAt >= now - 7 * DAY_MS).length,
      cost: mine.filter((r) => r.startedAt >= now - 30 * DAY_MS).reduce((sum, r) => sum + r.cost, 0),
      finished: routines.filter((r) => isFinishedOnce(r)).length,
    }
  }, [routines, runs, now])

  // Opening a routine is opening ITS chat (like the desktop); the settings are one tap away in
  // the chat's menu. If the chat cannot be reached, the detail screen shows the error.
  const openingRef = useRef(false)
  const open = useCallback(
    (id: string) => {
      if (openingRef.current) return
      openingRef.current = true
      void useRoutinesStore
        .getState()
        .openChat(id)
        .catch(() => null)
        .then((sessionId) => {
          if (sessionId) router.push({ pathname: '/(main)/chat/[id]', params: { id: sessionId } })
          else router.push(`/(main)/routines/${id}`)
        })
        .finally(() => {
          openingRef.current = false
        })
    },
    [router],
  )
  const openSettings = useCallback((id: string) => router.push(`/(main)/routines/${id}`), [router])
  const openForm = useCallback(() => router.push('/(main)/routines/new'), [router])

  const counts = [
    t('routines.list.count', { count: routines.length }),
    t('routines.list.countActive', { count: stats.active }),
    ...(stats.running > 0 ? [t('routines.list.countRunning', { count: stats.running })] : []),
  ].join(' · ')

  return (
    <SafeScreen style={s.container}>
      <ListHeader
        title={t('routines.title')}
        subtitle={t('routines.headerSubtitle')}
        onBack={() => router.back()}
        right={<HeaderButton icon={Plus} label={t('routines.list.newShort')} onPress={() => setCreating(true)} />}
      />

      {!loaded && loading ? (
        <View style={s.center}>
          <ActivityIndicator color={tokens.primary} />
        </View>
      ) : routines.length === 0 ? (
        <View style={s.center}>
          <CalendarClock size={36} color={tokens.mutedForeground} style={{ opacity: 0.5 }} />
          <Text style={[s.emptyTitle, { color: tokens.foreground }]}>{t('routines.list.emptyTitle')}</Text>
          <Text style={[s.emptyText, { color: tokens.mutedForeground }]}>{t('routines.list.emptySubtitle')}</Text>
          <Pressable onPress={() => setCreating(true)} style={[s.emptyBtn, { borderColor: tokens.border }]}>
            <CalendarClock size={15} color={tokens.foreground} />
            <Text style={{ fontSize: 13, fontWeight: '500', color: tokens.foreground }}>{t('routines.list.createFirst')}</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <View style={s.bar}>
            <SearchField value={query} onChange={setQuery} placeholder={t('routines.list.search')} />
            <Segment
              value={layout}
              onChange={setLayout}
              items={[
                { key: 'list', icon: List, label: t('routines.view.list') },
                { key: 'agenda', icon: CalendarDays, label: t('routines.view.agenda') },
              ]}
            />
          </View>

          {layout === 'list' ? (
            <>
              <View style={s.stats}>
                <Stat label={t('routines.summary.active')} value={t('routines.summary.activeOf', { active: stats.active, total: routines.length })} />
                <Stat label={t('routines.summary.failures')} value={String(stats.failures)} bad={stats.failures > 0} />
                <Stat label={t('routines.summary.spent')} value={formatCost(stats.cost)} />
              </View>
              <CountLine>{counts}</CountLine>
              {filtered.length === 0 ? (
                <Text style={[s.noResults, { color: tokens.mutedForeground, borderColor: tokens.border }]}>
                  {t('routines.list.noResults', { query: query.trim() })}
                </Text>
              ) : (
                <FlatList
                  data={filtered}
                  keyExtractor={(r) => r.id}
                  renderItem={({ item }) => <RoutineRow routine={item} onOpen={() => open(item.id)} onSettings={() => openSettings(item.id)} />}
                  contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 12 }}
                  style={{ flex: 1 }}
                  refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} tintColor={tokens.primary} />}
                />
              )}
              <FootLine icon={Clock} text={t('routines.list.tail')} />
            </>
          ) : (
            <RoutinesAgenda routines={filtered} onOpen={open} />
          )}
        </>
      )}

      <CreateSheet kind="routine" open={creating} onClose={() => setCreating(false)} onChat={(text) => void startCreation('routine', text)} onForm={openForm} />
    </SafeScreen>
  )
}

const s = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 28 },
  emptyTitle: { fontSize: 15, fontWeight: '600' },
  emptyText: { fontSize: 12, textAlign: 'center', lineHeight: 18 },
  emptyBtn: { flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 44, borderRadius: 12, borderWidth: 1, paddingHorizontal: 16, marginTop: 6 },
  bar: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  stats: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 4 },
  noResults: { margin: 16, padding: 24, borderWidth: 1, borderStyle: 'dashed', borderRadius: 12, textAlign: 'center', fontSize: 12.5 },
})
