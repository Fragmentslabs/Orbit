import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Bot } from "lucide-react"
import { emptyAgentInput, type AgentInput } from "@shared/agents"
import type { ToolPart } from "@shared/chat"
import { Shimmer } from "@/src/components/ai/shimmer"
import { AGENT_ICON_COMPONENTS } from "@/src/components/agent-meta"
import { ProposalCard, type ProposalFact } from "@/src/components/proposal-card"
import { AgentEditorDialog } from "@/src/components/specialists/agent-editor-dialog"
import { agentsApi } from "@/src/lib/ipc"
import { useAgents } from "@/src/stores/agents-store"

/**
 * Card of the agent proposal (tool create_agent). Nothing was saved when the tool ran: the
 * agent exists once the person clicks "Add agent". The whole prompt is shown, because a prompt
 * speaks to the model with system authority and the person has to be able to read it first.
 */

/** The tool's input as an agent draft (the main process validates it again on save). */
function draftOf(part: ToolPart): AgentInput {
  const raw = (part.input ?? {}) as Partial<AgentInput>
  const base = emptyAgentInput()
  return {
    ...base,
    name: String(raw.name ?? ""),
    icon: raw.icon ?? base.icon,
    prompt: String(raw.prompt ?? ""),
    whenToUse: String(raw.whenToUse ?? ""),
    pinnedSkills: Array.isArray(raw.pinnedSkills) ? raw.pinnedSkills : [],
    craft: raw.craft,
    features: { ...base.features, ...raw.features },
  }
}

export function AgentProposalCard({ part }: { part: ToolPart }) {
  const { t } = useTranslation()
  const agents = useAgents()
  const [busy, setBusy] = useState(false)
  const [discarded, setDiscarded] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [error, setError] = useState("")

  if (part.state === "running") return <Shimmer className="text-sm">{t("agentProposal.building")}</Shimmer>
  if (part.state === "error") return null

  const draft = draftOf(part)
  if (!draft.name) return null
  const Icon = AGENT_ICON_COMPONENTS[draft.icon] ?? Bot
  // Added = an agent with this name and prompt exists (the card survives a restart this way).
  const added = agents.some((a) => a.name === draft.name && a.prompt === draft.prompt)
  const state = added ? "created" : discarded ? "discarded" : "pending"

  const add = async () => {
    setBusy(true)
    setError("")
    try {
      const result = await agentsApi.save(draft)
      if (!result.ok) setError(t(`specialists.error.${result.reason}`))
    } finally {
      setBusy(false)
    }
  }

  const facts: ProposalFact[] = []
  if (draft.whenToUse) facts.push({ label: t("proposal.whenToUse"), value: draft.whenToUse })
  if (draft.pinnedSkills.length > 0) facts.push({ label: t("proposal.pinnedSkills"), value: draft.pinnedSkills.map((s) => `@${s}`).join(", ") })
  facts.push({ label: t("proposal.weight"), value: t("proposal.weightValue", { tokens: Math.round(draft.prompt.length / 4) }) })

  return (
    <>
      <ProposalCard
        icon={Icon}
        kind={t("proposal.kind.agent")}
        state={state}
        title={draft.name}
        facts={facts}
        // A prompt speaks to the model with system authority: the person must be able to read it first.
        note={t("proposal.agentNote")}
        confirmLabel={t("agentProposal.add")}
        onConfirm={() => void add()}
        onDiscard={() => setDiscarded(true)}
        onDetails={() => setDetailsOpen(true)}
        busy={busy}
        error={error}
      >
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">{t("agentProposal.prompt")}</summary>
          <pre className="mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-2 font-mono text-[11px]">
            {draft.prompt}
          </pre>
        </details>
      </ProposalCard>
      {detailsOpen && <AgentEditorDialog agent={null} draft={draft} open onOpenChange={setDetailsOpen} />}
    </>
  )
}
