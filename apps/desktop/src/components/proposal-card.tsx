import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Check, Loader2Icon, ShieldAlertIcon } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * The one card for everything a chat PROPOSES and the person confirms: a routine, an agent, a
 * skill, a hook, an MCP server. Same anatomy each time, so the person learns it once:
 *
 *   [icon] KIND                                   [state]
 *   Title
 *   label  value            (the facts that matter, not the whole payload)
 *   ┄ a note, only when confirming runs something on their behalf ┄
 *   [details]                       [discard] [confirm]
 *
 * It is presentational. Each kind keeps its own store/tool logic and passes what to show; the
 * card never decides whether something was created.
 */

export type ProposalState = "pending" | "created" | "discarded"

export interface ProposalFact {
  label: string
  value: ReactNode
  mono?: boolean
}

export function ProposalCard({
  icon: Icon,
  kind,
  state,
  title,
  facts,
  note,
  children,
  confirmLabel,
  onConfirm,
  onDiscard,
  onDetails,
  openLabel,
  onOpen,
  busy,
  error,
}: {
  icon: LucideIcon
  /** Translated kind label, e.g. "Routine". */
  kind: string
  state: ProposalState
  title: string
  facts: ProposalFact[]
  /** Shown when confirming makes something run on the person's computer. */
  note?: string
  /** Extra content under the facts (the agent's prompt, a skill's files). */
  children?: ReactNode
  confirmLabel: string
  onConfirm: () => void
  onDiscard?: () => void
  /** Opens the full form with everything filled in. */
  onDetails?: () => void
  /** Once created: where to look at it. */
  openLabel?: string
  onOpen?: () => void
  busy?: boolean
  error?: string
}) {
  const { t } = useTranslation()
  return (
    <div className={cn("not-prose my-2 w-full overflow-hidden rounded-xl border bg-card", state === "pending" && "shadow-sm")}>
      <div className="flex items-center gap-2.5 border-b px-3.5 py-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-3.5" />
        </span>
        <span className="flex-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {state === "pending" ? t("proposal.proposed", { kind }) : kind}
        </span>
        <StateChip state={state} />
      </div>

      <div className="flex flex-col gap-2.5 px-3.5 py-3">
        <p className="text-sm font-semibold">{title}</p>
        {facts.length > 0 && (
          <dl className="flex flex-col gap-1.5 text-xs">
            {facts.map((fact) => (
              <div key={fact.label} className="flex gap-3">
                <dt className="w-24 shrink-0 text-muted-foreground">{fact.label}</dt>
                <dd className={cn("min-w-0 flex-1 break-words", fact.mono && "font-mono text-[11px]")}>{fact.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {children}
        {note && state === "pending" && (
          <p className="flex items-start gap-2 rounded-lg border border-dashed px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
            <ShieldAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>{note}</span>
          </p>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t bg-muted/30 px-3.5 py-2.5">
        {error && <span className="mr-auto text-xs text-destructive">{error}</span>}
        {state === "pending" ? (
          <>
            {onDiscard && (
              <Button size="sm" variant="ghost" onClick={onDiscard} disabled={busy}>
                {t("proposal.discard")}
              </Button>
            )}
            {onDetails && (
              <Button size="sm" variant="outline" onClick={onDetails} disabled={busy}>
                {t("proposal.details")}
              </Button>
            )}
            <Button size="sm" onClick={onConfirm} disabled={busy}>
              {busy && <Loader2Icon className="size-3.5 animate-spin" />}
              {confirmLabel}
            </Button>
          </>
        ) : state === "created" && onOpen && openLabel ? (
          <Button size="sm" variant="outline" onClick={onOpen}>
            {openLabel}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function StateChip({ state }: { state: ProposalState }) {
  const { t } = useTranslation()
  if (state === "created") {
    return (
      <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
        <Check className="size-2.5" strokeWidth={3} />
        {t("proposal.state.created")}
      </span>
    )
  }
  if (state === "discarded") {
    return <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{t("proposal.state.discarded")}</span>
  }
  return <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">{t("proposal.state.pending")}</span>
}
