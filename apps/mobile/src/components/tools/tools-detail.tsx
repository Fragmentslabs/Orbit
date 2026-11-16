import { useMemo, useState } from 'react'
import { View, Text, Pressable, ScrollView, ActivityIndicator, StyleSheet } from 'react-native'
import { KeyRound, Pencil, RefreshCw, Trash2 } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { McpServerConfig, McpServerStatus, Skill } from '@orbit/shared'
import { SearchField, tint, useTokens } from '~/components/list/parts'
import { DetailCard, KeyValue, needsAuth } from './tools-parts'

function ActionButton({ icon: Icon, label, onPress, destructive, primary, busy }: { icon: typeof Pencil; label: string; onPress: () => void; destructive?: boolean; primary?: boolean; busy?: boolean }) {
  const tokens = useTokens()
  const color = primary ? tokens.primaryForeground : destructive ? tokens.destructive : tokens.foreground
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      style={[s.action, { borderColor: primary ? tokens.primary : tokens.border }, primary && { backgroundColor: tokens.primary }, busy && { opacity: 0.6 }]}
    >
      {busy ? <ActivityIndicator size="small" color={color} /> : <Icon size={16} color={color} />}
      <Text numberOfLines={1} style={{ fontSize: 13.5, fontWeight: '500', color }}>
        {label}
      </Text>
    </Pressable>
  )
}

/** A server: its connection, the tools it exposes (with search) and what can be done to it. */
export function ServerDetail({
  server,
  onEdit,
  onDelete,
  onReconnect,
  onAuthorize,
}: {
  server: McpServerStatus
  onEdit: (config: McpServerConfig) => void
  onDelete: (name: string) => void
  onReconnect: (name: string) => void
  onAuthorize: (name: string) => void
}) {
  const { t } = useTranslation()
  const tokens = useTokens()
  const [query, setQuery] = useState('')
  const config = server.config
  const auth = needsAuth(server)
  const tools = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? server.toolNames.filter((name) => name.toLowerCase().includes(q)) : server.toolNames
  }, [server.toolNames, query])
  const permission = config.permissionMode === 'approve' ? t('toolsScreen.permApprove') : config.permissionMode === 'full' ? t('toolsScreen.permFull') : config.permissionMode === 'ask' ? t('toolsScreen.permAsk') : t('toolsScreen.permDefault')

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 10 }}>
      {server.error ? (
        <View style={[s.notice, { borderColor: server.state === 'unauthorized' ? '#f59e0b66' : tint(tokens.destructive, '66') }]}>
          <Text style={{ fontSize: 12.5, lineHeight: 18, color: server.state === 'unauthorized' ? '#f59e0b' : tokens.destructive }}>{server.error}</Text>
        </View>
      ) : null}
      {auth ? <Text style={{ fontSize: 12, lineHeight: 17, color: tokens.mutedForeground, paddingHorizontal: 2 }}>{t('toolsScreen.authorizeHint')}</Text> : null}

      <DetailCard>
        <View>
          <KeyValue label={t('toolsScreen.type')} value={config.type} />
          <KeyValue label={config.type === 'http' ? t('toolsScreen.address') : t('toolsScreen.command')} value={config.type === 'http' ? (config.url ?? '—') : [config.command, ...(config.args ?? [])].filter(Boolean).join(' ')} mono />
          <KeyValue label={t('toolsScreen.autoReconnect')} value={config.autoReconnect === false ? t('toolsScreen.no') : t('toolsScreen.yes')} />
          <KeyValue label={t('toolsScreen.permission')} value={permission} last />
        </View>
      </DetailCard>

      <DetailCard title={t('toolsScreen.toolsTitle')} action={<Text style={{ fontSize: 12, color: tokens.mutedForeground }}>{server.toolNames.length}</Text>}>
        {server.toolNames.length === 0 ? (
          <Text style={{ fontSize: 12.5, color: tokens.mutedForeground }}>{t('toolsScreen.noTools')}</Text>
        ) : (
          <>
            {server.toolNames.length > 8 ? <SearchField value={query} onChange={setQuery} placeholder={t('toolsScreen.searchTools')} /> : null}
            <View>
              {tools.map((name, i) => (
                <Text key={name} style={[s.tool, { color: tokens.foreground }, i > 0 && { borderTopWidth: 1, borderTopColor: tokens.border }]}>
                  {name}
                </Text>
              ))}
            </View>
          </>
        )}
      </DetailCard>

      <View style={s.actions}>
        {auth ? <ActionButton primary icon={KeyRound} label={server.authorized ? t('toolsScreen.reauthorize') : t('toolsScreen.authorize')} onPress={() => onAuthorize(config.name)} /> : null}
        <ActionButton icon={RefreshCw} label={t('toolsScreen.reconnect')} onPress={() => onReconnect(config.name)} />
        <ActionButton icon={Pencil} label={t('toolsScreen.edit')} onPress={() => onEdit(config)} />
        <ActionButton destructive icon={Trash2} label={t('toolsScreen.delete')} onPress={() => onDelete(config.name)} />
      </View>
    </ScrollView>
  )
}

/** A skill: what it is, a preview of its instructions and what can be done to it. */
export function SkillDetail({ skill, onViewAll, onEdit, onDelete }: { skill: Skill; onViewAll: (skill: Skill) => void; onEdit: (skill: Skill) => void; onDelete: (slug: string) => void }) {
  const { t } = useTranslation()
  const tokens = useTokens()
  const builtin = skill.source === 'builtin'
  const preview = skill.content.split('\n').slice(0, 8).join('\n')
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 10 }}>
      <DetailCard>
        <Text style={{ fontSize: 15, fontWeight: '600', color: tokens.foreground }}>{skill.name}</Text>
        {skill.description ? <Text style={{ fontSize: 13.5, lineHeight: 20, color: tokens.foreground, opacity: 0.9 }}>{skill.description}</Text> : null}
        {skill.scripts && skill.scripts.length > 0 ? (
          <Text style={{ fontSize: 12, color: tokens.mutedForeground }}>{t('toolsScreen.scriptsCount', { count: skill.scripts.length })}</Text>
        ) : null}
      </DetailCard>

      <DetailCard title={t('toolsScreen.instructions')} action={<Pressable onPress={() => onViewAll(skill)} accessibilityRole="button" style={[s.small, { borderColor: tokens.border }]}><Text style={{ fontSize: 12.5, fontWeight: '500', color: tokens.foreground }}>{t('toolsScreen.seeAll')}</Text></Pressable>}>
        <View style={[s.code, { borderColor: tokens.border, backgroundColor: tokens.background }]}>
          <Text numberOfLines={8} style={{ fontSize: 12, lineHeight: 19, fontFamily: 'Menlo', color: tokens.mutedForeground }}>
            {preview}
          </Text>
        </View>
      </DetailCard>

      {builtin ? (
        <Text style={{ fontSize: 12, lineHeight: 17, color: tokens.mutedForeground, paddingHorizontal: 2 }}>{t('toolsScreen.builtinNote')}</Text>
      ) : (
        <View style={s.actions}>
          <ActionButton icon={Pencil} label={t('toolsScreen.edit')} onPress={() => onEdit(skill)} />
          <ActionButton destructive icon={Trash2} label={t('toolsScreen.delete')} onPress={() => onDelete(skill.slug)} />
        </View>
      )}
    </ScrollView>
  )
}

const s = StyleSheet.create({
  notice: { padding: 12, borderWidth: 1, borderRadius: 12 },
  tool: { paddingVertical: 10, fontSize: 12.5, fontFamily: 'Menlo' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  action: { flexGrow: 1, flexBasis: '45%', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, minHeight: 48, paddingHorizontal: 10, borderWidth: 1, borderRadius: 12 },
  small: { height: 34, paddingHorizontal: 12, borderWidth: 1, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  code: { padding: 12, borderWidth: 1, borderRadius: 12 },
})
