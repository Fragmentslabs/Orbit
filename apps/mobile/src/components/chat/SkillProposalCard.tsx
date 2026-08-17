import { useEffect } from 'react'
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { Sparkles, Check, X } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { useToolsStore } from '~/stores/tools-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import type { SkillProposal, ToolPart } from '@orbit/shared'

interface SkillProposalCardProps {
  part: ToolPart
}

/**
 * Mesma regra do desktop: o output da tool confirma o slug sanitizado
 * ("Skill @<slug> proposta…"); nunca usar o output inteiro como slug.
 */
function slugOf(part: ToolPart): string | null {
  const fromOutput = (part.output as string)?.match(/@([a-z0-9_]+)/)?.[1]
  if (fromOutput) return fromOutput
  const input = part.input as { slug?: string; name?: string } | undefined
  const raw = input?.slug ?? input?.name
  return raw ? raw.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_') : null
}

/**
 * Card de proposta de skill (tool create_skill) exibido inline na mensagem.
 * Espelha o SkillProposalCard do desktop: botões sempre que a skill não
 * está instalada e o usuário não recusou — "dispensada" só com recusa real.
 */
export function SkillProposalCard({ part }: SkillProposalCardProps) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const pending = useToolsStore((s) => s.pending)
  const skills = useToolsStore((s) => s.skills)
  const discarded = useToolsStore((s) => s.discarded)
  const approveSkill = useToolsStore((s) => s.approveSkill)
  const discardSkill = useToolsStore((s) => s.discardSkill)
  const fetchPending = useToolsStore((s) => s.fetchPending)
  const fetchSkills = useToolsStore((s) => s.fetchSkills)

  // Re-sincroniza com o companion a cada card que monta: a proposta foi
  // estagiada durante a execução da tool e pode não estar no cache local.
  useEffect(() => {
    void fetchSkills()
    void fetchPending()
  }, [fetchSkills, fetchPending])

  const isRunning = part.state === 'running'
  if (isRunning) {
    return (
      <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
        <ActivityIndicator size="small" color={tokens.primary} />
        <Text style={[s.statusText, { color: tokens.mutedForeground }]}>{t('skillProposal.building')}</Text>
      </View>
    )
  }

  const slug = slugOf(part)
  if (part.state === 'error' || !slug) return null

  const installed = skills.some((sk) => sk.slug === slug)
  const proposal = pending.find((p) => p.slug === slug)
  // Sem a proposta no store, usa os dados do próprio tool part para manter
  // os botões visíveis até a sincronização chegar.
  const data: SkillProposal =
    proposal ??
    ({
      slug,
      name: ((part.input as { name?: string } | undefined)?.name as string) ?? slug,
      description: ((part.input as { description?: string } | undefined)?.description as string) ?? '',
      content: '',
      files: (((part.input as { files?: { path: string }[] } | undefined)?.files as
        | { path: string }[]
        | undefined) ?? []
      ).map((f) => f.path),
    } satisfies SkillProposal)
  const wasDiscarded = discarded.includes(slug)
  const actionable = !installed && (proposal !== undefined || !wasDiscarded)

  if (installed) {
    return (
      <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
        <View style={[s.iconWrap, { backgroundColor: 'rgba(34,197,94,0.12)' }]}>
          <Check size={16} color="#22c55e" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[s.title, { color: tokens.foreground }]}>{t('skillProposal.added')}</Text>
          <Text style={[s.slug, { color: tokens.mutedForeground }]}>{t('skillProposal.availableAs', { slug })}</Text>
        </View>
      </View>
    )
  }

  if (!actionable) {
    return (
      <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
        <View style={[s.iconWrap, { backgroundColor: tokens.muted }]}>
          <X size={16} color={tokens.mutedForeground} />
        </View>
        <Text style={[s.statusText, { color: tokens.mutedForeground }]}>{t('skillProposal.dismissed')}</Text>
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
          <Text style={[s.title, { color: tokens.foreground }]}>{data.name}</Text>
          {data.description && (
            <Text style={[s.desc, { color: tokens.mutedForeground }]} numberOfLines={2}>{data.description}</Text>
          )}
          <Text style={[s.slug, { color: tokens.mutedForeground }]}>@{data.slug}</Text>
        </View>
      </View>
      {data.files && data.files.length > 0 && (
        <Text style={[s.files, { color: tokens.mutedForeground }]}>
          {t('skillProposal.extraFiles', { count: data.files.length })}
        </Text>
      )}
      <View style={[s.actions, { borderTopColor: tokens.border }]}>
        <Pressable onPress={() => void discardSkill(data.slug)} style={[s.btn, { borderColor: tokens.border }]}>
          <Text style={[s.btnText, { color: tokens.foreground }]}>{t('skillProposal.dismiss')}</Text>
        </Pressable>
        <Pressable onPress={() => void approveSkill(data.slug)} style={[s.btn, { backgroundColor: tokens.primary }]}>
          <Text style={[s.btnText, { color: '#fff' }]}>{t('skillProposal.addSkill')}</Text>
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
