/**
 * Tools screen — mirror of the desktop's Tools page: the sections as tabs (MCP servers, skills),
 * a search, rows with a state tile and pill, and ONE "Add" button that opens the menu leading to the
 * creation chat first. Tapping a row opens its detail on this same screen. (Hooks and the
 * integrations of the desktop are not reachable from the phone.)
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, FlatList, RefreshControl, Alert, StyleSheet } from 'react-native'
import { useConfirm } from '~/components/ui/confirm-dialog'
import * as DocumentPicker from 'expo-document-picker'
import * as FileSystem from 'expo-file-system/legacy'
import { useRouter } from 'expo-router'
import { FileUp, Info, Plus, Puzzle } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { McpServerConfig, Skill } from '@orbit/shared'
import { useToolsStore } from '~/stores/tools-store'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { SkillFormModal } from '~/components/chat/SkillFormModal'
import { SkillContentModal } from '~/components/chat/SkillContentModal'
import { McpServerFormModal } from '~/components/chat/McpServerFormModal'
import { CreateSheet } from '~/components/list/create-sheet'
import { CountLine, FootLine, HeaderButton, ListHeader, PageTabs, SearchField, StatePill, useTokens } from '~/components/list/parts'
import { FilterChips, ProposalsBanner, ProposalsSheet, ServerRow, SkillRow, serverTone, useServerLabel } from '~/components/tools/tools-parts'
import { ServerDetail, SkillDetail } from '~/components/tools/tools-detail'
import { useStartCreationChat } from '~/hooks/useCreationChat'

type Tab = 'mcp' | 'skills'
type SkillFilter = 'all' | 'mine' | 'builtin'
type Selected = { kind: 'mcp'; name: string } | { kind: 'skill'; slug: string } | null

export default function ToolsScreen() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const router = useRouter()
  const tokens = useTokens()
  const labelOf = useServerLabel()
  const skills = useToolsStore((s) => s.skills)
  const mcpServers = useToolsStore((s) => s.mcpServers)
  const pending = useToolsStore((s) => s.pending)
  const loading = useToolsStore((s) => s.loading)
  const fetchSkills = useToolsStore((s) => s.fetchSkills)
  const fetchMcpStatus = useToolsStore((s) => s.fetchMcpStatus)
  const fetchPending = useToolsStore((s) => s.fetchPending)
  const hydrateCache = useToolsStore((s) => s.hydrateCache)
  const removeSkill = useToolsStore((s) => s.removeSkill)
  const importSkill = useToolsStore((s) => s.importSkill)
  const reconnectMcp = useToolsStore((s) => s.reconnectMcp)
  const authorizeMcp = useToolsStore((s) => s.authorizeMcp)
  const saveMcpConfig = useToolsStore((s) => s.saveMcpConfig)
  const startCreation = useStartCreationChat()

  const [tab, setTab] = useState<Tab>('mcp')
  const [query, setQuery] = useState('')
  const [skillFilter, setSkillFilter] = useState<SkillFilter>('all')
  const [selected, setSelected] = useState<Selected>(null)
  const [adding, setAdding] = useState(false)
  const [proposalsOpen, setProposalsOpen] = useState(false)
  const [skillFormOpen, setSkillFormOpen] = useState(false)
  const [editSkill, setEditSkill] = useState<Skill | undefined>(undefined)
  const [viewSkill, setViewSkill] = useState<Skill | null>(null)
  const [mcpFormOpen, setMcpFormOpen] = useState(false)
  const [editMcp, setEditMcp] = useState<McpServerConfig | undefined>(undefined)
  const [importing, setImporting] = useState(false)

  const load = useCallback(() => {
    void Promise.all([fetchSkills(), fetchMcpStatus(), fetchPending()])
  }, [fetchSkills, fetchMcpStatus, fetchPending])

  useEffect(() => {
    void hydrateCache()
    void load()
  }, [hydrateCache, load])

  const mine = useMemo(() => skills.filter((sk) => sk.source !== 'builtin'), [skills])
  const builtin = useMemo(() => skills.filter((sk) => sk.source === 'builtin'), [skills])
  const needle = query.trim().toLowerCase()

  const visibleServers = useMemo(() => {
    // What needs the user first (error, authorization), then by name — as the desktop's rows.
    const rank = (tone: ReturnType<typeof serverTone>['tone']) => ({ bad: 0, warn: 1, run: 2, ok: 3, idle: 4 })[tone]
    return mcpServers
      .filter((sv) => !needle || [sv.config.name, sv.config.url, sv.config.command, ...sv.toolNames].some((f) => f?.toLowerCase().includes(needle)))
      .sort((a, b) => rank(serverTone(a).tone) - rank(serverTone(b).tone) || a.config.name.localeCompare(b.config.name))
  }, [mcpServers, needle])

  const visibleSkills = useMemo(() => {
    const base = skillFilter === 'mine' ? mine : skillFilter === 'builtin' ? builtin : skills
    return base.filter((sk) => !needle || [sk.name, sk.slug, sk.description].some((f) => f?.toLowerCase().includes(needle)))
  }, [skills, mine, builtin, skillFilter, needle])

  const selectedServer = selected?.kind === 'mcp' ? mcpServers.find((sv) => sv.config.name === selected.name) : undefined
  const selectedSkill = selected?.kind === 'skill' ? skills.find((sk) => sk.slug === selected.slug) : undefined
  // If the thing under the detail was removed (here or on the desktop), the list shows again.

  const pickTab = (next: Tab) => {
    setTab(next)
    setQuery('')
  }

  const openSkillForm = (skill?: Skill) => {
    setEditSkill(skill)
    setSkillFormOpen(true)
  }

  const openMcpForm = (config?: McpServerConfig) => {
    setEditMcp(config)
    setMcpFormOpen(true)
  }

  const handleDeleteSkill = async (slug: string) => {
    const ok = await confirm({
      title: t('toolsScreen.deleteSkillTitle'),
      description: t('toolsScreen.deleteSkillBody', { slug }),
      confirmLabel: t('toolsScreen.delete'),
      cancelLabel: t('toolsScreen.cancel'),
      destructive: true,
    })
    if (ok) void removeSkill(slug)
  }

  const handleDeleteMcp = async (name: string) => {
    const ok = await confirm({
      title: t('toolsScreen.deleteServerTitle'),
      description: t('toolsScreen.deleteServerBody', { name }),
      confirmLabel: t('toolsScreen.delete'),
      cancelLabel: t('toolsScreen.cancel'),
      destructive: true,
    })
    if (!ok) return
    const remaining = mcpServers.filter((sv) => sv.config.name !== name).map((sv) => sv.config)
    await saveMcpConfig({ servers: remaining })
  }

  const handleImportSkill = async () => {
    setImporting(true)
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['text/plain', 'text/markdown', 'application/octet-stream'],
        copyToCacheDirectory: true,
      })
      if (result.canceled || !result.assets?.[0]) return
      const asset = result.assets[0]
      const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 })
      await importSkill(base64, asset.name ?? 'skill.skill')
    } catch (err) {
      Alert.alert(t('toolsScreen.errorTitle'), String(err))
    } finally {
      setImporting(false)
    }
  }

  const subtitle = [t('toolsScreen.serversN', { count: mcpServers.length }), t('toolsScreen.skillsN', { count: skills.length })].join(' · ')
  const connected = mcpServers.filter((sv) => sv.state === 'connected').length

  // ── Detail of a server or a skill ──
  if (selected && (selectedServer || selectedSkill)) {
    const server = selectedServer
    const tone = server ? serverTone(server) : null
    return (
      <SafeScreen style={s.container}>
        <ListHeader
          title={server ? server.config.name : `@${selectedSkill!.slug}`}
          subtitle={server ? t('toolsScreen.serverSubtitle', { type: server.config.type }) : selectedSkill!.source === 'builtin' ? t('toolsScreen.pillBuiltin') : t('toolsScreen.sourceMine')}
          onBack={() => setSelected(null)}
          right={tone ? <View style={{ marginRight: 8 }}><StatePill state={tone.tone} label={labelOf(tone.label)} /></View> : undefined}
        />
        {server ? (
          <ServerDetail server={server} onEdit={openMcpForm} onDelete={(name) => void handleDeleteMcp(name)} onReconnect={(name) => void reconnectMcp(name)} onAuthorize={(name) => void authorizeMcp(name)} />
        ) : (
          <SkillDetail skill={selectedSkill!} onViewAll={setViewSkill} onEdit={openSkillForm} onDelete={(slug) => void handleDeleteSkill(slug)} />
        )}
        <SkillFormModal visible={skillFormOpen} onClose={() => setSkillFormOpen(false)} edit={editSkill} />
        <SkillContentModal visible={viewSkill !== null} onClose={() => setViewSkill(null)} skill={viewSkill} />
        <McpServerFormModal visible={mcpFormOpen} onClose={() => setMcpFormOpen(false)} edit={editMcp} />
      </SafeScreen>
    )
  }

  const empty = mcpServers.length === 0 && skills.length === 0 && pending.length === 0 && !loading
  return (
    <SafeScreen style={s.container}>
      <ListHeader title={t('toolsScreen.title')} subtitle={subtitle} onBack={() => router.back()} right={<HeaderButton icon={Plus} label={t('toolsScreen.add')} onPress={() => setAdding(true)} />} />
      <PageTabs
        value={tab}
        onChange={pickTab}
        items={[
          { key: 'mcp', label: t('toolsScreen.tabServers'), count: mcpServers.length },
          { key: 'skills', label: t('toolsScreen.tabSkills'), count: skills.length },
        ]}
      />

      {empty ? (
        <View style={s.center}>
          <Puzzle size={36} color={tokens.mutedForeground} style={{ opacity: 0.5 }} />
          <Text style={[s.emptyTitle, { color: tokens.foreground }]}>{t('toolsScreen.emptyTitle')}</Text>
          <Text style={[s.emptyText, { color: tokens.mutedForeground }]}>{t('toolsScreen.emptyDesc')}</Text>
        </View>
      ) : (
        <>
          {pending.length > 0 ? <ProposalsBanner count={pending.length} first={pending[0]} onOpen={() => setProposalsOpen(true)} /> : null}
          <View style={s.bar}>
            <SearchField value={query} onChange={setQuery} placeholder={tab === 'mcp' ? t('toolsScreen.searchServers') : t('toolsScreen.searchSkills')} />
          </View>
          {tab === 'skills' ? (
            <FilterChips
              value={skillFilter}
              onChange={setSkillFilter}
              items={[
                { key: 'all', label: t('toolsScreen.filterAll'), count: skills.length },
                { key: 'mine', label: t('toolsScreen.filterMine'), count: mine.length },
                { key: 'builtin', label: t('toolsScreen.filterBuiltin'), count: builtin.length },
              ]}
            />
          ) : null}
          <CountLine>{tab === 'mcp'
              ? [t('toolsScreen.serversN', { count: mcpServers.length }), t('toolsScreen.connectedN', { count: connected })].join(' · ')
              : [t('toolsScreen.skillsN', { count: skills.length }), t('toolsScreen.mineN', { count: mine.length })].join(' · ')}</CountLine>

          {tab === 'mcp' ? (
            <FlatList
              data={visibleServers}
              keyExtractor={(sv) => sv.config.name}
              renderItem={({ item }) => <ServerRow server={item} onOpen={() => setSelected({ kind: 'mcp', name: item.config.name })} />}
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 12 }}
              refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={tokens.primary} />}
              ListEmptyComponent={<Text style={[s.noResults, { color: tokens.mutedForeground, borderColor: tokens.border }]}>{needle ? t('toolsScreen.noResults', { query: query.trim() }) : t('toolsScreen.emptyDesc')}</Text>}
            />
          ) : (
            <FlatList
              data={visibleSkills}
              keyExtractor={(sk) => sk.slug}
              renderItem={({ item }) => <SkillRow skill={item} onOpen={() => setSelected({ kind: 'skill', slug: item.slug })} />}
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 12 }}
              refreshControl={<RefreshControl refreshing={loading || importing} onRefresh={load} tintColor={tokens.primary} />}
              ListEmptyComponent={<Text style={[s.noResults, { color: tokens.mutedForeground, borderColor: tokens.border }]}>{needle ? t('toolsScreen.noResults', { query: query.trim() }) : t('toolsScreen.noSkillsYet')}</Text>}
            />
          )}
          {tab === 'mcp' ? <FootLine icon={Info} text={t('toolsScreen.footServers')} /> : null}
        </>
      )}

      <CreateSheet
        kind={tab === 'mcp' ? 'mcp' : 'skill'}
        open={adding}
        onClose={() => setAdding(false)}
        onChat={(text) => void startCreation(tab === 'mcp' ? 'mcp' : 'skill', text)}
        onForm={() => (tab === 'mcp' ? openMcpForm() : openSkillForm())}
        extra={tab === 'skills' ? [{ key: 'import', icon: FileUp, title: t('toolsScreen.importFile'), hint: t('toolsScreen.importHint'), onPress: () => void handleImportSkill() }] : undefined}
      />
      <ProposalsSheet open={proposalsOpen && pending.length > 0} proposals={pending} onClose={() => setProposalsOpen(false)} />
      <SkillFormModal visible={skillFormOpen} onClose={() => setSkillFormOpen(false)} edit={editSkill} />
      <SkillContentModal visible={viewSkill !== null} onClose={() => setViewSkill(null)} skill={viewSkill} />
      <McpServerFormModal visible={mcpFormOpen} onClose={() => setMcpFormOpen(false)} edit={editMcp} />
    </SafeScreen>
  )
}

const s = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 28 },
  emptyTitle: { fontSize: 15, fontWeight: '600' },
  emptyText: { fontSize: 12, textAlign: 'center', lineHeight: 18 },
  bar: { flexDirection: 'row', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  noResults: { margin: 16, padding: 24, borderWidth: 1, borderStyle: 'dashed', borderRadius: 12, textAlign: 'center', fontSize: 12.5 },
})
