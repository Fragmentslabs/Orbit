import { tool } from 'ai'
import { ASK_WHEN_VAGUE } from './proposal-guidance'
import { z } from 'zod'
import { AGENT_FEATURES, AGENT_ICONS, AGENT_LIMITS, BUILTIN_PROFILES } from '@shared/agents'
import { agentSuggestionFrom } from '../agents/generator'
import { agentInputProblem, sanitizeAgentInput } from '../agents/validate'
import { loadSkills } from '../skills'

/**
 * create_agent tool: the chat PROPOSES an agent. Nothing is saved when the tool runs — the
 * proposal appears as an "Add agent" card in the conversation and the agent only exists once
 * the person approves it there. A prompt speaks to the model with system authority, so the
 * person always reads it before it can be used.
 */
export function createAgentTool() {
  return tool({
    description:
      'Proposes a new Orbit agent: a reusable setup with its own system prompt that the person can start chats with or have suggested for matching tasks. It appears as an "Add agent" card and is only created once the person approves it. Use it when the person asks for an agent; do not create one for a one-off task. After calling, say in one or two sentences what the agent is for. ' + ASK_WHEN_VAGUE,
    inputSchema: z.object({
      name: z.string().describe('1 to 4 words, in the person\'s language'),
      icon: z.enum(AGENT_ICONS).optional().describe('Icon of the agent'),
      whenToUse: z
        .string()
        .max(AGENT_LIMITS.whenToUse)
        .describe('ONE sentence about the kind of task this agent is the right one for. Other chats read it to suggest the agent.'),
      prompt: z
        .string()
        .max(AGENT_LIMITS.prompt)
        .describe('The agent\'s whole system prompt: who it is, how it works, what it must always or never do. Short and concrete.'),
      craft: z
        .enum(BUILTIN_PROFILES as unknown as [string, ...string[]])
        .optional()
        .describe('Only for an agent that exists to make that artifact (it brings the artifact\'s own tools)'),
      pinnedSkills: z.array(z.string()).optional().describe('Slugs of existing skills this agent should always follow'),
      features: z
        .partialRecord(z.enum(AGENT_FEATURES), z.boolean())
        .optional()
        .describe('Orbit features the agent may use. All off by default; turn one on only when the task needs it.'),
    }),
    execute: async (args) => {
      const known = (await loadSkills().catch(() => [])).map((s) => s.slug)
      const draft = agentSuggestionFrom(args as Record<string, unknown>, known)
      if (!draft) {
        const input = sanitizeAgentInput(args)
        return `Could not propose the agent: ${agentInputProblem(input) === 'name' ? 'it needs a name' : 'it needs a prompt'}.`
      }
      const dropped = (args.pinnedSkills ?? []).filter((slug) => !draft.pinnedSkills.includes(slug))
      return (
        `Agent "${draft.name}" proposed. An "Add agent" card appeared in the conversation — it is only created once the person approves it. ` +
        (dropped.length ? `These pinned skills do not exist and were left out: ${dropped.join(', ')}. ` : '') +
        'Now say, in one or two sentences, what the agent is for.'
      )
    },
  })
}
