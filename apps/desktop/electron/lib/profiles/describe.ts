import type { AgentDefinition, AgentPromptSection, ProfileDescription, PromptPieceWeight } from '@shared/agents'
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

/** What each general section weighs, in tokens; the sections an agent takes are priced from it. */
export type SectionWeights = Partial<Record<AgentPromptSection, number>>

const tokens = (chars: number) => Math.ceil(chars / 4)

function describe(id: string, builtin: boolean, def: ProfileDefinition, edited?: boolean, weights: SectionWeights = {}, temporary?: boolean): ProfileDescription {
  const tools = def.tools ? Object.keys(def.tools(DESCRIBE_INPUT)).sort() : []
  // `language` is filled in per turn; the page shows the prompt with the default reply line.
  const systemPrompt = def.systemPrompt({ language: undefined })
  const pinned = pinnedSkillsBlock(def.pinnedSkills ?? []).length
  const borrowed = (def.sections ?? []).map((section): PromptPieceWeight => ({ id: section, tokens: weights[section] ?? 0 }))
  const pieces: PromptPieceWeight[] = [
    { id: 'agent', tokens: tokens(systemPrompt.length - pinned) },
    ...(pinned > 0 ? [{ id: 'pinned-skills', tokens: tokens(pinned) }] : []),
    ...borrowed,
  ].filter((piece) => piece.tokens > 0 || piece.id !== 'agent')
  return {
    id,
    builtin,
    edited,
    ...(temporary && { temporary }),
    pieces,
    systemPrompt,
    whenToUse: def.whenToUse ?? '',
    pinnedSkills: def.pinnedSkills ?? [],
    weight: { prompt: systemPrompt.length - pinned + borrowed.reduce((sum, p) => sum + p.tokens * 4, 0), pinnedSkills: pinned, tools: tools.join(' ').length },
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
export function describeAgents(
  agents: readonly AgentDefinition[],
  weights: SectionWeights = {},
  /** Ids of the agents that are temporary (defined by an orchestrator, not saved). */
  temporary: ReadonlySet<string> = new Set(),
): Record<string, ProfileDescription> {
  const out: Record<string, ProfileDescription> = {}
  for (const agent of agents) {
    const id = userProfileId(agent.id)
    const def = resolveProfile(id)
    if (def) out[id] = describe(id, false, def, undefined, weights, temporary.has(agent.id))
  }
  return out
}
