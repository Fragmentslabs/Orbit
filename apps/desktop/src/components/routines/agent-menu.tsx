import { useTranslation } from "react-i18next"
import { CheckIcon, ChevronDownIcon } from "lucide-react"
import { userProfileId } from "@shared/agents"
import type { ProfileId } from "@shared/chat"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { agentView, userAgentView } from "@/src/components/agent-meta"
import { useAgents } from "@/src/stores/agents-store"

/**
 * Which agent does a piece of work: the general Orbit setup or one the person made. A menu with the
 * agents' icons (the same look as the chat's agent selector), not a native select.
 * `compact` shows only the icon, for a row in the list of a team.
 */
export function AgentMenu({ value, onChange, compact, className }: {
  value: ProfileId | undefined
  onChange: (agent: ProfileId | undefined) => void
  compact?: boolean
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
        title={compact ? current.name : undefined}
        className={cn(
          "flex items-center gap-2 rounded-md border bg-background text-left text-xs transition-colors hover:bg-accent",
          compact ? "size-8 justify-center" : "h-9 w-full px-2.5",
          className,
        )}
      >
        <Icon className={cn("size-4 shrink-0", current.color)} />
        {!compact && (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{current.name}</span>
            </span>
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-64">
        <Item view={general} selected={!value} onSelect={() => onChange(undefined)} />
        {agents.length > 0 && <DropdownMenuSeparator />}
        {agents.map((agent) => {
          const id = userProfileId(agent.id)
          return <Item key={agent.id} view={userAgentView(agent, t)} selected={value === id} onSelect={() => onChange(id)} />
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Item({ view, selected, onSelect }: { view: ReturnType<typeof userAgentView>; selected: boolean; onSelect: () => void }) {
  const Icon = view.icon
  return (
    <DropdownMenuItem onClick={onSelect}>
      <Icon className={cn("size-4", view.color)} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{view.name}</div>
        <div className="truncate text-xs text-muted-foreground">{view.description}</div>
      </div>
      {selected && <CheckIcon className="size-3.5" />}
    </DropdownMenuItem>
  )
}
