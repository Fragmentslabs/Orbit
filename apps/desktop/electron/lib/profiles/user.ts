import type { AgentDefinition, ProfileBlocks } from '@shared/agents'
import { userProfileId } from '@shared/agents'
import type { ProfileDefinition } from './types'

/**
 * The profile of an agent the person wrote. Same shape as a built-in; what differs is that it
 * has no craft tools — it runs on the conversation's usual toolset — so it can only narrow it.
 *
 * "Empty" is literal: with no prompt the model gets no system prompt, and with every switch
 * off the conversation has no memories, subagents, orchestra, loop or vision beyond what the
 * chat itself offers. Web, computer and plan stay under the person's own toggles in the
 * composer: the agent neither forces them on nor needs to turn them off.
 */
export function profileOfAgent(agent: AgentDefinition): ProfileDefinition {
  const blocks: ProfileBlocks = {
    memories: agent.features.memories,
    subagents: agent.features.subagents,
    orchestra: agent.features.orchestra,
    loop: agent.features.loop,
    vision: agent.features.vision,
    web: true,
    computer: true,
    plan: true,
    // Skills and project context are part of the general prompt, which a user agent replaces.
    skills: false,
  }
  return {
    id: userProfileId(agent.id),
    builtin: false,
    systemPrompt: () => agent.prompt,
    allowedTools: agent.allowedTools,
    blocks,
    defaultModel: agent.defaultModel,
    thinking: agent.thinking,
  }
}
