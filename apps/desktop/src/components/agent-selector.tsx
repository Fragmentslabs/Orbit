import { ChevronDown, Check } from "lucide-react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import { specialistProfileOf, type SessionInfo } from "@shared/chat"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { useSessionStore } from "@/src/stores/session-store"
import { AGENT_META, type AgentChoice } from "@/src/components/agent-meta"

const CHOICES: AgentChoice[] = ["general", "fragment", "motion", "design"]

/**
 * Which agent a conversation runs with. The agent is fixed for the life of a conversation
 * (changing it mid-chat would break the prompt cache and mix instructions), so this is a
 * selector only for a NEW chat; once the chat exists it becomes a plain badge.
 */
export function AgentSelector({ session }: { session?: SessionInfo }) {
  const { t } = useTranslation()
  const pending = useSessionStore((s) => s.pendingProfile)
  const setPending = useSessionStore((s) => s.setPendingProfile)

  if (session) {
    // A general chat shows nothing.
    const profile = specialistProfileOf(session)
    if (!profile || !(profile in AGENT_META)) return null
    const meta = AGENT_META[profile as AgentChoice]
    const Icon = meta.icon
    return (
      <span className="flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
        <Icon className={cn("size-3", meta.color)} />
        {t(meta.name)}
      </span>
    )
  }

  const value: AgentChoice = pending ?? "general"
  const current = AGENT_META[value]
  const CurrentIcon = current.icon
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="sm" className="h-7 shrink-0 gap-1.5 rounded-full px-2 text-xs" />}
      >
        <CurrentIcon className={cn("size-3.5", current.color)} />
        {t(current.name)}
        <ChevronDown className="size-3 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {CHOICES.map((choice) => {
          const meta = AGENT_META[choice]
          const Icon = meta.icon
          return (
            <DropdownMenuItem key={choice} onClick={() => setPending(choice === "general" ? null : choice)}>
              <Icon className={cn("size-4", meta.color)} />
              <div className="min-w-0 flex-1">
                <div className="text-sm">{t(meta.name)}</div>
                <div className="text-xs text-muted-foreground">{t(meta.description)}</div>
              </div>
              {value === choice && <Check className="size-3.5" />}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
