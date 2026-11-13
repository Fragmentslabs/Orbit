import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { CalendarClock, Check, Loader2Icon, ShieldAlertIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Shimmer } from "@/src/components/ai/shimmer"
import { describeWhen } from "@/src/components/routines/schedule"
import { ScriptCard } from "./script-card"
import { userProfileId } from "@shared/agents"
import type { MessagePart, ToolPart } from "@shared/chat"
import { useWorkspace } from "@/lib/workspace-context"
import { useAgents } from "@/src/stores/agents-store"
import { ORPHAN_KEY, usePanelStore } from "@/src/stores/panel-store"
import { useRoutineProposalsStore } from "@/src/stores/routine-proposals-store"
import { useRoutinesStore } from "@/src/stores/routines-store"
import { useActiveSession } from "@/src/stores/session-store"
import { CreateRoutineDialog } from "./create-routine-dialog"

/**
 * Routine proposal card (tool routines_manage, "create" action): the routine stays in staging
 * until the person confirms. The card is a SUMMARY — what it does, when it runs, where it acts,
 * what it carries — never the whole payload: the rest lives behind "Review", which opens the
 * form already filled in.
 *
 * Once decided the card collapses into a single line (created or discarded), so a long chat does
 * not keep a wall of cards. The scripts are the exception: they stay visible while the proposal
 * is pending, because confirming approves exactly that code.
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
  const agents = useAgents()
  const { mode: workspaceMode } = useWorkspace()
  const panelKey = useActiveSession(workspaceMode)?.id ?? ORPHAN_KEY
  const openRoutineTab = usePanelStore((s) => s.openRoutineTab)
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
  const scripts = proposal?.scripts ?? []
  const agentName = proposal?.agent ? agents.find((a) => userProfileId(a.id) === proposal.agent)?.name : undefined

  const prompt = (part.input?.prompt as string | undefined) ?? proposal?.prompt
  const when = schedule ? describeWhen({ schedule, trigger: proposal?.trigger }, t) : undefined
  const folderNames = folders.map((f) => f.split(/[\\/]/).filter(Boolean).pop() ?? f)

  // "What it carries": the specialists (or the single agent) and the scripts, never the model.
  const carries: string[] = []
  const teamCount = proposal?.team?.members.length ?? 0
  if (teamCount > 0) carries.push(t("routineProposal.specialists", { count: teamCount }))
  else if (agentName) carries.push(agentName)
  if (scripts.length > 0) carries.push(t("routineProposal.scripts", { count: scripts.length }))

  const note =
    proposal?.trigger?.kind === "webhook"
      ? t("proposal.routineWebhookNote")
      : scripts.length > 0
        ? t("proposal.routineScriptNote")
        : folders.length > 0
          ? t("proposal.routineCodeNote")
          : undefined

  const confirm = async () => {
    setBusy(true)
    try {
      await approve(id)
    } finally {
      setBusy(false)
    }
  }

  // Decided: one line in the history, instead of a card that keeps coming back.
  if (state === "created") {
    return (
      <div className="not-prose my-2 flex w-full items-center gap-2.5 rounded-xl border bg-card px-3.5 py-2.5 text-xs">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
          <Check className="size-3" strokeWidth={3} />
        </span>
        <span className="shrink-0 font-medium">{t("routineProposal.createdLine")}</span>
        <span className="min-w-0 truncate text-muted-foreground">{title}</span>
        <button
          type="button"
          onClick={() => openRoutineTab(panelKey, { routineId: id, title })}
          className="ml-auto shrink-0 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {t("routineProposal.open")}
        </button>
      </div>
    )
  }
  if (state === "discarded") {
    return (
      <div className="not-prose my-2 flex w-full items-center gap-2 rounded-xl border border-dashed px-3.5 py-2 text-xs text-muted-foreground">
        <span className="truncate">
          {t("routineProposal.discardedLine")} · {title}
        </span>
      </div>
    )
  }

  return (
    <>
      <div className="not-prose my-2 w-full overflow-hidden rounded-xl border bg-card shadow-sm">
        <div className="flex items-center gap-2.5 border-b px-3.5 py-2.5">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <CalendarClock className="size-3.5" />
          </span>
          <span className="flex-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("proposal.kind.routine")}
          </span>
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
            {t("proposal.state.pending")}
          </span>
        </div>

        <div className="flex flex-col gap-1.5 px-3.5 py-3">
          <p className="text-sm font-semibold">{title}</p>
          {prompt && <p className="line-clamp-1 text-xs text-muted-foreground">{prompt}</p>}
          <dl className="mt-1 flex flex-col text-xs">
            <FactRow label={t("proposal.when")} value={when ?? t("routineProposal.notSet")} />
            <FactRow
              label={t("routineProposal.where")}
              value={folderNames.length > 0 ? folderNames.join(", ") : t("proposal.noFolder")}
            />
            {carries.length > 0 && <FactRow label={t("routineProposal.carries")} value={carries.join(" · ")} />}
          </dl>
          {scripts.length > 0 && (
            <div className="mt-1 space-y-2">
              {scripts.map((script) => (
                <ScriptCard
                  key={script.id}
                  script={script}
                  trigger={proposal?.trigger?.kind === "script" && proposal.trigger.scriptId === script.id}
                />
              ))}
            </div>
          )}
          {note && (
            <p className="mt-1 flex items-start gap-2 rounded-lg border border-dashed px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
              <ShieldAlertIcon className="mt-0.5 size-3.5 shrink-0" />
              <span>{note}</span>
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t bg-muted/30 px-3.5 py-2.5">
          <Button size="sm" variant="ghost" onClick={() => void discard(id)} disabled={busy}>
            {t("proposal.discard")}
          </Button>
          {proposal && (
            <Button size="sm" variant="outline" onClick={() => setDetailsOpen(true)} disabled={busy}>
              {t("routineProposal.review")}
            </Button>
          )}
          <Button size="sm" onClick={() => void confirm()} disabled={busy}>
            {busy && <Loader2Icon className="size-3.5 animate-spin" />}
            {t("routineProposal.activate")}
          </Button>
        </div>
      </div>

      {proposal && (
        <CreateRoutineDialog
          open={detailsOpen}
          onOpenChange={setDetailsOpen}
          proposal={proposal}
        />
      )}
    </>
  )
}

/** One row of the summary: a short label and the resolved value, never a raw payload. */
function FactRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-3 border-t border-border/60 py-1.5 first:border-t-0 first:pt-0">
      <dt className="w-14 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">{value}</dd>
    </div>
  )
}
