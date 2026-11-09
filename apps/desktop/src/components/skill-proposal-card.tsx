import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { Sparkles } from "lucide-react"
import type { ToolPart } from "@shared/chat"
import { Shimmer } from "@/src/components/ai/shimmer"
import { ProposalCard, type ProposalFact } from "@/src/components/proposal-card"
import { useSkillsStore } from "@/src/stores/skills-store"

/**
 * Card of the skill proposal (tool create_skill): the skill stays in staging until
 * the user clicks "Add skill". State derived from the skills-store —
 * pending → buttons; approved → check; dismissed → note.
 */

function slugOf(part: ToolPart): string | null {
  // The tool output confirms the sanitized slug ("Skill @<slug> proposed…")
  const fromOutput = part.output?.match(/@([a-z0-9_]+)/)?.[1]
  if (fromOutput) return fromOutput
  const raw = (part.input?.slug ?? part.input?.name) as string | undefined
  return raw ? raw.toLowerCase().replace(/[^a-z0-9_]+/g, "_") : null
}

export function SkillProposalCard({ part }: { part: ToolPart }) {
  const { t } = useTranslation()
  const initialize = useSkillsStore((s) => s.initialize)
  const refresh = useSkillsStore((s) => s.refresh)
  const pending = useSkillsStore((s) => s.pending)
  const skills = useSkillsStore((s) => s.skills)
  const discarded = useSkillsStore((s) => s.discarded)
  const approve = useSkillsStore((s) => s.approve)
  const discard = useSkillsStore((s) => s.discard)

  useEffect(() => {
    void initialize()
  }, [initialize])

  // The proposal is staged DURING the tool execution; when it ends,
  // it re-syncs with the disk without depending on the skills:changed event.
  useEffect(() => {
    if (part.state === "done") void refresh()
  }, [part.state, refresh])

  if (part.state === "running") {
    return <Shimmer className="text-sm">{t("skillProposal.building")}</Shimmer>
  }
  if (part.state === "error") return null

  const slug = slugOf(part)
  if (!slug) return null

  const proposal = pending.find((p) => p.slug === slug)
  const installed = skills.some((s) => s.slug === slug)
  const wasDiscarded = discarded.includes(slug)
  // Buttons whenever the skill is not installed and the user did not refuse it —
  // "dismissed" only appears with a real refusal recorded in the store.
  const actionable = !installed && (proposal !== undefined || !wasDiscarded)
  const name = (part.input?.name as string) ?? proposal?.name ?? slug
  const description = (part.input?.description as string) ?? proposal?.description ?? ""
  const files = proposal?.files ?? (part.input?.files as Array<{ path: string }> | undefined)?.map((f) => f.path) ?? []

  const state = installed ? "created" : actionable ? "pending" : "discarded"
  const facts: ProposalFact[] = []
  if (description) facts.push({ label: t("proposal.whenToUse"), value: description })
  facts.push({ label: t("proposal.invoke"), value: `@${slug}`, mono: true })
  if (files.length > 0) facts.push({ label: t("proposal.files"), value: files.join(", "), mono: true })

  return (
    <ProposalCard
      icon={Sparkles}
      kind={t("proposal.kind.skill")}
      state={state}
      title={name}
      facts={facts}
      note={files.length > 0 ? t("proposal.skillScriptsNote") : undefined}
      confirmLabel={t("skillProposal.add")}
      onConfirm={() => void approve(slug)}
      onDiscard={() => void discard(slug)}
    />
  )
}
