/**
 * Memories screen — mirror of the desktop memories-view: search, List/Graph
 * toggle, automatic filter by the workspace mode (chat shows
 * core+seasonal+general; code shows project+general with a project filter).
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import { View, Text, Pressable, TextInput, FlatList, ScrollView, RefreshControl, StyleSheet } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { ArrowLeft, Check, ChevronDown, Folder, RefreshCw, Search, List, Network, X } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { Memory, MemoryKind } from '@orbit/shared'
import { matchesProjectFilter, searchMemories, visibleIn } from '@orbit/shared'
import { useMemoryStore } from '~/stores/memory-store'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { MemoryRow } from '~/components/memories/MemoryRow'
import { MemoryGraph } from '~/components/memories/MemoryGraph'
import { prewarmGraphLayout, stopGraphLayout } from '~/components/memories/use-graph-layout'
import { KIND_COLOR, KIND_ICON, kindLabel, lastActivity } from '~/components/memories/meta'
import { BottomSheet } from '~/components/ui/bottom-sheet'
import { CountLine } from '~/components/list/parts'
import { Spin } from '~/components/ui/spin'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { SafeScreen } from '~/components/layout/SafeScreen'

const ALL_PROJECTS = '__all__'

const keyOf = (m: Memory) => m.id

export default function MemoriesScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const mode = useWorkspaceStore((s) => s.mode)
  const index = useMemoryStore((s) => s.index)
  const loading = useMemoryStore((s) => s.loading)
  const fetch = useMemoryStore((s) => s.fetch)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const [query, setQuery] = useState('')
  const [projectFilter, setProjectFilter] = useState(ALL_PROJECTS)
  const [projectPicker, setProjectPicker] = useState(false)
  const [tab, setTab] = useState<'list' | 'graph'>('list')
  // Kind chips of the LIST only — the graph keeps showing the whole pool.
  const [kindFilter, setKindFilter] = useState<MemoryKind | typeof ALL_PROJECTS>(ALL_PROJECTS)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Arrival by citation in the conversation (`/memories?id=mem_xxx`): opens straight in the graph
  // with the node in focus — the list is ordered by activity, so the cited memory
  // could be several scrolls below the first fold. Adjust in RENDER (not
  // in an effect), same pattern as the EditModal of MemoryCard: it avoids the render at
  const { id: memoryIdFromRoute } = useLocalSearchParams<{ id?: string }>()
  const [appliedRoute, setRotaAplicada] = useState<string | null>(null)
  if (typeof memoryIdFromRoute === 'string' && memoryIdFromRoute && memoryIdFromRoute !== appliedRoute) {
    setRotaAplicada(memoryIdFromRoute)
    setSelectedId(memoryIdFromRoute)
    setTab('graph')
  }

  useEffect(() => {
    void fetch()
  }, [fetch])

  const projects = useMemo(() => {
    const map = new Map<string, string>()
    for (const m of index) {
      if (m.kind === 'project' && m.projectId) map.set(m.projectId, m.projectName ?? m.projectId)
      else if (m.originProjectId && !map.has(m.originProjectId)) {
        map.set(m.originProjectId, m.originProjectName ?? m.originProjectId)
      }
    }
    return [...map.entries()].map(([id, name]) => ({ id, name }))
  }, [index])

  const kinds: MemoryKind[] = mode === 'chat' ? ['core', 'seasonal', 'general'] : ['project', 'general']

  // Visible pool (mode + project, without the search) — the graph highlights instead of hiding
  const [now] = useState(() => Date.now())
  const pool = useMemo(() => {
    return index.filter((m) => {
      if (!kinds.includes(m.kind)) return false
      // A single rule: the memory shows up in the mode where it counts.
      if (!visibleIn(m, mode)) return false
      if (m.expiresAt != null && m.expiresAt < now) return false
      // The filter applies to ALL kinds: a general memory created in another
      // project does not belong to this view. Those without an origin stay global.
      if (projectFilter !== ALL_PROJECTS && !matchesProjectFilter(m, projectFilter)) return false
      return true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, mode, projectFilter])

  // Delayed: `searchMemories` scores EVERY memory of the pool, and with thousands of them
  // doing that on every keystroke choked the text field itself.
  const queryAdiada = useDeferredValue(query)
  const filtered = useMemo(() => {
    if (queryAdiada.trim()) return searchMemories(pool, queryAdiada, 50)
    return [...pool].sort((a, b) => lastActivity(b) - lastActivity(a))
  }, [pool, queryAdiada])

  // The kind chips count what the active tab shows: the searched list, or the whole pool of the graph
  // (which highlights the search instead of hiding).
  const kindBase = tab === 'list' ? filtered : pool
  const kindCounts = useMemo(() => {
    const counts = new Map<MemoryKind, number>()
    for (const m of kindBase) counts.set(m.kind, (counts.get(m.kind) ?? 0) + 1)
    return counts
  }, [kindBase])
  const showKinds = kindCounts.size > 1
  const showProjects = mode === 'code' && projects.length > 1
  // A kind that is no longer in the view (another project, another search) stops filtering.
  const activeKind = kindFilter !== ALL_PROJECTS && kindCounts.has(kindFilter) ? kindFilter : ALL_PROJECTS
  const listed = useMemo(
    () => (activeKind === ALL_PROJECTS ? filtered : filtered.filter((m) => m.kind === activeKind)),
    [filtered, activeKind],
  )
  // Same chips on the graph: the kind narrows the pool it draws (the layout itself is untouched).
  const graphPool = useMemo(
    () => (activeKind === ALL_PROJECTS ? pool : pool.filter((m) => m.kind === activeKind)),
    [pool, activeKind],
  )

  // Warms up the graph layout with the list still in front: when the toggle is
  // pressed, most of the time it is already ready (or nearly). It waits for an idle moment so as
  // not to fight for frames with the screen transition (InteractionManager is deprecated; the
  // timer is the fallback where requestIdleCallback is missing).
  useEffect(() => {
    if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(() => prewarmGraphLayout(pool))
      return () => cancelIdleCallback(id)
    }
    const timer = setTimeout(() => prewarmGraphLayout(pool), 300)
    return () => clearTimeout(timer)
  }, [pool])

  // Left the memories screen: there is no point in keeping the grind going in the background.
  useEffect(() => () => stopGraphLayout(), [])

  const byId = useMemo(() => new Map(index.map((m) => [m.id, m])), [index])
  // Resolved once per index: building the array inside renderItem returned
  // a new prop on every scroll and defeated the memo of the card.
  const relatedByMemory = useMemo(() => {
    const mapa = new Map<string, Memory[]>()
    for (const m of index) {
      const list = m.relatedIds.map((id) => byId.get(id)).filter((x): x is Memory => x != null)
      if (list.length > 0) mapa.set(m.id, list)
    }
    return mapa
  }, [index, byId])
  const NO_RELATED: Memory[] = useMemo(() => [], [])

  const openInGraph = useCallback((id: string) => {
    setSelectedId(id)
    setTab('graph')
  }, [])

  const renderItem = useCallback(
    ({ item }: { item: Memory }) => (
      <View>
        <MemoryRow
          memory={item}
          related={relatedByMemory.get(item.id) ?? NO_RELATED}
          onSelectRelated={openInGraph}
        />
      </View>
    ),
    [relatedByMemory, NO_RELATED, openInGraph],
  )

  const empty = (tab === 'graph' ? graphPool : listed).length === 0

  return (
    <SafeScreen style={s.container}>
      {/* Header */}
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.headerBtn}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <View style={{ flex: 1, minWidth: 0, paddingLeft: 6 }}>
          <Text style={[s.headerTitle, { color: tokens.foreground }]}>{t('memoriesScreen.title')}</Text>
          <Text numberOfLines={1} style={{ fontSize: 12, color: tokens.mutedForeground }}>{t('memoriesScreen.subtitle')}</Text>
        </View>
        <Pressable onPress={() => void fetch()} disabled={loading} style={s.headerBtn}>
          <Spin active={loading}>
            <RefreshCw size={18} color={tokens.mutedForeground} />
          </Spin>
        </Pressable>
      </View>

      <View style={s.body}>
        {/* Search + List/Graph tabs */}
        <View style={s.controls}>
          <View style={[s.searchBox, { backgroundColor: tokens.muted }]}>
            <Search size={15} color={tokens.mutedForeground} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={t('memoriesScreen.searchPlaceholder')}
              placeholderTextColor={tokens.mutedForeground}
              style={[s.searchInput, { color: tokens.foreground }]}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {query.length > 0 && (
              <Pressable onPress={() => setQuery('')} hitSlop={8}>
                <X size={14} color={tokens.mutedForeground} />
              </Pressable>
            )}
          </View>
          <View style={[s.tabs, { backgroundColor: tokens.border }]}>
            <Pressable
              onPress={() => setTab('list')}
              style={[s.tabBtn, tab === 'list' && { backgroundColor: tokens.background }]}
            >
              <List size={14} color={tab === 'list' ? tokens.primary : tokens.mutedForeground} />
            </Pressable>
            <Pressable
              onPress={() => setTab('graph')}
              style={[s.tabBtn, tab === 'graph' && { backgroundColor: tokens.background }]}
            >
              <Network size={14} color={tab === 'graph' ? tokens.primary : tokens.mutedForeground} />
            </Pressable>
          </View>
        </View>

        {/* One row of filters: the kinds (list only) and, in code mode with 2+ projects, the project picker. */}
        {(showKinds || showProjects) && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.chipsScroll} contentContainerStyle={s.chips}>
            {showKinds && (
              <>
                <Pressable
                  onPress={() => setKindFilter(ALL_PROJECTS)}
                  accessibilityState={{ selected: activeKind === ALL_PROJECTS }}
                  style={[s.kindChip, { borderColor: tokens.border }, activeKind === ALL_PROJECTS && { backgroundColor: tokens.muted, borderColor: tokens.muted }]}
                >
                  <Text style={{ fontSize: 13.5, color: activeKind === ALL_PROJECTS ? tokens.foreground : tokens.mutedForeground }}>
                    {t('memoriesScreen.allKinds')} <Text style={{ fontSize: 12, opacity: 0.8 }}>{kindBase.length}</Text>
                  </Text>
                </Pressable>
                {kinds.filter((k) => kindCounts.has(k)).map((k) => {
                  const KindIcon = KIND_ICON[k]
                  return (
                    <Pressable
                      key={k}
                      onPress={() => setKindFilter(k)}
                      accessibilityState={{ selected: activeKind === k }}
                      style={[s.kindChip, { borderColor: tokens.border }, activeKind === k && { backgroundColor: tokens.muted, borderColor: tokens.muted }]}
                    >
                      <KindIcon size={14} color={KIND_COLOR[k]} />
                      <Text style={{ fontSize: 13.5, color: activeKind === k ? tokens.foreground : tokens.mutedForeground }}>
                        {kindLabel(k)} <Text style={{ fontSize: 12, opacity: 0.8 }}>{kindCounts.get(k)}</Text>
                      </Text>
                    </Pressable>
                  )
                })}
              </>
            )}
            {showProjects && (
              <Pressable
                onPress={() => setProjectPicker(true)}
                accessibilityRole="button"
                style={[s.kindChip, { borderColor: projectFilter === ALL_PROJECTS ? tokens.border : tokens.primary }]}
              >
                <Folder size={14} color={projectFilter === ALL_PROJECTS ? tokens.mutedForeground : tokens.primary} />
                <Text numberOfLines={1} style={{ maxWidth: 140, fontSize: 13.5, color: projectFilter === ALL_PROJECTS ? tokens.mutedForeground : tokens.foreground }}>
                  {projectFilter === ALL_PROJECTS ? t('memoriesScreen.projectPicker') : (projects.find((p) => p.id === projectFilter)?.name ?? '')}
                </Text>
                <ChevronDown size={14} color={tokens.mutedForeground} />
              </Pressable>
            )}
          </ScrollView>
        )}
        {tab === 'list' && !empty && <CountLine>{t('memoriesScreen.count', { count: listed.length })}</CountLine>}

        {/* Content */}
        {empty ? (
          <View style={s.emptyBox}>
            <Text style={[s.emptyTitle, { color: tokens.foreground }]}>{query ? t('memoriesScreen.emptyFound') : t('memoriesScreen.emptyYet')}</Text>
            <Text style={[s.emptyDesc, { color: tokens.mutedForeground }]}>
              {query
                ? t('memoriesScreen.emptyTrySearch')
                : mode === 'chat'
                  ? t('memoriesScreen.emptyChatHint')
                  : t('memoriesScreen.emptyCodeHint')}
            </Text>
          </View>
        ) : tab === 'list' ? (
          <FlatList
            data={listed}
            keyExtractor={keyOf}
            renderItem={renderItem}
            // Cards have variable height (markdown, tags, actions), so there is no
            // getItemLayout: what can be done is to mount fewer per batch and
            // release from the native tree what left the window.
            initialNumToRender={8}
            maxToRenderPerBatch={8}
            updateCellsBatchingPeriod={50}
            windowSize={7}
            removeClippedSubviews
            contentContainerStyle={{ paddingBottom: 32 }}
            refreshControl={
              <RefreshControl refreshing={loading} onRefresh={() => void fetch()} tintColor={tokens.primary} />
            }
          />
        ) : (
          <MemoryGraph
            pool={graphPool}
            allById={byId}
            query={query}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        )}
      </View>

      <BottomSheet open={projectPicker} onClose={() => setProjectPicker(false)} title={<Text style={[s.sheetTitle, { color: tokens.foreground }]}>{t('memoriesScreen.projectPicker')}</Text>}>
        {[{ id: ALL_PROJECTS, name: t('memoriesScreen.allProjects') }, ...projects].map((p) => (
          <Pressable
            key={p.id}
            onPress={() => {
              setProjectFilter(p.id)
              setProjectPicker(false)
            }}
            accessibilityRole="button"
            accessibilityState={{ selected: projectFilter === p.id }}
            style={({ pressed }) => [s.sheetRow, pressed && { backgroundColor: tokens.accent }]}
          >
            <Folder size={16} color={tokens.mutedForeground} />
            <Text numberOfLines={1} style={{ flex: 1, fontSize: 15, color: tokens.foreground }}>
              {p.name}
            </Text>
            {projectFilter === p.id ? <Check size={16} color={tokens.primary} /> : null}
          </Pressable>
        ))}
      </BottomSheet>
    </SafeScreen>
  )
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  headerBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 16, fontWeight: '600' },

  body: { flex: 1, paddingHorizontal: 16, paddingTop: 12, gap: 8 },

  controls: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 10,
    paddingHorizontal: 12,
    height: 48,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  searchInput: { flex: 1, fontSize: 14, paddingVertical: 6 },
  tabs: {
    flexDirection: 'row',
    borderRadius: 10,
    padding: 3,
    gap: 3,
  },
  tabBtn: { width: 44, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },

  chipsScroll: { flexGrow: 0, flexShrink: 0 },
  chips: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 4 },
  sheetTitle: { fontSize: 17, fontWeight: '600', paddingVertical: 8 },
  // The row bleeds 8px past the sheet's margin for the pressed highlight, so its text lines up with the title.
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, marginHorizontal: -8, paddingHorizontal: 8, borderRadius: 12 },
  kindChip: { flexDirection: 'row', alignItems: 'center', gap: 7, height: 40, borderRadius: 99, borderWidth: 1, paddingHorizontal: 13 },

  emptyBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 32 },
  emptyTitle: { fontSize: 14, fontWeight: '600' },
  emptyDesc: { fontSize: 12, textAlign: 'center', lineHeight: 18 },
})
