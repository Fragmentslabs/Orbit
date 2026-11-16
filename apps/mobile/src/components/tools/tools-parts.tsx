import { memo, type ReactNode } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native'
import { Cable, ChevronRight, Sparkles } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { McpServerStatus, Skill, SkillProposal } from '@orbit/shared'
import { BottomSheet } from '~/components/ui/bottom-sheet'
import { useToolsStore } from '~/stores/tools-store'
import { ListRow, StatePill, StateTile, tint, useTokens, type RowState } from '~/components/list/parts'

/**
 * OAuth server that still depends on the user: it was never authorized on the desktop or the
 * server went back to asking for authorization. Connected/disabled have nothing to authorize.
 */
export function needsAuth(server: McpServerStatus): boolean {
  if (!server.usesOAuth) return false
  if (server.state === 'connected' || server.state === 'disabled') return false
  return !server.authorized || server.state === 'unauthorized'
}

/** What the tile and the pill of a server say: what needs the user's eyes first. */
export function serverTone(server: McpServerStatus): { tone: RowState; label: 'connected' | 'connecting' | 'error' | 'disabled' | 'authorize' } {
  if (needsAuth(server)) return { tone: 'warn', label: 'authorize' }
  switch (server.state) {
    case 'connected':
      return { tone: 'ok', label: 'connected' }
    case 'connecting':
      return { tone: 'run', label: 'connecting' }
    case 'error':
      return { tone: 'bad', label: 'error' }
    case 'unauthorized':
      return { tone: 'warn', label: 'authorize' }
    default:
      return { tone: 'idle', label: 'disabled' }
  }
}

export function useServerLabel() {
  const { t } = useTranslation()
  return (label: ReturnType<typeof serverTone>['label']) =>
    ({
      connected: t('toolsScreen.stateConnected'),
      connecting: t('toolsScreen.stateConnecting'),
      error: t('toolsScreen.stateError'),
      disabled: t('toolsScreen.stateDisabled'),
      authorize: t('toolsScreen.pillAuthorize'),
    })[label]
}

/** One MCP server as a row — the same anatomy as the lists of Routines and Pipelines. */
export const ServerRow = memo(function ServerRow({ server, onOpen }: { server: McpServerStatus; onOpen: () => void }) {
  const { t } = useTranslation()
  const labelOf = useServerLabel()
  const { tone, label } = serverTone(server)
  const type = server.config.type
  const meta =
    tone === 'bad' && server.error
      ? `${type} · ${server.error}`
      : label === 'authorize'
        ? t('toolsScreen.serverMetaAuth', { type })
        : t('toolsScreen.serverMetaTools', { type, count: server.toolNames.length })
  return (
    <ListRow
      onPress={onOpen}
      title={server.config.name}
      tile={<StateTile state={tone} icon={Cable} spinning={tone === 'run'} />}
      lines={[{ text: meta, bad: tone === 'bad' }]}
      right={<StatePill state={tone} label={labelOf(label)} />}
    />
  )
})

/** One skill as a row. */
export const SkillRow = memo(function SkillRow({ skill, onOpen }: { skill: Skill; onOpen: () => void }) {
  const { t } = useTranslation()
  const tag =
    skill.source === 'builtin'
      ? t('toolsScreen.pillBuiltin')
      : skill.scripts && skill.scripts.length > 0
        ? t('toolsScreen.scriptsCount', { count: skill.scripts.length })
        : skill.source === 'global'
          ? t('toolsScreen.global')
          : t('toolsScreen.project')
  return (
    <ListRow
      onPress={onOpen}
      title={`@${skill.slug}`}
      tile={<StateTile state="idle" icon={Sparkles} />}
      lines={[...(skill.description ? [{ text: skill.description }] : []), { text: skill.name, quiet: true }]}
      right={<StatePill state="idle" label={tag} />}
    />
  )
})

/** The filter of the skills (all, mine, built-in) — chips with their counts. */
export function FilterChips<K extends string>({ items, value, onChange }: { items: { key: K; label: string; count: number }[]; value: K; onChange: (key: K) => void }) {
  const tokens = useTokens()
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={s.chips}>
      {items.map((item) => {
        const on = item.key === value
        return (
          <Pressable
            key={item.key}
            onPress={() => onChange(item.key)}
            accessibilityState={{ selected: on }}
            style={[s.chip, { borderColor: on ? tokens.muted : tokens.border }, on && { backgroundColor: tokens.muted }]}
          >
            <Text style={{ fontSize: 13.5, fontWeight: on ? '500' : '400', color: on ? tokens.foreground : tokens.mutedForeground }}>
              {item.label} <Text style={{ fontSize: 12, opacity: 0.8 }}>{item.count}</Text>
            </Text>
          </Pressable>
        )
      })}
    </ScrollView>
  )
}

/** "N skills proposed by Orbit" — the way into the proposals, like the memories' banner. */
export function ProposalsBanner({ count, first, onOpen }: { count: number; first?: SkillProposal; onOpen: () => void }) {
  const { t } = useTranslation()
  const tokens = useTokens()
  return (
    <Pressable onPress={onOpen} accessibilityRole="button" style={[s.banner, { borderColor: tokens.primary, backgroundColor: tint(tokens.primary, '26') }]}>
      <View style={[s.bannerTile, { backgroundColor: tokens.primary }]}>
        <Sparkles size={17} color={tokens.primaryForeground} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: 14, fontWeight: '600', color: tokens.foreground }}>
          {t('toolsScreen.proposalsBanner', { count })}
        </Text>
        {first ? (
          <Text numberOfLines={1} style={{ fontSize: 12, color: tokens.mutedForeground }}>
            @{first.slug}
            {first.description ? ` · ${first.description}` : ''}
          </Text>
        ) : null}
      </View>
      <ChevronRight size={16} color={tokens.mutedForeground} />
    </Pressable>
  )
}

/** The proposals, one card each, with the choice to add or dismiss. */
export function ProposalsSheet({ open, proposals, onClose }: { open: boolean; proposals: SkillProposal[]; onClose: () => void }) {
  const { t } = useTranslation()
  const tokens = useTokens()
  const approve = useToolsStore((st) => st.approveSkill)
  const discard = useToolsStore((st) => st.discardSkill)
  return (
    <BottomSheet open={open} onClose={onClose} title={<Text style={{ fontSize: 17, fontWeight: '600', color: tokens.foreground, paddingVertical: 8 }}>{t('toolsScreen.proposalsSheet')}</Text>}>
      <ScrollView style={{ maxHeight: 520 }} contentContainerStyle={{ gap: 10, paddingBottom: 8 }}>
        {proposals.map((proposal) => (
          <ProposalCard key={proposal.slug} proposal={proposal} onApprove={() => void approve(proposal.slug)} onDismiss={() => void discard(proposal.slug)} />
        ))}
      </ScrollView>
    </BottomSheet>
  )
}

function ProposalCard({ proposal, onApprove, onDismiss }: { proposal: SkillProposal; onApprove: () => void; onDismiss: () => void }) {
  const { t } = useTranslation()
  const tokens = useTokens()
  return (
    <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.background }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Sparkles size={14} color={tokens.primary} />
        <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, fontWeight: '600', color: tokens.foreground }}>
          {proposal.name}
        </Text>
      </View>
      {proposal.description ? (
        <Text numberOfLines={2} style={{ fontSize: 12.5, lineHeight: 18, color: tokens.mutedForeground }}>
          {proposal.description}
        </Text>
      ) : null}
      <Text style={{ fontSize: 11.5, color: tokens.mutedForeground }}>
        @{proposal.slug}
        {proposal.files && proposal.files.length > 0 ? ` · ${t('toolsScreen.extraFiles', { count: proposal.files.length })}` : ''}
      </Text>
      <View style={{ flexDirection: 'row', gap: 8, paddingTop: 4 }}>
        <Pressable onPress={onDismiss} accessibilityRole="button" style={[s.btn, { borderColor: tokens.border }]}>
          <Text style={{ fontSize: 13.5, fontWeight: '500', color: tokens.foreground }}>{t('toolsScreen.dismiss')}</Text>
        </Pressable>
        <Pressable onPress={onApprove} accessibilityRole="button" style={[s.btn, { borderColor: tokens.primary, backgroundColor: tokens.primary }]}>
          <Text style={{ fontSize: 13.5, fontWeight: '600', color: tokens.primaryForeground }}>{t('toolsScreen.addSkill')}</Text>
        </Pressable>
      </View>
    </View>
  )
}

/** A card of the detail screens. */
export function DetailCard({ title, action, children }: { title?: string; action?: ReactNode; children: ReactNode }) {
  const tokens = useTokens()
  return (
    <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
      {title || action ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          {title ? <Text style={{ fontSize: 14.5, fontWeight: '600', color: tokens.foreground }}>{title}</Text> : <View />}
          {action}
        </View>
      ) : null}
      {children}
    </View>
  )
}

/** Label on the left, value on the right. */
export function KeyValue({ label, value, mono, last }: { label: string; value: string; mono?: boolean; last?: boolean }) {
  const tokens = useTokens()
  return (
    <View style={[s.kv, !last && { borderBottomWidth: 1, borderBottomColor: tokens.border }]}>
      <Text style={{ fontSize: 13, color: tokens.mutedForeground }}>{label}</Text>
      <Text numberOfLines={1} style={{ flex: 1, textAlign: 'right', fontSize: mono ? 12 : 13, fontFamily: mono ? 'Menlo' : undefined, color: tokens.foreground }}>
        {value}
      </Text>
    </View>
  )
}

const s = StyleSheet.create({
  chips: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 4 },
  chip: { height: 40, paddingHorizontal: 13, borderWidth: 1, borderRadius: 99, alignItems: 'center', justifyContent: 'center' },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 16, marginTop: 10, padding: 12, borderWidth: 1, borderRadius: 14 },
  bannerTile: { width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  card: { gap: 8, padding: 14, borderWidth: 1, borderRadius: 16 },
  btn: { flex: 1, minHeight: 44, borderWidth: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  kv: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 42 },
})
