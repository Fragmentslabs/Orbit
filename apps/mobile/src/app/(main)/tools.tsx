import { useCallback, useEffect } from 'react'
import { View, Text, Pressable, ScrollView, RefreshControl, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import {
  ArrowLeft,
  BookOpen,
  Puzzle,
  Wifi,
  WifiOff,
  Loader,
  AlertCircle,
  Server,
  Globe,
  Terminal,
} from 'lucide-react-native'
import type { Skill, McpServerStatus, McpConnectionState } from '@orbit/shared'
import { useToolsStore } from '~/stores/tools-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

function ConnectionDot({ state }: { state: McpConnectionState }) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const color =
    state === 'connected' ? '#22c55e'
    : state === 'connecting' ? tokens.primary
    : state === 'error' ? '#ef4444'
    : tokens.mutedForeground
  const size = 8

  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
}

function StateIcon({ state }: { state: McpConnectionState }) {
  if (state === 'connected') return <Wifi size={14} color="#22c55e" />
  if (state === 'connecting') return <Loader size={14} color="#f59e0b" />
  if (state === 'error') return <AlertCircle size={14} color="#ef4444" />
  return <WifiOff size={14} color="#6b7280" />
}

function McpServerCard({ server }: { server: McpServerStatus }) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  return (
    <View style={[s.serverCard, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
      <View style={s.serverHeader}>
        <StateIcon state={server.state} />
        <Text style={[s.serverName, { color: tokens.foreground }]} numberOfLines={1}>
          {server.config.name}
        </Text>
        <View style={[s.stateBadge, serverStateBadge(server.state, tokens)]}>
          <ConnectionDot state={server.state} />
          <Text style={[s.stateLabel, { color: stateLabelColor(server.state) }]}>
            {stateLabel(server.state)}
          </Text>
        </View>
      </View>
      {server.error && (
        <Text style={[s.serverError, { color: '#ef4444' }]} numberOfLines={2}>{server.error}</Text>
      )}
      <View style={[s.serverMeta, { borderTopColor: tokens.border }]}>
        <View style={s.serverType}>
          {server.config.type === 'http' ? (
            <Globe size={11} color={tokens.mutedForeground} />
          ) : (
            <Terminal size={11} color={tokens.mutedForeground} />
          )}
          <Text style={[s.serverMetaText, { color: tokens.mutedForeground }]}>
            {server.config.type === 'http' ? server.config.url : server.config.command}
          </Text>
        </View>
        {server.toolNames.length > 0 && (
          <Text style={[s.serverMetaText, { color: tokens.mutedForeground }]}>
            {server.toolNames.length} {server.toolNames.length === 1 ? 'tool' : 'tools'}
          </Text>
        )}
      </View>
    </View>
  )
}

function stateLabel(state: McpConnectionState): string {
  switch (state) {
    case 'connected': return 'Conectado'
    case 'connecting': return 'Conectando'
    case 'error': return 'Erro'
    case 'disabled': return 'Desativado'
  }
}

function stateLabelColor(state: McpConnectionState): string {
  switch (state) {
    case 'connected': return '#22c55e'
    case 'connecting': return '#f59e0b'
    case 'error': return '#ef4444'
    case 'disabled': return '#6b7280'
  }
}

function serverStateBadge(state: McpConnectionState, tokens: Record<string, string>) {
  switch (state) {
    case 'connected': return { backgroundColor: 'rgba(34,197,94,0.12)' }
    case 'connecting': return { backgroundColor: 'rgba(245,158,11,0.12)' }
    case 'error': return { backgroundColor: 'rgba(239,68,68,0.12)' }
    case 'disabled': return { backgroundColor: 'rgba(107,114,128,0.12)' }
  }
}

function SkillCard({ skill }: { skill: Skill }) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  return (
    <View style={[s.skillCard, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
      <View style={s.skillRow}>
        <View style={[s.skillIconWrap, { backgroundColor: tokens.primary + '18' }]}>
          <BookOpen size={14} color={tokens.primary} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[s.skillName, { color: tokens.foreground }]} numberOfLines={1}>{skill.name}</Text>
          {skill.description && (
            <Text style={[s.skillDesc, { color: tokens.mutedForeground }]} numberOfLines={2}>{skill.description}</Text>
          )}
        </View>
        <View style={[s.sourceBadge, { backgroundColor: skill.source === 'global' ? 'rgba(99,102,241,0.12)' : 'rgba(245,158,11,0.12)' }]}>
          <Text style={[s.sourceLabel, { color: skill.source === 'global' ? '#818cf8' : '#f59e0b' }]}>
            {skill.source === 'global' ? 'Global' : 'Projeto'}
          </Text>
        </View>
      </View>
      <View style={[s.skillFooter, { borderTopColor: tokens.border }]}>
        <Text style={[s.skillSlug, { color: tokens.mutedForeground }]}>@{skill.slug}</Text>
        {skill.scripts && skill.scripts.length > 0 && (
          <Text style={[s.skillScripts, { color: tokens.mutedForeground }]}>
            {skill.scripts.length} {skill.scripts.length === 1 ? 'script' : 'scripts'}
          </Text>
        )}
      </View>
    </View>
  )
}

export default function ToolsScreen() {
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const skills = useToolsStore((s) => s.skills)
  const mcpServers = useToolsStore((s) => s.mcpServers)
  const loading = useToolsStore((s) => s.loading)
  const fetchSkills = useToolsStore((s) => s.fetchSkills)
  const fetchMcpStatus = useToolsStore((s) => s.fetchMcpStatus)
  const hydrateCache = useToolsStore((s) => s.hydrateCache)

  const load = useCallback(() => {
    void Promise.all([fetchSkills(), fetchMcpStatus()])
  }, [fetchSkills, fetchMcpStatus])

  useEffect(() => {
    void hydrateCache()
    void load()
  }, [hydrateCache, load])

  const isEmpty = skills.length === 0 && mcpServers.length === 0 && !loading

  return (
    <SafeAreaView style={[s.container, { backgroundColor: tokens.background }]} edges={['top']}>
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.headerBtn}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <Text style={[s.headerTitle, { color: tokens.foreground }]}>Ferramentas</Text>
        <View style={s.headerBtn} />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 48 }}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={load} tintColor={tokens.primary} />
        }
      >
        {isEmpty && (
          <View style={s.emptyBox}>
            <Puzzle size={32} color={tokens.mutedForeground} />
            <Text style={[s.emptyTitle, { color: tokens.foreground }]}>Nenhuma ferramenta encontrada</Text>
            <Text style={[s.emptyDesc, { color: tokens.mutedForeground }]}>
              Configure Skills e servidores MCP no Orbit Desktop para vê-los aqui.
            </Text>
          </View>
        )}

        {mcpServers.length > 0 && (
          <>
            <Text style={[s.sectionLabel, { color: tokens.mutedForeground }]}>
              Servidores MCP ({mcpServers.length})
            </Text>
            <View style={s.section}>
              {mcpServers.map((server) => (
                <McpServerCard key={server.config.name} server={server} />
              ))}
            </View>
          </>
        )}

        {skills.length > 0 && (
          <>
            <Text style={[s.sectionLabel, { color: tokens.mutedForeground }]}>
              Skills ({skills.length})
            </Text>
            <View style={s.section}>
              {skills.map((skill) => (
                <SkillCard key={skill.slug} skill={skill} />
              ))}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
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

  sectionLabel: {
    paddingHorizontal: 20,
    paddingTop: 22,
    paddingBottom: 8,
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  section: {
    marginHorizontal: 16,
    gap: 8,
  },

  emptyBox: { alignItems: 'center', gap: 10, paddingVertical: 60, paddingHorizontal: 32 },
  emptyTitle: { fontSize: 16, fontWeight: '600', textAlign: 'center' },
  emptyDesc: { fontSize: 13, textAlign: 'center', lineHeight: 20 },

  serverCard: {
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  serverHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  serverName: { flex: 1, fontSize: 13, fontWeight: '600' },
  stateBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  stateLabel: { fontSize: 10, fontWeight: '600' },
  serverError: { fontSize: 11, paddingHorizontal: 12, paddingBottom: 6 },
  serverMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
  },
  serverType: { flexDirection: 'row', alignItems: 'center', gap: 4, flex: 1 },
  serverMetaText: { fontSize: 10, fontFamily: 'monospace', flexShrink: 1 },

  skillCard: {
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  skillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  skillIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  skillName: { fontSize: 13, fontWeight: '600' },
  skillDesc: { fontSize: 11, lineHeight: 16 },
  sourceBadge: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
  },
  sourceLabel: { fontSize: 10, fontWeight: '600' },
  skillFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderTopWidth: 1,
  },
  skillSlug: { fontSize: 10, fontFamily: 'monospace' },
  skillScripts: { fontSize: 10 },
})
