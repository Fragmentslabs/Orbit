import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { CalendarClock, Check, MessageSquareIcon, TerminalIcon } from "lucide-react"
import type { Schedule } from "@shared/routines"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { MessagePart, ToolPart } from "@shared/chat"
import { Shimmer } from "@/src/components/ai/shimmer"
import { describeSchedule } from "@/src/components/routines/schedule"
import { useRoutineProposalsStore } from "@/src/stores/routine-proposals-store"
import { useRoutinesStore } from "@/src/stores/routines-store"

/**
 * Routine proposal card (tool routines_manage, "create" action): the routine
 * stays in staging until the person clicks "Create routine". Same pattern as
 * the SkillProposalCard — pending → buttons; created → check; discarded → note.
 *
 * Only the "create" parts become a card; the tool's other actions fall into the
 * generic action group (see isRoutineProposal in the message components).
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
  // Buttons while the proposal is pending; "created" and "discarded" are
  // states derived from disk/the store, as in the skill card.
  const actionable = !created && !wasDiscarded && proposal !== undefined

  const title = (part.input?.title as string | undefined) ?? proposal?.title ?? "Routine"
  const mode = (part.input?.mode as "chat" | "code" | undefined) ?? proposal?.mode ?? "code"
  const schedule = proposal?.schedule ?? (part.input?.schedule as Schedule | undefined)
  const scheduleText = schedule ? describeSchedule(schedule, t) : null

  return (
    <div className="not-prose my-2 flex w-full flex-col gap-2 rounded-lg border bg-card p-3">
      <div className="flex items-start gap-2">
        <CalendarClock className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{title}</span>
            <Badge
              variant="outline"
              className="inline-flex items-center gap-1 px-1.5 py-0 text-[10px] text-muted-foreground"
            >
              {mode === "chat" ? (
                <MessageSquareIcon className="size-3" />
              ) : (
                <TerminalIcon className="size-3" />
              )}
              {mode === "chat" ? t("routines.mode.chat") : t("routines.mode.code")}
            </Badge>
          </div>
          {scheduleText && <p className="mt-0.5 text-xs text-muted-foreground">{scheduleText}</p>}
        </div>
      </div>
      {created ? (
        <p className="flex items-center gap-1.5 text-xs text-emerald-500">
          <Check className="size-3.5" /> {t("routineProposal.created")}
        </p>
      ) : actionable ? (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => void discard(id)}>
            {t("routineProposal.discard")}
          </Button>
          <Button size="sm" className="gap-1.5" onClick={() => void approve(id)}>
            <CalendarClock className="size-3.5" />
            {t("routineProposal.create")}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t("routineProposal.discarded")}</p>
      )}
    </div>
  )
}
