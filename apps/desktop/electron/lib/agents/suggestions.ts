import { agentIdOf, isUserProfileId, userProfileId, type AgentDefinition } from '@shared/agents'
import { resolveEphemeralSync } from './ephemeral'
import { getAgentSync, listAgentsSync, loadAgents } from './store'

/**
 * Which agents the general chat may suggest, and how it is told about them.
 *
 * The line "when to use" is the switch: an agent without one is never suggested. The chat gets a
 * compact catalog (id, name, when) and rules that keep it quiet — a suggestion is a card the
 * person has to answer, so the default is silence. Built-in crafts are not listed here: the prompt
 * names them directly, and the creation tools are the safety net (see `withSpecialistOffer`).
 */

/** More than this and the catalog stops being a catalog; the newest agents are the ones left out. */
const CATALOG_LIMIT = 20

export function suggestibleAgents(agents: AgentDefinition[] = listAgentsSync()): AgentDefinition[] {
  return agents.filter((a) => a.whenToUse.trim().length > 0 && a.prompt.trim().length > 0).slice(0, CATALOG_LIMIT)
}

/** The agent behind a profile id, when it may be suggested right now. */
export function suggestibleAgent(id: string): AgentDefinition | null {
  if (!isUserProfileId(id)) return null
  const agent = getAgentSync(agentIdOf(id))
  return agent && suggestibleAgents().some((a) => a.id === agent.id) ? agent : null
}

/** What a chat with this profile is called in text the model reads. */
export function profileLabel(profile: string): string {
  if (!isUserProfileId(profile)) return profile
  const id = agentIdOf(profile)
  return (getAgentSync(id) ?? resolveEphemeralSync(id))?.name ?? 'agent'
}

const RULES = `Suggest one with suggest_subchat({ agent: "<id>", title, brief }) — it shows the user a card; nothing opens unless they accept. Rules:
- Only when the request clearly matches a line above AND is real work: something that produces its own artifact or takes many steps. Not for questions, small edits or anything you can finish in a couple of steps.
- Silence is the default. When no line clearly fits, say nothing about agents and just do the work.
- One suggestion at a time. After the user answers a suggestion (accepts, keeps going here or declines), never suggest that agent again in this conversation.
- Never suggest one because the user asked for something broad, and never to avoid doing the work.`

/** The prompt block, or '' when there is nothing to suggest. */
export function agentCatalogBlock(agents: AgentDefinition[]): string {
  const list = suggestibleAgents(agents)
  if (list.length === 0) return ''
  const lines = list.map((a) => `- ${userProfileId(a.id)} — ${a.name}: ${a.whenToUse}`)
  return `AGENTS THE USER HAS. Specialist agents, each with its own setup, that can take a piece of work in a chat of its own.\n${lines.join('\n')}\n${RULES}`
}

/** The block for a turn: loads the agents first, never fails the prompt. */
export async function agentCatalogForPrompt(): Promise<string> {
  try {
    return agentCatalogBlock(await loadAgents())
  } catch {
    return ''
  }
}

const WORKER_RULES = `A task can run as one of these agents: create_task({ agent: "<id>", … }). The worker then works with that agent's own setup and instructions instead of the general code worker, so use one only when the task is exactly what the line says (a review, a security pass, a video script). The prompt you write still has to carry the whole task — the agent does not see this conversation. Most tasks need no agent: leave it out and the general worker does the job.`

/** What the orchestrator is told about agents when it plans, or '' when none qualifies. */
export function workerAgentsBlock(agents: AgentDefinition[]): string {
  const list = suggestibleAgents(agents)
  if (list.length === 0) return ''
  const lines = list.map((a) => `- ${userProfileId(a.id)} — ${a.name}: ${a.whenToUse}`)
  return `\n\nAGENTS YOU CAN USE FOR A TASK\n${lines.join('\n')}\n${WORKER_RULES}`
}

export async function workerAgentsForPlan(): Promise<string> {
  try {
    return workerAgentsBlock(await loadAgents())
  } catch {
    return ''
  }
}
