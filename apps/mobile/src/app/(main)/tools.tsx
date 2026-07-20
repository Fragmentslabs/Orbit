import { useCallback, useEffect, useState } from 'react'
import { View, Text, Pressable, ScrollView, RefreshControl, StyleSheet, Alert } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import {
  ArrowLeft,
  Puzzle,
  Server,
  Sparkles,
  Globe,
  Terminal,
  Wifi,
  WifiOff,
  Loader,
  AlertCircle,
  Plus,
  ChevronDown,
  ChevronRight,
  Eye,
  Pencil,
  Trash2,
  RefreshCw,
  FileUp,
  MessageSquare,
} from 'lucide-react-native'
import type { Skill, McpServerStatus, McpConnectionState, McpServerConfig } from '@orbit/shared'
import { useToolsStore } from '~/stores/tools-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { SkillFormModal } from '~/components/chat/SkillFormModal'
import { SkillContentModal } from '~/components/chat/SkillContentModal'
import { McpServerFormModal } from '~/components/chat/McpServerFormModal'

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

function McpServerCard({
  server,
  onEdit,
  onDelete,
  onReconnect,
}: {
  server: McpServerStatus
  onEdit: (config: McpServerConfig) => void
  onDelete: (name: string) => void
  onReconnect: (name?: string) => void
}) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const [toolsOpen, setToolsOpen] = useState(false)

  return (
    <View style={[s.serverCard, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
      <View style={s.serverHeader}>
        <Server size={15} color={tokens.mutedForeground} />
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
          <Text style={[s.serverMetaText, { color: tokens.mutedForeground }]} numberOfLines={1}>
            {server.config.type === 'http' ? server.config.url : server.config.command}
          </Text>
        </View>
      </View>

      {/* Tool names collapsible */}
      {server.toolNames.length > 0 && (
        <Pressable
          onPress={() => setToolsOpen((o) => !o)}
          style={[s.toolsToggle, { borderTopColor: tokens.border }]}
        >
          <Text style={[s.toolsToggleText, { color: tokens.mutedForeground }]}>
            {server.toolNames.length} {server.toolNames.length === 1 ? 'tool' : 'tools'}
          </Text>
          {toolsOpen ? (
            <ChevronDown size={14} color={tokens.mutedForeground} />
          ) : (
            <ChevronRight size={14} color={tokens.mutedForeground} />
          )}
        </Pressable>
      )}
      {toolsOpen && server.toolNames.length > 0 && (
        <View style={[s.toolsList, { borderTopColor: tokens.border }]}>
          {server.toolNames.map((tool) => (
            <Text key={tool} style={[s.toolName, { color: tokens.foreground }]}>{tool}</Text>
          ))}
        </View>
      )}

      {/* Actions */}
      <View style={[s.actionsRow, { borderTopColor: tokens.border }]}>
        <Pressable onPress={() => onReconnect(server.config.name)} style={s.actionBtn}>
          <RefreshCw size={13} color={tokens.mutedForeground} />
          <Text style={[s.actionLabel, { color: tokens.mutedForeground }]}>Reconectar</Text>
        </Pressable>
        <Pressable onPress={() => onEdit(server.config)} style={s.actionBtn}>
          <Pencil size={13} color={tokens.mutedForeground} />
          <Text style={[s.actionLabel, { color: tokens.mutedForeground }]}>Editar</Text>
        </Pressable>
        <Pressable onPress={() => onDelete(server.config.name)} style={s.actionBtn}>
          <Trash2 size={13} color={tokens.destructive} />
          <Text style={[s.actionLabel, { color: tokens.destructive }]}>Excluir</Text>
        </Pressable>
      </View>
    </View>
  )
}

function SkillCard({
  skill,
  onView,
  onEdit,
  onDelete,
}: {
  skill: Skill
  onView: (skill: Skill) => void
  onEdit: (skill: Skill) => void
  onDelete: (slug: string) => void
}) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  return (
    <View style={[s.skillCard, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
      <View style={s.skillRow}>
        <View style={[s.skillIconWrap, { backgroundColor: tokens.muted }]}>
          <Sparkles size={14} color={tokens.mutedForeground} />
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
      <View style={[s.actionsRow, { borderTopColor: tokens.border }]}>
        <Pressable onPress={() => onView(skill)} style={s.actionBtn}>
          <Eye size={13} color={tokens.mutedForeground} />
          <Text style={[s.actionLabel, { color: tokens.mutedForeground }]}>Ver</Text>
        </Pressable>
        <Pressable onPress={() => onEdit(skill)} style={s.actionBtn}>
          <Pencil size={13} color={tokens.mutedForeground} />
          <Text style={[s.actionLabel, { color: tokens.mutedForeground }]}>Editar</Text>
        </Pressable>
        <Pressable onPress={() => onDelete(skill.slug)} style={s.actionBtn}>
          <Trash2 size={13} color={tokens.destructive} />
          <Text style={[s.actionLabel, { color: tokens.destructive }]}>Excluir</Text>
        </Pressable>
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

export default function ToolsScreen() {
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
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
  const saveMcpConfig = useToolsStore((s) => s.saveMcpConfig)
  const reconnectMcp = useToolsStore((s) => s.reconnectMcp)

  const [skillFormOpen, setSkillFormOpen] = useState(false)
  const [editSkill, setEditSkill] = useState<Skill | undefined>(undefined)
  const [viewSkill, setViewSkill] = useState<Skill | null>(null)
  const [mcpFormOpen, setMcpFormOpen] = useState(false)
  const [editMcp, setEditMcp] = useState<McpServerConfig | undefined>(undefined)

  const load = useCallback(() => {
    void Promise.all([fetchSkills(), fetchMcpStatus(), fetchPending()])
  }, [fetchSkills, fetchMcpStatus, fetchPending])

  useEffect(() => {
    void hydrateCache()
    void load()
  }, [hydrateCache, load])

  const isEmpty = skills.length === 0 && mcpServers.length === 0 && pending.length === 0 && !loading

  const handleCreateSkill = () => {
    setEditSkill(undefined)
    setSkillFormOpen(true)
  }

  const handleEditSkill = (skill: Skill) => {
    setEditSkill(skill)
    setSkillFormOpen(true)
  }

  const handleDeleteSkill = (slug: string) => {
    Alert.alert('Excluir skill', `Excluir @${slug}?`, [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Excluir', style: 'destructive', onPress: () => void removeSkill(slug) },
    ])
  }

  const handleImportSkill = async () => {
    try {
      const fs = (await import('expo-file-system/legacy')).default
      const doc = (await import('expo-document-picker')).default
      const result = await doc.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true })
      if (result.canceled || !result.assets?.[0]) return
      const asset = result.assets[0]
      const base64 = await fs.readAsStringAsync(asset.uri, { encoding: fs.EncodingType.Base64 })
      await importSkill(base64, asset.name ?? 'skill.skill')
    } catch {
      Alert.alert('Erro', 'Não foi possível importar a skill.')
    }
  }

  const handleAskOrbit = () => {
    router.push('/(main)')
  }

  const handleEditMcp = (config: McpServerConfig) => {
    setEditMcp(config)
    setMcpFormOpen(true)
  }

  const handleDeleteMcp = (name: string) => {
    Alert.alert('Excluir servidor', `Excluir "${name}"?`, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Excluir',
        style: 'destructive',
        onPress: async () => {
          const filtered = mcpServers.map((s) => s.config).filter((c) => c.name !== name)
          await saveMcpConfig({ servers: filtered })
        },
      },
    ])
  }

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
              Configure Skills e servidores MCP no Orbit Desktop ou crie uma skill aqui mesmo.
            </Text>
          </View>
        )}

        {/* Pending proposals */}
        {pending.length > 0 && (
          <>
            <Text style={[s.sectionLabel, { color: tokens.mutedForeground }]}>
              Propostas pendentes ({pending.length})
            </Text>
            <View style={s.section}>
              {pending.map((prop) => (
                <PendingProposalCard key={prop.slug} proposal={prop} />
              ))}
            </View>
          </>
        )}

        {/* MCP Servers */}
        {mcpServers.length > 0 && (
          <>
            <View style={s.sectionHeader}>
              <Text style={[s.sectionLabel, { color: tokens.mutedForeground }]}>
                Servidores MCP ({mcpServers.length})
              </Text>
              <Pressable onPress={() => { setEditMcp(undefined); setMcpFormOpen(true) }} style={s.addSectionBtn}>
                <Plus size={14} color={tokens.primary} />
                <Text style={[s.addSectionText, { color: tokens.primary }]}>Adicionar</Text>
              </Pressable>
            </View>
            <View style={s.section}>
              {mcpServers.map((server) => (
                <McpServerCard
                  key={server.config.name}
                  server={server}
                  onEdit={handleEditMcp}
                  onDelete={handleDeleteMcp}
                  onReconnect={(name) => void reconnectMcp(name)}
                />
              ))}
            </View>
          </>
        )}

        {/* Skills */}
        <View style={s.sectionHeader}>
          <Text style={[s.sectionLabel, { color: tokens.mutedForeground }]}>
            Skills ({skills.length})
          </Text>
          <View style={s.createSkillRow}>
            <Pressable onPress={() => { setEditSkill(undefined); setSkillFormOpen(true) }} style={s.addSectionBtn}>
              <Plus size={14} color={tokens.primary} />
              <Text style={[s.addSectionText, { color: tokens.primary }]}>Criar</Text>
            </Pressable>
            <Pressable onPress={handleImportSkill} style={s.addSectionBtn}>
              <FileUp size={14} color={tokens.primary} />
              <Text style={[s.addSectionText, { color: tokens.primary }]}>Importar</Text>
            </Pressable>
            <Pressable onPress={handleAskOrbit} style={s.addSectionBtn}>
              <MessageSquare size={14} color={tokens.primary} />
              <Text style={[s.addSectionText, { color: tokens.primary }]}>Pedir ao Orbit</Text>
            </Pressable>
          </View>
        </View>
        {skills.length > 0 ? (
          <View style={s.section}>
            {skills.map((skill) => (
              <SkillCard
                key={skill.slug}
                skill={skill}
                onView={setViewSkill}
                onEdit={handleEditSkill}
                onDelete={handleDeleteSkill}
              />
            ))}
          </View>
        ) : (
          !isEmpty && (
            <View style={s.emptyBox}>
              <Sparkles size={24} color={tokens.mutedForeground} />
              <Text style={[s.emptyDesc, { color: tokens.mutedForeground }]}>
                Nenhuma skill ainda. Crie uma ou importe do desktop.
              </Text>
            </View>
          )
        )}
      </ScrollView>

      {/* Modals */}
      <SkillFormModal visible={skillFormOpen} onClose={() => setSkillFormOpen(false)} edit={editSkill} />
      <SkillContentModal visible={viewSkill !== null} onClose={() => setViewSkill(null)} skill={viewSkill} />
      <McpServerFormModal visible={mcpFormOpen} onClose={() => setMcpFormOpen(false)} edit={editMcp} />
    </SafeAreaView>
  )
}

function PendingProposalCard({ proposal }: { proposal: import('@orbit/shared').SkillProposal }) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const approveSkill = useToolsStore((s) => s.approveSkill)
  const discardSkill = useToolsStore((s) => s.discardSkill)

  return (
    <View style={[s.pendingCard, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Sparkles size={14} color={tokens.primary} />
        <Text style={[s.pendingTitle, { color: tokens.foreground }]}>{proposal.name}</Text>
      </View>
      {proposal.description && (
        <Text style={[s.pendingDesc, { color: tokens.mutedForeground }]} numberOfLines={2}>{proposal.description}</Text>
      )}
      <Text style={[s.pendingSlug, { color: tokens.mutedForeground }]}>@{proposal.slug}</Text>
      {proposal.files && proposal.files.length > 0 && (
        <Text style={[s.pendingFiles, { color: tokens.mutedForeground }]}>
          {proposal.files.length} {proposal.files.length === 1 ? 'arquivo adicional' : 'arquivos adicionais'}
        </Text>
      )}
      <View style={[s.pendingActions, { borderTopColor: tokens.border }]}>
        <Pressable onPress={() => void discardSkill(proposal.slug)} style={[s.pendingBtn, { borderColor: tokens.border }]}>
          <Text style={[s.pendingBtnText, { color: tokens.foreground }]}>Dispensar</Text>
        </Pressable>
        <Pressable onPress={() => void approveSkill(proposal.slug)} style={[s.pendingBtn, { backgroundColor: tokens.primary }]}>
          <Text style={[s.pendingBtnText, { color: '#fff' }]}>Adicionar skill</Text>
        </Pressable>
      </View>
    </View>
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

  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 22,
    paddingBottom: 8,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  addSectionBtn: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingVertical: 4, paddingHorizontal: 6 },
  addSectionText: { fontSize: 12, fontWeight: '600' },
  createSkillRow: { flexDirection: 'row', gap: 2 },
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
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
  },
  serverType: { flexDirection: 'row', alignItems: 'center', gap: 4, flex: 1 },
  serverMetaText: { fontSize: 10, fontFamily: 'monospace', flexShrink: 1 },
  toolsToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderTopWidth: 1,
  },
  toolsToggleText: { fontSize: 11, fontWeight: '500' },
  toolsList: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    gap: 4,
    borderTopWidth: 1,
  },
  toolName: { fontSize: 11, fontFamily: 'monospace', paddingVertical: 1 },

  actionsRow: {
    flexDirection: 'row',
    borderTopWidth: 1,
  },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 9,
  },
  actionLabel: { fontSize: 11, fontWeight: '600' },

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
    borderRadius: 16,
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

  pendingCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    gap: 6,
  },
  pendingTitle: { fontSize: 14, fontWeight: '600' },
  pendingDesc: { fontSize: 12, lineHeight: 16 },
  pendingSlug: { fontSize: 11, fontFamily: 'monospace' },
  pendingFiles: { fontSize: 11 },
  pendingActions: {
    flexDirection: 'row',
    gap: 8,
    paddingTop: 10,
    marginTop: 2,
    borderTopWidth: 1,
  },
  pendingBtn: {
    flex: 1,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'transparent',
    paddingVertical: 8,
    alignItems: 'center',
  },
  pendingBtnText: { fontSize: 12, fontWeight: '600' },
})
