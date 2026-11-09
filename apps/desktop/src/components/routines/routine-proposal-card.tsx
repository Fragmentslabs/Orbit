import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { CalendarClock } from "lucide-react"
import { Shimmer } from "@/src/components/ai/shimmer"
import { ProposalCard, type ProposalFact } from "@/src/components/proposal-card"
import { describeWhen } from "@/src/components/routines/schedule"
import { ScriptCard } from "./script-card"
import { routineModeFor } from "@shared/routines"
import type { MessagePart, ToolPart } from "@shared/chat"
import { useRoutineProposalsStore } from "@/src/stores/routine-proposals-store"
import { useRoutinesStore } from "@/src/stores/routines-store"
import { CreateRoutineDialog } from "./create-routine-dialog"

/**
 * Routine proposal card (tool routines_manage, "create" action): the routine stays in staging
 * until the person confirms. It is the standard proposal card (see proposal-card.tsx); "See
 * details" opens the creation form already filled in with this proposal.
 *
 * Only the "create" parts become a card; the tool's other actions fall into the generic action
 * group (see isRoutineProposal in the message components).
 */

/** Is this the part that becomes a card: routines_manage with the "create" action. */
export function isRoutineProposal(part: MessagePart): boolean {
  if (part.type !== "tool" || part.tool !== "routines_manage") return false
  return part.input?.action === "create"
}

/** The tool output confirms the id ("Routine proposal created (id: ...)"). */
function proposalId(part: ToolPart): string | null {
  return part.output?.match(/id:\s*([a-zA-Z0-9_-]+)/)?.[1] ?? null
}

export function RoutineProposalCard({ part }: { part: ToolPart }) {
  const { t } = useTranslation()
  const load = useRoutineProposalsStore((s) => s.load)
  const pending = useRoutineProposalsStore((s) => s.pending)
  const discarded = useRoutineProposalsStore((s) => s.discarded)
  const approve = useRoutineProposalsStore((s) => s.approve)
  const discard = useRoutineProposalsStore((s) => s.discard)
  const routines = useRoutinesStore((s) => s.routines)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  if (part.state === "running") {
    return <Shimmer className="text-sm">{t("routineProposal.building")}</Shimmer>
  }
  if (part.state === "error") return null

  const id = proposalId(part)
  if (!id) return null

  const proposal = pending.find((p) => p.id === id)
  const created = routines.some((r) => r.id === id)
  const wasDiscarded = discarded.includes(id)
  // Pending while the proposal is still staged; "created" and "discarded" are states derived from
  // disk/the store.
  const state = created ? "created" : !wasDiscarded && proposal !== undefined ? "pending" : "discarded"

  const title = (part.input?.title as string | undefined) ?? proposal?.title ?? t("routineProposal.fallbackTitle")
  const schedule = proposal?.schedule ?? (part.input?.schedule as import("@shared/routines").Schedule | undefined)
  const folders = proposal?.folders ?? []
  const mode = proposal?.mode ?? routineModeFor(folders)
  const scripts = proposal?.scripts ?? []

  const facts: ProposalFact[] = []
  if (schedule) facts.push({ label: t("proposal.when"), value: describeWhen({ schedule, trigger: proposal?.trigger }, t) })
  const prompt = (part.input?.prompt as string | undefined) ?? proposal?.prompt
  if (prompt) facts.push({ label: t("proposal.whatItDoes"), value: <span className="line-clamp-3">{prompt}</span> })
  facts.push({
    label: t("proposal.folders"),
    value: folders.length > 0 ? folders.join(", ") : t("proposal.noFolder"),
  })

  const confirm = async () => {
    setBusy(true)
    try {
      await approve(id)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <ProposalCard
        icon={CalendarClock}
        kind={t("proposal.kind.routine")}
        state={state}
        title={title}
        facts={facts}
        note={scripts.length > 0 ? t("proposal.routineScriptNote") : mode === "code" ? t("proposal.routineCodeNote") : undefined}
        confirmLabel={t("routineProposal.create")}
        onConfirm={() => void confirm()}
        onDiscard={() => void discard(id)}
        onDetails={proposal ? () => setDetailsOpen(true) : undefined}
        busy={busy}
      >
        {scripts.length > 0 && (
          <div className="space-y-2">
            {scripts.map((script) => (
              <ScriptCard key={script.id} script={script} trigger={proposal?.trigger?.kind === "script" && proposal.trigger.scriptId === script.id} />
            ))}
          </div>
        )}
      </ProposalCard>
      {proposal && (
        <CreateRoutineDialog
          open={detailsOpen}
          onOpenChange={setDetailsOpen}
          defaultMode={proposal.mode}
          proposal={proposal}
        />
      )}
    </>
  )
}
