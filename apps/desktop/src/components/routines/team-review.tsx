import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Bot, ChevronDownIcon, ShieldCheckIcon } from "lucide-react"
import type { TeamMember } from "@shared/routines"
import { cn } from "@/lib/utils"
import { Switch } from "@/components/ui/switch"
import { agentView } from "@/src/components/agent-meta"
import { ModelPicker } from "@/src/components/model-picker"
import { useAgents } from "@/src/stores/agents-store"
import { waitsFor, type AgentsDraft } from "@/src/lib/agents-draft"
import { useProviderStore, type SelectedModel } from "@/src/stores/provider-store"

/**
 * The team of a routine the chat proposed, read-only: who is in it and what each one does.
 *
 * The only thing chosen here is the model each member runs on — the team itself came from the
 * proposal, and changing it is a conversation with the chat, not a form. A routine created by
 * hand gets the editor instead.
 */
export function TeamReview({ value, onChange, model }: {
  value: AgentsDraft
  onChange: (next: AgentsDraft) => void
  /** The routine's model — what a member with no model of its own runs on. */
  model: SelectedModel | null
}) {
  const { t } = useTranslation()
  const agents = useAgents()
  const patch = (id: string, change: Partial<TeamMember>) =>
    onChange({ ...value, members: value.members.map((m) => (m.id === id ? { ...m, ...change } : m)) })

  return (
    <>
      {value.members.map((member, index) => {
        const view = agentView(member.agent ?? "general", agents, t)
        const Icon = view?.icon ?? Bot
        const waits = waitsFor(member, value.members, t("routines.agents.unnamed"))
        return (
          <div key={member.id} className={cn("flex items-center gap-2.5 px-3 py-2", index > 0 && "border-t")}>
            <span className="grid size-7 shrink-0 place-items-center rounded-lg border bg-muted/40">
              <Icon className={cn("size-3.5", view?.color ?? "text-muted-foreground")} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold">{member.name.trim() || t("routines.agents.unnamed")}</p>
              <p className="truncate text-[10.5px] text-muted-foreground">
                {member.task.trim()}
                {waits.length > 0 && ` · ${t("routines.agents.stageAfter", { names: waits.join(", ") })}`}
              </p>
            </div>
            <ModelChip
              value={member.model ?? null}
              inherited={model}
              onValueChange={(next) => patch(member.id, { model: next })}
            />
          </div>
        )
      })}
    </>
  )
}

/**
 * The reviewer as the last row of the team: what it does, the model it runs on and the switch.
 *
 * It has no model of its own — it runs on the routine's, which is why the chip here only shows it.
 */
export function ReviewerRow({ review, onChange, model, border = true }: {
  review: boolean
  onChange: (review: boolean) => void
  model: SelectedModel | null
  /** A separator on top; off when the row opens a card of its own. */
  border?: boolean
}) {
  const { t } = useTranslation()
  const catalog = useProviderStore((s) => s.catalog)
  const modelName = model ? catalog[model.providerId]?.models[model.modelId]?.name : undefined
  return (
    <div className={cn("flex items-center gap-2.5 px-3 py-2", border && "border-t")}>
      <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-primary/40 bg-primary/10">
        <ShieldCheckIcon className="size-3.5 text-primary" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-xs font-semibold">
          {t("routines.agents.reviewTitle")}
          <span
            className={cn(
              "rounded border px-1 text-[9.5px] font-semibold uppercase tracking-wide",
              review ? "border-primary/40 bg-primary/10 text-primary" : "text-muted-foreground",
            )}
          >
            {review ? t("routines.agents.reviewOn") : t("routines.agents.reviewOff")}
          </span>
        </p>
        <p className="truncate text-[10.5px] text-muted-foreground">{t("routines.agents.reviewRole")}</p>
      </div>
      {modelName && (
        <span
          className="shrink-0 rounded-md border bg-background/50 px-2 py-1 text-[10.5px] text-muted-foreground"
          title={t("routines.agents.reviewModel")}
        >
          {modelName}
        </span>
      )}
      <Switch checked={review} onCheckedChange={onChange} aria-label={t("routines.agents.reviewTitle")} />
    </div>
  )
}

/**
 * A model, as the small chip of the design: the member's own, or "Inherits · <the routine's>".
 * The chip opens the real selector — hidden, because its trigger is this chip.
 */
function ModelChip({ value, inherited, onValueChange }: {
  value: SelectedModel | null
  inherited: SelectedModel | null
  onValueChange: (model: { providerId: string; modelId: string } | undefined) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const catalog = useProviderStore((s) => s.catalog)
  const nameOf = (m: SelectedModel | null) => (m ? catalog[m.providerId]?.models[m.modelId]?.name : undefined)
  const own = nameOf(value)
  const fallback = nameOf(inherited)
  const label = own ?? (fallback ? `${t("routines.agents.inherits")} · ${fallback}` : t("routines.agents.inherits"))

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border bg-background/50 px-2 text-[10.5px] text-foreground transition-colors hover:bg-background/80"
        title={t("routines.agents.modelOfMember")}
      >
        <span className="max-w-40 truncate">{label}</span>
        <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
      </button>
      <ModelPicker
        hideTrigger
        open={open}
        onOpenChange={setOpen}
        value={value}
        onValueChange={(next) => onValueChange(next ? { providerId: next.providerId, modelId: next.modelId } : undefined)}
        nullLabel={t("routines.agents.inherits")}
      />
    </>
  )
}
