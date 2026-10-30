/**
 * Routines screen — mirror of the desktop's RoutinesView: lists the routines of
 * the workspace's current mode (the chat one lists only chat routines, the code
 * one only code routines) with the "New routine" button at the top. Creation
 * and detail are routes of their own: /routines/new and /routines/[id].
 */
import { useCallback, useEffect, useMemo } from 'react'
import { View, Text, Pressable, FlatList, ActivityIndicator, RefreshControl, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, CalendarClock, MessageSquare, Plus, Terminal } from 'lucide-react-native'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { useSessionStore } from '~/stores/session-store'
import { useRoutinesStore } from '~/stores/routines-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { RoutineCard } from '~/components/routines/routine-card'

export default function RoutinesScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const mode = useWorkspaceStore((s) => s.mode)
  const routines = useRoutinesStore((s) => s.routines)
  const loading = useRoutinesStore((s) => s.loading)
  const loaded = useRoutinesStore((s) => s.loaded)
  const load = useRoutinesStore((s) => s.load)

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

  // The page belongs to the mode that opened it: the chat one lists only chat
  // routines and the code one only the code ones (the sidebar splits the
  // sessions the same way).
  const ofMode = useMemo(
    () => routines.filter((r) => r.mode === mode).sort((a, b) => b.createdAt - a.createdAt),
    [routines, mode],
  )

  const createNew = useCallback(() => {
    router.push('/(main)/routines/new')
  }, [router])

  return (
    <SafeScreen style={s.container}>
      {/* Header: title + mode badge + "New routine" button at the top */}
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.headerBtn}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <View style={s.headerTitle}>
          <Text style={[s.headerTitleText, { color: tokens.foreground }]}>{t('routines.title')}</Text>
          <View style={[s.modeBadge, { backgroundColor: tokens.muted }]}>
            {mode === 'chat' ? (
              <MessageSquare size={11} color={tokens.mutedForeground} />
            ) : (
              <Terminal size={11} color={tokens.mutedForeground} />
            )}
            <Text style={[s.modeBadgeText, { color: tokens.mutedForeground }]}>
              {mode === 'chat' ? t('routines.mode.chat') : t('routines.mode.code')}
            </Text>
          </View>
        </View>
        <Pressable onPress={createNew} style={[s.newButton, { backgroundColor: tokens.primary }]}>
          <Plus size={15} color={tokens.primaryForeground} />
          <Text style={[s.newButtonText, { color: tokens.primaryForeground }]}>{t('routines.list.new')}</Text>
        </Pressable>
      </View>

      <View style={s.body}>
        <Text style={[s.subtitle, { color: tokens.mutedForeground }]}>
          {mode === 'chat' ? t('routines.subtitleChat') : t('routines.subtitle')}
        </Text>

        {!loaded && loading ? (
          <View style={s.centerBox}>
            <ActivityIndicator color={tokens.primary} />
          </View>
        ) : ofMode.length === 0 ? (
          <View style={s.centerBox}>
            <CalendarClock size={36} color={tokens.mutedForeground} style={{ opacity: 0.5 }} />
            <Text style={[s.emptyTitle, { color: tokens.foreground }]}>{t('routines.list.emptyTitle')}</Text>
            <Text style={[s.emptyDescription, { color: tokens.mutedForeground }]}>
              {t(mode === 'chat' ? 'routines.list.emptySubtitleChat' : 'routines.list.emptySubtitle')}
            </Text>
            <Pressable onPress={createNew} style={[s.emptyButton, { borderColor: tokens.border }]}>
              <CalendarClock size={15} color={tokens.foreground} />
              <Text style={[s.emptyButtonText, { color: tokens.foreground }]}>{t('routines.list.createFirst')}</Text>
            </Pressable>
          </View>
        ) : (
          <FlatList
            data={ofMode}
            keyExtractor={(r) => r.id}
            renderItem={({ item }) => (
              <View style={{ marginBottom: 10 }}>
                <RoutineCard routine={item} onOpen={() => router.push(`/(main)/routines/${item.id}`)} />
              </View>
            )}
            contentContainerStyle={{ paddingBottom: 32 }}
            refreshControl={
              <RefreshControl refreshing={loading} onRefresh={() => void load()} tintColor={tokens.primary} />
            }
          />
        )}
      </View>
    </SafeScreen>
  )
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  headerBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { minWidth: 0, flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerTitleText: { fontSize: 16, fontWeight: '600' },
  modeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  modeBadgeText: { fontSize: 11, fontWeight: '500' },
  newButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 9,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  newButtonText: { fontSize: 13, fontWeight: '600' },

  body: { flex: 1, paddingHorizontal: 16, paddingTop: 10 },
  subtitle: { fontSize: 12, lineHeight: 17, marginBottom: 12 },

  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 28 },
  emptyTitle: { fontSize: 15, fontWeight: '600' },
  emptyDescription: { fontSize: 12, textAlign: 'center', lineHeight: 18 },
  emptyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginTop: 6,
  },
  emptyButtonText: { fontSize: 13, fontWeight: '500' },
})
