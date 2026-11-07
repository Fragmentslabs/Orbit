import type { SpecialistProfile } from './chat'

/**
 * User-made agents and the description of every profile.
 *
 * An agent is the base identity of a conversation (see docs/specialist-agents.md). The
 * built-in specialists (fragment, motion, design) and the agents a person writes are the same
 * mechanism: a profile is a DEFINITION, and only the source of the definition differs.
 *
 * A profile can only RESTRICT or TOGGLE what the person already has. Nothing here can grant
 * a permission, a tool or a model the person did not already turn on.
 */

/**
 * The Orbit features a user-made agent can switch on. All are OFF in a new agent: it starts
 * empty. "On" means "this agent does not block it" — the feature still follows the person's
 * own settings, the model's abilities and the conversation toggles.
 */
export const AGENT_FEATURES = ['vision', 'subagents', 'orchestra', 'loop', 'memories'] as const
export type AgentFeature = (typeof AGENT_FEATURES)[number]

/** Icons an agent can wear (lucide names, mapped to components in the renderer). */
export const AGENT_ICONS = [
  'bot',
  'sparkles',
  'brain',
  'pen-tool',
  'code',
  'book-open',
  'flask-conical',
  'languages',
  'scale',
  'rocket',
  'heart',
  'graduation-cap',
  'briefcase',
  'lightbulb',
] as const
export type AgentIcon = (typeof AGENT_ICONS)[number]

/** Size caps, enforced where the agents are saved. */
export const AGENT_LIMITS = {
  agents: 50,
  name: 60,
  prompt: 20_000,
  allowedTools: 200,
  toolName: 80,
} as const

/** The current version of the definition format. Bumped when a field changes meaning. */
export const AGENT_FORMAT_VERSION = 1

/**
 * What a person writes: the editable part of an agent. This is also what an exported or
 * imported agent will carry — nothing in it is tied to this installation (no ids, no
 * paths), so a later import can validate it with the same rules and show it on a consent card.
 */
export interface AgentInput {
  name: string
  icon: AgentIcon
  /** The whole system prompt of the conversation. Empty = nothing is injected. */
  prompt: string
  features: Record<AgentFeature, boolean>
  /**
   * Optional allowlist of tool names. Absent = every tool the conversation would normally
   * have. It only narrows: a name that is not available in the conversation is ignored.
   */
  allowedTools?: string[]
  /** Optional model to start new chats with. Applies only when the person has that model. */
  defaultModel?: { providerId: string; modelId: string }
  /** Optional thinking default for new chats. */
  thinking?: boolean
}

/** A saved agent: the input plus what the installation adds. */
export interface AgentDefinition extends AgentInput {
  /** Format version of this record (see AGENT_FORMAT_VERSION). */
  version: number
  id: string
  /** Where it came from. Everything made in the app is `user`; `imported` is reserved for the
   *  later sharing flow, which must go through a consent card before saving. */
  origin: 'user' | 'imported'
  createdAt: number
  updatedAt: number
}

/** The profile id of a chat run by a user-made agent. */
export type UserProfileId = `agent:${string}`

const USER_PREFIX = 'agent:'
export const userProfileId = (agentId: string): UserProfileId => `${USER_PREFIX}${agentId}`
export const isUserProfileId = (id: string): id is UserProfileId => id.startsWith(USER_PREFIX)
export const agentIdOf = (id: UserProfileId): string => id.slice(USER_PREFIX.length)

export function emptyAgentInput(): AgentInput {
  return {
    name: '',
    icon: 'bot',
    prompt: '',
    features: { vision: false, subagents: false, orchestra: false, loop: false, memories: false },
  }
}

/** What a profile switches on or off for the whole conversation. */
export interface ProfileBlocks {
  /** Persistent memory: the memory tools and the memories injected in the prompt. */
  memories: boolean
  subagents: boolean
  orchestra: boolean
  loop: boolean
  /** The model's image input and the delegated vision model. */
  vision: boolean
  /** Web research and the browser. */
  web: boolean
  /** Computer control. */
  computer: boolean
  /** Plan mode. */
  plan: boolean
  /** Skills, project context and the subchats block of the turn. */
  skills: boolean
}

/**
 * The blocks of a user-made agent: its five switches, plus the things it leaves under the
 * person's own toggles (web, computer, plan). Shared so the engine and the page that shows
 * what the agent injects read the same rule.
 */
export function agentBlocks(features: AgentInput['features']): ProfileBlocks {
  return {
    memories: features.memories,
    subagents: features.subagents,
    orchestra: features.orchestra,
    loop: features.loop,
    vision: features.vision,
    web: true,
    computer: true,
    plan: true,
    // Skills and project context belong to the general prompt, which an agent replaces.
    skills: false,
  }
}

/**
 * Everything a profile injects, for the Specialists page. Built from the same definition the
 * engine runs, so the page cannot drift from what the model really receives.
 */
export interface ProfileDescription {
  /** `fragment` | `motion` | `design` for built-ins, `agent:<id>` for the person's own. */
  id: string
  builtin: boolean
  /** The system prompt as the model receives it (a placeholder stands for the reply-language line). */
  systemPrompt: string
  /** The tools of the craft. Empty with `generalTools` = the conversation's usual tools. */
  tools: string[]
  generalTools: boolean
  blocks: ProfileBlocks
  /** A one-line description of the block injected at every turn, if any. */
  turnContext?: string
}

/** What an agent made by the person injects — the same description the built-ins have. */
export function describeUserAgent(agent: AgentInput & { id: string }): ProfileDescription {
  return {
    id: userProfileId(agent.id),
    builtin: false,
    systemPrompt: agent.prompt,
    tools: agent.allowedTools ?? [],
    generalTools: !agent.allowedTools,
    blocks: agentBlocks(agent.features),
  }
}

/** The list the Specialists page shows. */
export interface AgentsSnapshot {
  agents: AgentDefinition[]
  builtins: ProfileDescription[]
}

export const AGENT_CHANNELS = {
  snapshot: 'agents:snapshot',
  save: 'agents:save',
  duplicate: 'agents:duplicate',
  remove: 'agents:remove',
  changed: 'agents:changed',
} as const

/** Built-in profiles in the order they are listed. */
export const BUILTIN_PROFILES: readonly SpecialistProfile[] = ['fragment', 'motion', 'design']
