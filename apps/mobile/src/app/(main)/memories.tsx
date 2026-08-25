/**
 * Tela de Memórias — espelho da memories-view do desktop: busca, alternância
 * Lista/Grafo, filtro automático pelo modo do workspace (chat mostra
 * core+seasonal+general; código mostra project+general com filtro de projeto).
 */
import { useEffect, useMemo, useState } from 'react'
import { View, Text, Pressable, TextInput, FlatList, ScrollView, RefreshControl, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { ArrowLeft, RefreshCw, Search, List, Network, X } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { Memory, MemoryKind } from '@orbit/shared'
import { isCodeContext, matchesProjectFilter, searchMemories } from '@orbit/shared'
import { useMemoryStore } from '~/stores/memory-store'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { MemoryCard } from '~/components/memories/MemoryCard'
import { MemoryGraph } from '~/components/memories/MemoryGraph'
import { lastActivity } from '~/components/memories/meta'
import { Spin } from '~/components/ui/spin'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { SafeScreen } from '~/components/layout/SafeScreen'

const ALL_PROJECTS = '__all__'

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
  const [tab, setTab] = useState<'list' | 'graph'>('list')
  const [selectedId, setSelectedId] = useState<string | null>(null)

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

  // Pool visível (modo + projeto, sem a busca) — o grafo destaca em vez de esconder
  const pool = useMemo(() => {
    const now = Date.now()
    return index.filter((m) => {
      if (!kinds.includes(m.kind)) return false
      // "general" existe nos dois modos, mas os aprendizados gravados sob ele
      // são conhecimento de código — no chat eles não entram.
      if (mode === 'chat' && isCodeContext(m)) return false
      if (m.expiresAt != null && m.expiresAt < now) return false
      // O filtro vale para TODOS os kinds: uma memória geral criada em outro
      // projeto não pertence a esta vista. As sem origem seguem globais.
      if (projectFilter !== ALL_PROJECTS && !matchesProjectFilter(m, projectFilter)) return false
      return true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, mode, projectFilter])

  const filtered = useMemo(() => {
    if (query.trim()) return searchMemories(pool, query, 50)
    return [...pool].sort((a, b) => lastActivity(b) - lastActivity(a))
  }, [pool, query])

  const byId = useMemo(() => new Map(index.map((m) => [m.id, m])), [index])
  const relatedOf = (memory: Memory) =>
    memory.relatedIds.map((id) => byId.get(id)).filter((m): m is Memory => m != null)

  const empty = (tab === 'graph' ? pool : filtered).length === 0

  return (
    <SafeScreen style={s.container}>
      {/* Header */}
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.headerBtn}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <Text style={[s.headerTitle, { color: tokens.foreground }]}>{t('memoriesScreen.title')}</Text>
        <Pressable onPress={() => void fetch()} disabled={loading} style={s.headerBtn}>
          <Spin active={loading}>
            <RefreshCw size={18} color={tokens.mutedForeground} />
          </Spin>
        </Pressable>
      </View>

      <View style={s.body}>
        {/* Busca + tabs Lista/Grafo */}
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

        {/* Filtro de projeto (modo código, 2+ projetos) */}
        {mode === 'code' && projects.length > 1 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ flexGrow: 0 }}
            contentContainerStyle={s.projectChips}
          >
            <Pressable
              onPress={() => setProjectFilter(ALL_PROJECTS)}
              style={[s.projectChip, projectFilter === ALL_PROJECTS && { backgroundColor: tokens.primary, borderColor: tokens.primary }]}
            >
              <Text style={[s.projectChipText, { color: tokens.mutedForeground }, projectFilter === ALL_PROJECTS && { color: tokens.primaryForeground }]}>
                {t('memoriesScreen.allProjects')}
              </Text>
            </Pressable>
            {projects.map((p) => (
              <Pressable
                key={p.id}
                onPress={() => setProjectFilter(p.id)}
                style={[s.projectChip, projectFilter === p.id && { backgroundColor: tokens.primary, borderColor: tokens.primary }]}
              >
                <Text style={[s.projectChipText, { color: tokens.mutedForeground }, projectFilter === p.id && { color: tokens.primaryForeground }]}>
                  {p.name}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        )}

        {/* Conteúdo */}
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
            data={filtered}
            keyExtractor={(m) => m.id}
            renderItem={({ item }) => (
              <View style={{ marginBottom: 10 }}>
                <MemoryCard
                  memory={item}
                  related={relatedOf(item)}
                  onSelectRelated={(id) => {
                    setSelectedId(id)
                    setTab('graph')
                  }}
                />
              </View>
            )}
            contentContainerStyle={{ paddingBottom: 32 }}
            refreshControl={
              <RefreshControl refreshing={loading} onRefresh={() => void fetch()} tintColor={tokens.primary} />
            }
          />
        ) : (
          <MemoryGraph
            pool={pool}
            allById={byId}
            query={query}
            selectedId={selectedId}
            onSelect={setSelectedId}
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
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  headerBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 16, fontWeight: '600' },

  body: { flex: 1, paddingHorizontal: 16, paddingTop: 12, gap: 10 },

  controls: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  searchInput: { flex: 1, fontSize: 14, paddingVertical: 6 },
  tabs: {
    flexDirection: 'row',
    borderRadius: 10,
    padding: 3,
    gap: 3,
  },
  tabBtn: { width: 36, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },

  projectChips: { flexDirection: 'row', gap: 6 },
  projectChip: {
    borderRadius: 9999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  projectChipText: { fontSize: 12, fontWeight: '500' },

  emptyBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 32 },
  emptyTitle: { fontSize: 14, fontWeight: '600' },
  emptyDesc: { fontSize: 12, textAlign: 'center', lineHeight: 18 },
})
