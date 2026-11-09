import { tool } from 'ai'
import { z } from 'zod'
import { AGENT_ICONS, EPHEMERAL_LIMITS, userProfileId } from '@shared/agents'
import { defineEphemeral } from '../agents/ephemeral'

/**
 * define_agent: the orchestrator builds a temporary agent for the tasks of ONE plan. It is not
 * written to the person's agents; the worker's chat shows it as temporary with a "Save as
 * agent" button. Only the orchestrator's planning pass has this tool — a chat, a worker or a
 * tool result cannot create one — and it can never give a worker more than the orchestrator has.
 */
export function defineAgentTool(ownerSessionId: string) {
  return tool({
    description:
      'Defines a temporary agent for tasks of THIS plan: a worker setup with its own short prompt and, optionally, a narrower tool list. ' +
      'It is not saved to the user\'s agents (the user can save it afterwards) and its workers get the modes of their task and nothing more. ' +
      'Use it only when several tasks need the same specific role and none of "AGENTS YOU CAN USE FOR A TASK" fits; for one task, put the instructions in the task prompt. ' +
      `At most ${EPHEMERAL_LIMITS.perSession} per plan. Then pass the returned id as the agent of create_task.`,
    inputSchema: z.object({
      name: z.string().describe('1 to 4 words, in the user\'s language'),
      icon: z.enum(AGENT_ICONS).optional(),
      prompt: z
        .string()
        .max(EPHEMERAL_LIMITS.prompt)
        .describe('Its whole system prompt: the role, how it works, what it must always or never do. Short and concrete. The task itself goes in create_task.'),
      allowedTools: z.array(z.string()).max(EPHEMERAL_LIMITS.allowedTools).optional().describe('Narrows the worker to these tool names. Leave out for the usual worker toolset.'),
    }),
    execute: async ({ name, icon, prompt, allowedTools }) => {
      const result = await defineEphemeral(ownerSessionId, { name, icon, prompt, allowedTools })
      if (!result.ok) {
        if (result.reason === 'limit') return `Not defined: ${EPHEMERAL_LIMITS.perSession} temporary agents already exist for this chat. Reuse one of them or put the instructions in the task prompt.`
        return `Not defined: ${result.reason === 'name' ? 'it needs a name' : 'it needs a prompt'}.`
      }
      return `Temporary agent "${result.agent.input.name}" defined. Use agent: "${userProfileId(result.agent.id)}" in create_task for the tasks that need it.`
    },
  })
}
