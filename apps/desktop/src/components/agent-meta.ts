import {
  AppWindow,
  Bot,
  BookOpen,
  Brain,
  Briefcase,
  Clapperboard,
  Code,
  FlaskConical,
  GraduationCap,
  Heart,
  Languages,
  Lightbulb,
  MessageSquare,
  PenTool,
  Rocket,
  Scale,
  Sparkles,
  type LucideIcon,
} from "lucide-react"
import type { TFunction } from "i18next"
import { agentIdOf, isUserProfileId, type AgentDefinition, type AgentIcon } from "@shared/agents"
import type { ProfileId, SessionInfo, SpecialistProfile } from "@shared/chat"
import { useAgentsStore } from "@/src/stores/agents-store"

/** The agents a chat can start with. `general` is the usual chat; the others are profiles. */
export type AgentChoice = "general" | ProfileId

const FRAGMENT_ICON = AppWindow

/** The icons an agent made by the person can wear (the names are validated in main). */
export const AGENT_ICON_COMPONENTS: Record<AgentIcon, LucideIcon> = {
  bot: Bot,
  sparkles: Sparkles,
  brain: Brain,
  "pen-tool": PenTool,
  code: Code,
  "book-open": BookOpen,
  "flask-conical": FlaskConical,
  languages: Languages,
  scale: Scale,
  rocket: Rocket,
  heart: Heart,
  "graduation-cap": GraduationCap,
  briefcase: Briefcase,
  lightbulb: Lightbulb,
}

export const AGENT_META: Record<"general" | SpecialistProfile, { icon: LucideIcon; name: string; description: string; color: string }> = {
  general: { icon: MessageSquare, name: "agent.general.name", description: "agent.general.description", color: "text-muted-foreground" },
  fragment: { icon: AppWindow, name: "agent.fragment.name", description: "agent.fragment.description", color: "text-teal-500" },
  motion: { icon: Clapperboard, name: "agent.motion.name", description: "agent.motion.description", color: "text-rose-500" },
  design: { icon: PenTool, name: "agent.design.name", description: "agent.design.description", color: "text-violet-500" },
}

/** How an agent looks in a menu or a badge — already translated. */
export interface AgentView {
  icon: LucideIcon
  name: string
  description: string
  color: string
}

const USER_COLOR = "text-sky-500"

export function userAgentView(agent: AgentDefinition, t: TFunction): AgentView {
  return { icon: AGENT_ICON_COMPONENTS[agent.icon], name: agent.name, description: t("agent.custom.description"), color: USER_COLOR }
}

/** The view of a choice, or null when it points to an agent that no longer exists. */
export function agentView(choice: AgentChoice, agents: AgentDefinition[], t: TFunction): AgentView | null {
  if (isUserProfileId(choice)) {
    const agent = agents.find((a) => a.id === agentIdOf(choice))
    return agent ? userAgentView(agent, t) : null
  }
  const meta = AGENT_META[choice]
  return { icon: meta.icon, name: t(meta.name), description: t(meta.description), color: meta.color }
}

/** The icon the sidebar shows for a chat: the mode of a specialist, the bubble otherwise. */
export function sessionIcon(session: Pick<SessionInfo, "profile" | "fragment">): LucideIcon | undefined {
  if (session.fragment) return FRAGMENT_ICON
  const profile = session.profile
  if (!profile) return undefined
  if (isUserProfileId(profile)) {
    const agent = useAgentsStore.getState().agents.find((a) => a.id === agentIdOf(profile))
    return agent ? AGENT_ICON_COMPONENTS[agent.icon] : undefined
  }
  return AGENT_META[profile].icon
}
