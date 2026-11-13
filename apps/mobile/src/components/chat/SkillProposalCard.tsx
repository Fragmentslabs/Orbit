import { useEffect } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { Sparkles } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { SkillProposal, ToolPart } from '@orbit/shared'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { useToolsStore } from '~/stores/tools-store'
import { ProposalAction, ProposalCard } from './ProposalCard'

interface SkillProposalCardProps {
  part: ToolPart
}

/**
 * Same rule as the desktop: the output of the tool confirms the sanitized slug
 * ("Skill @<slug> proposed…"); never use the whole output as the slug.
 */
function slugOf(part: ToolPart): string | null {
  const fromOutput = (part.output as string)?.match(/@([a-z0-9_]+)/)?.[1]
  if (fromOutput) return fromOutput
  const input = part.input as { slug?: string; name?: string } | undefined
  const raw = input?.slug ?? input?.name
  return raw ? raw.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_') : null
}

/**
 * Inline card of the skill proposal (tool create_skill). Same anatomy as the
 * desktop ProposalCard: kind, state badge, labelled facts and a footer of
 * actions — the state is the badge, not a different card.
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

  // Re-syncs with the companion on every card that mounts: the proposal was
  // staged during the execution of the tool and may not be in the local cache.
  useEffect(() => {
    void fetchSkills()
    void fetchPending()
  }, [fetchSkills, fetchPending])

  if (part.state === 'running') {
    return (
      <View style={[s.wrap, s.loading, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
        <ActivityIndicator size="small" color={tokens.primary} />
        <Text style={[s.loadingText, { color: tokens.mutedForeground }]}>{t('skillProposal.building')}</Text>
      </View>
    )
  }

  const slug = slugOf(part)
  if (part.state === 'error' || !slug) return null

  const installed = skills.some((sk) => sk.slug === slug)
  const proposal = pending.find((p) => p.slug === slug)
  // Without the proposal in the store, it uses the data of the tool part itself to keep
  // the buttons visible until the synchronization arrives.
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

  const badge = installed
    ? { label: t('skillProposal.added'), tone: 'success' as const }
    : wasDiscarded && !actionable
      ? { label: t('proposalCard.discarded') }
      : { label: t('proposalCard.pending') }

  const facts = [
    { label: t('proposalCard.name'), value: `@${data.slug}`, mono: true },
    ...(data.description ? [{ label: t('proposalCard.description'), value: data.description }] : []),
    ...(data.files?.length ? [{ label: t('proposalCard.files'), value: String(data.files.length) }] : []),
  ]

  return (
    <View style={s.wrap}>
      <ProposalCard
        icon={<Sparkles size={16} color={tokens.mutedForeground} />}
        kind={t('proposalCard.skill')}
        title={data.name}
        badge={badge}
        facts={facts}
        note={installed ? t('skillProposal.availableAs', { slug }) : undefined}
        actions={
          actionable ? (
            <>
              <ProposalAction
                label={t('skillProposal.dismiss')}
                variant="ghost"
                onPress={() => void discardSkill(data.slug)}
              />
              <ProposalAction
                label={t('skillProposal.addSkill')}
                variant="primary"
                onPress={() => void approveSkill(data.slug)}
              />
            </>
          ) : undefined
        }
      />
    </View>
  )
}

const s = StyleSheet.create({
  wrap: { marginVertical: 4 },
  loading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
  },
  loadingText: { fontSize: 13 },
})
