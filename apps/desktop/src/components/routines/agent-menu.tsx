import { useTranslation } from "react-i18next"
import { ChevronDownIcon } from "lucide-react"
import type { ProfileId } from "@shared/chat"
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { agentView } from "@/src/components/agent-meta"
import { AgentChoiceMenu } from "@/src/components/agent-selector"
import type { AgentChoice } from "@/src/components/agent-meta"
import { useAgents } from "@/src/stores/agents-store"

/**
 * Which agent does a piece of work: the general Orbit setup or one the person made.
 *
 * The list is the SAME one as the chat header's selector (agent-selector.tsx): the built-in
 * setups, the person's agents with their descriptions and the "Manage agents" entry. `compact`
 * shows only the icon; `badge` is the header's pill (icon, name and chevron).
 */
export function AgentMenu({ value, onChange, compact, badge, onManage, builtins, excludeCraft, className }: {
  value: ProfileId | undefined
  onChange: (agent: ProfileId | undefined) => void
  compact?: boolean
  /** The header's pill: icon, name and chevron, for a row where the agent is one field. */
  badge?: boolean
  /** Runs before going to the agents screen — the caller can close itself first. */
  onManage?: () => void
  /** Which built-in setups to offer (default: all of them). */
  builtins?: AgentChoice[]
  /** Leaves out the craft agents — a phase runs its own tools, not a craft's. */
  excludeCraft?: boolean
  className?: string
}) {
  const { t } = useTranslation()
  const agents = useAgents()
  const general = agentView("general", agents, t)!
  const current = (value ? agentView(value, agents, t) : null) ?? general
  const Icon = current.icon

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("routines.form.agent")}
        title={compact || badge ? current.name : undefined}
        className={cn(
          "flex items-center gap-2 text-left text-xs transition-colors",
          compact
            ? "size-8 justify-center rounded-md border bg-background hover:bg-accent"
            : badge
              ? "h-7 max-w-48 shrink-0 gap-1.5 rounded-full px-2 hover:bg-accent"
              : "h-9 w-full rounded-md border bg-background px-2.5 hover:bg-accent",
          className,
        )}
      >
        <Icon className={cn("shrink-0", badge ? "size-3.5" : "size-4", current.color)} />
        {!compact && (
          <>
            <span className="min-w-0 flex-1">
              <span className={cn("block truncate", badge ? "text-xs" : "text-sm")}>{current.name}</span>
            </span>
            <ChevronDownIcon className={cn("shrink-0 text-muted-foreground", badge ? "size-3" : "size-3.5")} />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <AgentChoiceMenu
          value={value ?? "general"}
          onSelect={(next) => onChange(next === "general" ? undefined : next)}
          onManage={onManage}
          builtins={builtins}
          excludeCraft={excludeCraft}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
