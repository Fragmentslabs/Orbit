import { AppWindow, Bot, Clapperboard, MessageSquare, MessagesSquare, PenTool, type LucideIcon } from 'lucide-react-native'
import type { SessionInfo } from '@orbit/shared'

/** Icon of each specialist chat — the same ones as the desktop's AGENT_META. */
const SPECIALIST_ICON = {
  fragment: AppWindow,
  motion: Clapperboard,
  design: PenTool,
} as const

/**
 * The icon the list shows for a chat, as on the desktop (`sessionIcon` of agent-meta): a
 * fragment or a specialist (motion, design) wears its own, an agent the person made wears the
 * agent's bot (the phone does not know the agents' own icons), and any other chat the bubble.
 */
export function sessionIcon(session: Pick<SessionInfo, 'profile' | 'fragment'>): LucideIcon {
  if (session.fragment) return SPECIALIST_ICON.fragment
  const profile = session.profile
  if (!profile) return MessageSquare
  if (profile in SPECIALIST_ICON) return SPECIALIST_ICON[profile as keyof typeof SPECIALIST_ICON]
  return Bot
}

/**
 * Icon of a chat nested under another one: a specialist keeps its own; a worker is an agent (Bot);
 * a subchat uses the two nested bubbles — "conversation opened from here".
 */
export function childSessionIcon(session: Pick<SessionInfo, 'profile' | 'fragment' | 'orchestration'>): LucideIcon {
  if (session.fragment || session.profile) return sessionIcon(session)
  return session.orchestration?.role === 'worker' ? Bot : MessagesSquare
}
