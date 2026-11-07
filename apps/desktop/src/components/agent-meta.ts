import { AppWindow, Clapperboard, MessageSquare, PenTool, type LucideIcon } from "lucide-react"
import type { SessionInfo, SpecialistProfile } from "@shared/chat"

/** The agents a chat can start with. `general` is the usual chat; the others are lean specialists. */
export type AgentChoice = "general" | SpecialistProfile

const FRAGMENT_ICON = AppWindow

export const AGENT_META: Record<AgentChoice, { icon: LucideIcon; name: string; description: string; color: string }> = {
  general: { icon: MessageSquare, name: "agent.general.name", description: "agent.general.description", color: "text-muted-foreground" },
  fragment: { icon: AppWindow, name: "agent.fragment.name", description: "agent.fragment.description", color: "text-teal-500" },
  motion: { icon: Clapperboard, name: "agent.motion.name", description: "agent.motion.description", color: "text-rose-500" },
  design: { icon: PenTool, name: "agent.design.name", description: "agent.design.description", color: "text-violet-500" },
}

/** The icon the sidebar shows for a chat: the mode of a specialist, the bubble otherwise. */
export function sessionIcon(session: Pick<SessionInfo, "profile" | "fragment">): LucideIcon | undefined {
  if (session.fragment) return FRAGMENT_ICON
  // An agent the person made has its own icon, resolved where the list of agents is known.
  return session.profile && session.profile in AGENT_META ? AGENT_META[session.profile as AgentChoice].icon : undefined
}
