import type { AgentDefinition } from '@shared/agents'
import { agentBlocks, userProfileId } from '@shared/agents'
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
  return {
    id: userProfileId(agent.id),
    builtin: false,
    systemPrompt: () => agent.prompt,
    allowedTools: agent.allowedTools,
    blocks: agentBlocks(agent.features),
    defaultModel: agent.defaultModel,
    thinking: agent.thinking,
  }
}
