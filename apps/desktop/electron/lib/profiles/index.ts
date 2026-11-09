import type { ToolSet } from 'ai'
import { isUserProfileId, agentIdOf, type ProfileBlocks } from '@shared/agents'
import {
  StorageKeys,
  specialistProfileOf,
  type ProfileId,
  type SendMessageInput,
  type SessionInfo,
} from '@shared/chat'
import { getOverrideSync, loadOverrides } from '../agents/overrides'
import { refreshPinnedSkills } from '../agents/pinned-skills'
import { loadEphemeral, resolveEphemeralSync } from '../agents/ephemeral'
import { getAgentSync, loadAgents } from '../agents/store'
import { readJson } from '../storage'
import { BUILTIN_DEFINITIONS, withOverride } from './builtin'
import { profileOfAgent } from './user'
import type { ProfileDefinition } from './types'

export { restrictTools } from './tool-blocks'
export type { ProfileDefinition } from './types'

/**
 * Profiles: a chat can run with a setup other than the general one — a built-in craft
 * (fragment, motion, design) or an agent the person wrote. Both are the same thing, a
 * ProfileDefinition (see types.ts), and the engine only ever asks this module.
 *
 * The profile is decided HERE, from the session on disk — never trusted from the UI — and is
 * fixed for the life of the conversation. A profile can only restrict or toggle: it narrows the
 * toolset and switches blocks off, it never grants anything the person has not turned on.
 */

/** The definition behind a profile id, or null when it does not exist (a deleted agent). */
export function resolveProfile(id: ProfileId): ProfileDefinition | null {
  if (isUserProfileId(id)) {
    const agent = getAgentSync(agentIdOf(id)) ?? resolveEphemeralSync(agentIdOf(id))
    return agent ? profileOfAgent(agent) : null
  }
  const builtin = BUILTIN_DEFINITIONS[id]
  return builtin ? withOverride(builtin, getOverrideSync(id)) : null
}

/**
 * The profile of a session, read from disk at the start of a turn (null = a general chat, or
 * an agent that has since been deleted — its chats fall back to the general setup).
 */
export async function profileOf(sessionId: string): Promise<ProfileId | null> {
  const session = await readJson<SessionInfo>(StorageKeys.session(sessionId))
  const id = specialistProfileOf(session)
  if (!id) return null
  await Promise.all([loadAgents(), loadEphemeral(), loadOverrides()])
  const def = resolveProfile(id)
  if (!def) return null
  await refreshPinnedSkills(def.pinnedSkills ?? [])
  return id
}

/**
 * Applies a profile to a turn: marks it and switches off what its blocks switch off. Only ever
 * clears things, so applying it twice (the dispatcher and the engine both do) changes nothing.
 */
export function restrictInput(input: SendMessageInput, profile: ProfileId): SendMessageInput {
  const def = resolveProfile(profile)
  const b: ProfileBlocks = def?.blocks ?? NO_BLOCKS
  const options = { ...input.options, profile }
  if (!b.memories) {
    options.brain = false
    options.brainContext = false
  }
  if (!b.skills) options.skillHints = false
  if (!b.subagents) options.subagents = false
  if (!b.orchestra) options.orchestrate = undefined
  if (!b.loop) options.loop = undefined
  if (!b.web) {
    options.research = false
    options.browser = false
  }
  if (!b.computer) options.computer = false
  if (!b.plan) options.plan = false
  return {
    ...input,
    options,
    ...(b.loop ? {} : { loopConfig: undefined }),
    // Vision delegated to another model is a way of seeing images too.
    ...(b.vision ? {} : { visionModel: undefined }),
  }
}

/** An unknown profile gets nothing: failing closed. */
const NO_BLOCKS: ProfileBlocks = {
  memories: false,
  subagents: false,
  orchestra: false,
  loop: false,
  vision: false,
  web: false,
  computer: false,
  plan: false,
  skills: false,
}

/** True when the turn may use a block: always for a general chat, per the profile otherwise. */
export function profileAllows(input: Pick<SendMessageInput, 'options'>, block: keyof ProfileBlocks): boolean {
  const id = input.options.profile
  if (!id) return true
  return (resolveProfile(id)?.blocks ?? NO_BLOCKS)[block]
}

/** True when the turn runs a profile (the blocks of a general chat are not all in play). */
export function isSpecialistTurn(input: Pick<SendMessageInput, 'options'>): boolean {
  return Boolean(input.options.profile)
}

/** The system prompt of a profile chat — and nothing else (no general blocks). */
export function profileSystemPrompt(profile: ProfileId, input: Pick<SendMessageInput, 'language'>): string {
  return resolveProfile(profile)?.systemPrompt(input) ?? ''
}

/** The craft's own tools, or null when the profile runs on the conversation's usual toolset. */
export function profileTools(profile: ProfileId, input: SendMessageInput, modelVision?: boolean): ToolSet | null {
  return resolveProfile(profile)?.tools?.(input, modelVision) ?? null
}

/** What this turn needs to know about the artifact: per turn, in the user message. */
export async function profileTurnBlock(profile: ProfileId, sessionId: string): Promise<string> {
  return (await resolveProfile(profile)?.turnBlock?.(sessionId)) ?? ''
}

/** The sections of the general prompt a profile also takes (none for a built-in craft). */
export function profileSections(profile: ProfileId): readonly string[] {
  return resolveProfile(profile)?.sections ?? []
}
