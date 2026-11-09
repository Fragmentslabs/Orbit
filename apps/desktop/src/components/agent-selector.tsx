import { useState } from "react"
import { ChevronDown, Check, Settings2, Plus } from "lucide-react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/lib/workspace-context"
import { userProfileId } from "@shared/agents"
import { specialistProfileOf, type SessionInfo } from "@shared/chat"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useSessionStore } from "@/src/stores/session-store"
import { useToolsNavStore } from "@/src/stores/tools-nav-store"
import { useAgentLookup, useAgents, useIsTemporary } from "@/src/stores/agents-store"
import { agentView, userAgentView, type AgentChoice, type AgentView } from "@/src/components/agent-meta"
import { ProfileDialog } from "@/src/components/specialists/profile-dialog"

const BUILTIN_CHOICES: AgentChoice[] = ["general", "fragment", "motion", "design"]

function AgentItem({ view, selected, onSelect }: { view: AgentView; selected: boolean; onSelect: () => void }) {
  const Icon = view.icon
  return (
    <DropdownMenuItem onClick={onSelect}>
      <Icon className={cn("size-4", view.color)} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{view.name}</div>
        <div className="truncate text-xs text-muted-foreground">{view.description}</div>
      </div>
      {selected && <Check className="size-3.5" />}
    </DropdownMenuItem>
  )
}

/**
 * Which agent a conversation runs with. The agent is fixed for the life of a conversation
 * (changing it mid-chat would break the prompt cache and mix instructions), so this is a
 * selector only for a NEW chat; once the chat exists it becomes a badge that opens a view of
 * exactly what the agent injects.
 */
export function AgentSelector({ session }: { session?: SessionInfo }) {
  const { t } = useTranslation()
  const agents = useAgents()
  const lookup = useAgentLookup()
  const pending = useSessionStore((s) => s.pendingProfile)
  const setPending = useSessionStore((s) => s.setPendingProfile)
  const { setView } = useWorkspace()
  const requestSection = useToolsNavStore((s) => s.request)
  const [inspecting, setInspecting] = useState(false)
  const temporary = useIsTemporary(session ? specialistProfileOf(session) ?? undefined : undefined)

  const manage = () => {
    requestSection("specialists")
    setView("tools")
  }

  if (session) {
    // A general chat shows nothing — and neither does one whose agent has since been deleted,
    // because it runs the general setup again.
    const profile = specialistProfileOf(session)
    const view = profile ? agentView(profile, lookup, t) : null
    if (!profile || !view) return null
    const Icon = view.icon
    return (
      <>
        <button
          type="button"
          onClick={() => setInspecting(true)}
          title={t("agent.inspect")}
          className="flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted/50"
        >
          <Icon className={cn("size-3", view.color)} />
          {view.name}
          {temporary && <span className="rounded bg-amber-500/10 px-1 text-[10px] text-amber-600 dark:text-amber-400">{t("agent.temporary")}</span>}
        </button>
        <ProfileDialog profile={profile} open={inspecting} onOpenChange={setInspecting} />
      </>
    )
  }

  // A pending agent that was deleted since falls back to the general chat.
  const value: AgentChoice = pending && agentView(pending, agents, t) ? pending : "general"
  const current = agentView(value, agents, t)!
  const CurrentIcon = current.icon
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="sm" className="h-7 max-w-48 shrink-0 gap-1.5 rounded-full px-2 text-xs" />}
      >
        <CurrentIcon className={cn("size-3.5 shrink-0", current.color)} />
        <span className="truncate">{current.name}</span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {/* A group label must live inside a group (Base UI throws otherwise). */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t("agent.group.builtin")}</DropdownMenuLabel>
          {BUILTIN_CHOICES.map((choice) => (
            <AgentItem
              key={choice}
              view={agentView(choice, agents, t)!}
              selected={value === choice}
              onSelect={() => setPending(choice === "general" ? null : choice)}
            />
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t("agent.group.mine")}</DropdownMenuLabel>
          {agents.map((agent) => (
            <AgentItem
              key={agent.id}
              view={userAgentView(agent, t)}
              selected={value === userProfileId(agent.id)}
              onSelect={() => setPending(userProfileId(agent.id))}
            />
          ))}
        </DropdownMenuGroup>
        <DropdownMenuItem onClick={manage}>
          {agents.length === 0 ? <Plus className="size-4" /> : <Settings2 className="size-4" />}
          <span className="text-sm">{agents.length === 0 ? t("agent.create") : t("agent.manage")}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
