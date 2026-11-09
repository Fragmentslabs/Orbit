import type { AgentDefinition } from '@shared/agents'
import { agentBlocks, userProfileId } from '@shared/agents'
import { BUILTIN_DEFINITIONS } from './builtin'
import { pinnedSkillsBlock } from '../agents/pinned-skills'
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
  // A craft agent works on the craft's artifact: its tools, blocks and turn context are the
  // craft's own; only the words (prompt, when to use, pinned skills) are the agent's.
  const craft = agent.craft ? BUILTIN_DEFINITIONS[agent.craft] : undefined
  return {
    ...(craft && { tools: craft.tools, turnBlock: craft.turnBlock, turnContext: craft.turnContext }),
    id: userProfileId(agent.id),
    builtin: false,
    systemPrompt: (input) => [agent.prompt || craft?.systemPrompt(input) || '', pinnedSkillsBlock(agent.pinnedSkills)].filter(Boolean).join('\n\n'),
    whenToUse: agent.whenToUse,
    pinnedSkills: agent.pinnedSkills,
    allowedTools: agent.allowedTools,
    sections: agent.sections,
    blocks: craft ? craft.blocks : agentBlocks(agent.features),
    defaultModel: agent.defaultModel,
    thinking: agent.thinking,
  }
}
