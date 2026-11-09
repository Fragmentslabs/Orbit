import type { AgentDefinition, ProfileDescription } from '@shared/agents'
import { BUILTIN_PROFILES, userProfileId } from '@shared/agents'
import type { SendMessageInput } from '@shared/chat'
import { getOverrideSync } from '../agents/overrides'
import { pinnedSkillsBlock } from '../agents/pinned-skills'
import { resolveProfile } from './index'
import type { ProfileDefinition } from './types'

/**
 * What a profile injects, read from the same definition the engine runs — the Specialists page
 * shows exactly this, so it cannot drift from what the model receives. Built-ins and the
 * person's agents go through the one `describe`.
 */

/** A session id that owns nothing: building a toolset only declares tools, it touches no disk. */
const DESCRIBE_INPUT = { sessionId: 'describe', mode: 'chat', text: '', providerId: '', modelId: '', options: {} } as unknown as SendMessageInput

function describe(id: string, builtin: boolean, def: ProfileDefinition, edited?: boolean): ProfileDescription {
  const tools = def.tools ? Object.keys(def.tools(DESCRIBE_INPUT)).sort() : []
  // `language` is filled in per turn; the page shows the prompt with the default reply line.
  const systemPrompt = def.systemPrompt({ language: undefined })
  const pinned = pinnedSkillsBlock(def.pinnedSkills ?? []).length
  return {
    id,
    builtin,
    edited,
    systemPrompt,
    whenToUse: def.whenToUse ?? '',
    pinnedSkills: def.pinnedSkills ?? [],
    weight: { prompt: systemPrompt.length - pinned, pinnedSkills: pinned, tools: tools.join(' ').length },
    tools: def.allowedTools && !def.tools ? def.allowedTools : tools,
    generalTools: !def.tools,
    blocks: def.blocks,
    turnContext: def.turnContext,
  }
}

export function describeBuiltins(): ProfileDescription[] {
  return BUILTIN_PROFILES.flatMap((id) => {
    const def = resolveProfile(id)
    return def ? [describe(id, true, def, getOverrideSync(id) !== undefined)] : []
  })
}

/** The person's agents, by profile id. */
export function describeAgents(agents: readonly AgentDefinition[]): Record<string, ProfileDescription> {
  const out: Record<string, ProfileDescription> = {}
  for (const agent of agents) {
    const id = userProfileId(agent.id)
    const def = resolveProfile(id)
    if (def) out[id] = describe(id, false, def)
  }
  return out
}
