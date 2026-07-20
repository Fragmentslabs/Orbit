import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { Sparkles, Check, X } from 'lucide-react-native'
import { useToolsStore } from '~/stores/tools-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import type { ToolPart } from '@orbit/shared'

interface SkillProposalCardProps {
  part: ToolPart
}

/**
 * Card de proposta de skill (tool create_skill) exibido inline na mensagem.
 * Espelha o SkillProposalCard do desktop.
 */
export function SkillProposalCard({ part }: SkillProposalCardProps) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const pending = useToolsStore((s) => s.pending)
  const skills = useToolsStore((s) => s.skills)
  const approveSkill = useToolsStore((s) => s.approveSkill)
  const discardSkill = useToolsStore((s) => s.discardSkill)

  const slug =
    (part.output as string)?.trim() ??
    ((part.input as { slug?: string })?.slug ?? '').trim()
  const isRunning = part.state === 'running'
  const installed = skills.some((s) => s.slug === slug)
  const proposal = pending.find((p) => p.slug === slug)

  if (isRunning) {
    return (
      <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
        <ActivityIndicator size="small" color={tokens.primary} />
        <Text style={[s.statusText, { color: tokens.mutedForeground }]}>Montando a skill…</Text>
      </View>
    )
  }

  if (installed) {
    return (
      <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
        <View style={[s.iconWrap, { backgroundColor: 'rgba(34,197,94,0.12)' }]}>
          <Check size={16} color="#22c55e" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[s.title, { color: tokens.foreground }]}>Skill adicionada</Text>
          <Text style={[s.slug, { color: tokens.mutedForeground }]}>Disponível como @{slug}</Text>
        </View>
      </View>
    )
  }

  if (!proposal) {
    return (
      <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
        <View style={[s.iconWrap, { backgroundColor: tokens.muted }]}>
          <X size={16} color={tokens.mutedForeground} />
        </View>
        <Text style={[s.statusText, { color: tokens.mutedForeground }]}>Proposta dispensada.</Text>
      </View>
    )
  }

  return (
    <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
      <View style={s.row}>
        <View style={[s.iconWrap, { backgroundColor: 'rgba(99,102,241,0.12)' }]}>
          <Sparkles size={16} color="#818cf8" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[s.title, { color: tokens.foreground }]}>{proposal.name}</Text>
          {proposal.description && (
            <Text style={[s.desc, { color: tokens.mutedForeground }]} numberOfLines={2}>{proposal.description}</Text>
          )}
          <Text style={[s.slug, { color: tokens.mutedForeground }]}>@{proposal.slug}</Text>
        </View>
      </View>
      {proposal.files && proposal.files.length > 0 && (
        <Text style={[s.files, { color: tokens.mutedForeground }]}>
          {proposal.files.length} {proposal.files.length === 1 ? 'arquivo adicional' : 'arquivos adicionais'}
        </Text>
      )}
      <View style={[s.actions, { borderTopColor: tokens.border }]}>
        <Pressable onPress={() => void discardSkill(proposal.slug)} style={[s.btn, { borderColor: tokens.border }]}>
          <Text style={[s.btnText, { color: tokens.foreground }]}>Dispensar</Text>
        </Pressable>
        <Pressable onPress={() => void approveSkill(proposal.slug)} style={[s.btn, { backgroundColor: tokens.primary }]}>
          <Text style={[s.btnText, { color: '#fff' }]}>Adicionar skill</Text>
        </Pressable>
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  card: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    gap: 8,
    marginVertical: 4,
  },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontSize: 14, fontWeight: '600' },
  desc: { fontSize: 12, lineHeight: 16, marginTop: 2 },
  slug: { fontSize: 11, fontFamily: 'monospace', marginTop: 2 },
  files: { fontSize: 11, paddingLeft: 42 },
  statusText: { fontSize: 13, color: '#6b7280' },
  actions: {
    flexDirection: 'row',
    gap: 8,
    paddingTop: 10,
    borderTopWidth: 1,
  },
  btn: {
    flex: 1,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'transparent',
    paddingVertical: 8,
    alignItems: 'center',
  },
  btnText: { fontSize: 12, fontWeight: '600' },
})
