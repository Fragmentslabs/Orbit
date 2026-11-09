import { randomUUID } from 'node:crypto'
import {
  AGENT_FORMAT_VERSION,
  EPHEMERAL_LIMITS,
  emptyAgentInput,
  type AgentDefinition,
  type AgentInput,
  type EphemeralAgent,
} from '@shared/agents'
import { readJson, writeJson } from '../storage'
import { agentEvents, getAgentSync, saveAgent, type SaveResult } from './store'
import { agentInputProblem, sanitizeAgentInput } from './validate'

/**
 * Temporary agents: the ones an orchestrator defines for the tasks of one plan.
 *
 * They are kept apart from the person's agents on purpose. Nothing here is listed, suggested or
 * written to the agents file; "Save as agent" is the only way across and goes through the normal
 * store and validation. The prompt of an agent speaks with system authority, so the rules are
 * stricter than for an agent the person wrote:
 *  - only the orchestrator's `define_agent` tool calls `defineEphemeral` (nothing reads a
 *    definition from a tool result, a web page or the renderer);
 *  - it can only narrow: no craft, pinned skills, model, borrowed sections or features (the
 *    worker's modes come from its task, within the orchestrator's own ceiling);
 *  - a short prompt, a handful per chat, a global cap, and old ones expire.
 */

const KEY = 'agents-ephemeral'
const DAY = 86_400_000

let cache: EphemeralAgent[] | null = null
let queue: Promise<unknown> = Promise.resolve()
const serialized = <T>(task: () => Promise<T>): Promise<T> => {
  const run = queue.then(task, task)
  queue = run.catch(() => undefined)
  return run
}

/** What a stored or incoming definition may be: the input, narrowed to the temporary rules. */
export function ephemeralInput(raw: unknown): AgentInput {
  const input = sanitizeAgentInput(raw)
  return {
    name: input.name,
    icon: input.icon,
    prompt: input.prompt.slice(0, EPHEMERAL_LIMITS.prompt),
    whenToUse: '',
    pinnedSkills: [],
    // Every switch off: what a worker may do comes from its task, never from its agent.
    features: emptyAgentInput().features,
    ...(input.allowedTools ? { allowedTools: input.allowedTools.slice(0, EPHEMERAL_LIMITS.allowedTools) } : {}),
  }
}

function revive(raw: unknown): EphemeralAgent | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<EphemeralAgent>
  if (typeof r.id !== 'string' || !/^eph_[a-f0-9]{16}$/.test(r.id) || typeof r.ownerSessionId !== 'string') return null
  const input = ephemeralInput(r.input)
  if (agentInputProblem(input) || !input.prompt.trim()) return null
  return {
    id: r.id,
    ownerSessionId: r.ownerSessionId.slice(0, 120),
    input,
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
    ...(typeof r.savedAs === 'string' ? { savedAs: r.savedAs } : {}),
  }
}

export async function loadEphemeral(): Promise<EphemeralAgent[]> {
  if (cache) return cache
  const saved = await readJson<{ agents?: unknown[] }>(KEY).catch(() => null)
  const cutoff = Date.now() - EPHEMERAL_LIMITS.keepDays * DAY
  cache = (Array.isArray(saved?.agents) ? saved.agents : [])
    .map(revive)
    .filter((a): a is EphemeralAgent => a !== null && a.createdAt >= cutoff)
    .slice(-EPHEMERAL_LIMITS.total)
  return cache
}

export const listEphemeralSync = (): EphemeralAgent[] => cache ?? []

async function persist(next: EphemeralAgent[]): Promise<void> {
  await writeJson(KEY, { agents: next })
  cache = next
  agentEvents.emit('changed')
}

export type DefineResult = { ok: true; agent: EphemeralAgent } | { ok: false; reason: 'name' | 'prompt' | 'limit' }

/** Defines a temporary agent for the chat that orchestrates. Called by the orchestrator's tool only. */
export function defineEphemeral(ownerSessionId: string, raw: unknown): Promise<DefineResult> {
  return serialized(async () => {
    const input = ephemeralInput(raw)
    if (agentInputProblem(input)) return { ok: false, reason: 'name' }
    if (!input.prompt.trim()) return { ok: false, reason: 'prompt' }
    const list = await loadEphemeral()
    if (list.filter((a) => a.ownerSessionId === ownerSessionId && !a.savedAs).length >= EPHEMERAL_LIMITS.perSession) {
      return { ok: false, reason: 'limit' }
    }
    const agent: EphemeralAgent = {
      id: `eph_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      ownerSessionId,
      input,
      createdAt: Date.now(),
    }
    await persist([...list, agent].slice(-EPHEMERAL_LIMITS.total))
    return { ok: true, agent }
  })
}

/** The temporary agents defined by this chat that are still unsaved. */
export const ephemeralOf = (ownerSessionId: string): EphemeralAgent[] =>
  listEphemeralSync().filter((a) => a.ownerSessionId === ownerSessionId && !a.savedAs)

/** True when `id` (an agent id, without the `agent:` prefix) is a temporary agent of this chat. */
export const isEphemeralOf = (ownerSessionId: string, id: string): boolean => ephemeralOf(ownerSessionId).some((a) => a.id === id)

/**
 * The agent a temporary id stands for, as a definition the engine can run: the saved agent once
 * it was saved (chats already running it keep working), otherwise the temporary one itself.
 */
export function resolveEphemeralSync(id: string): AgentDefinition | null {
  const found = listEphemeralSync().find((a) => a.id === id)
  if (!found) return null
  if (found.savedAs) return getAgentSync(found.savedAs)
  return {
    ...found.input,
    version: AGENT_FORMAT_VERSION,
    id: found.id,
    origin: 'user',
    createdAt: found.createdAt,
    updatedAt: found.createdAt,
  }
}

/** "Save as agent": copies it into the person's agents through the normal store and validation. */
export function saveEphemeral(id: string): Promise<SaveResult> {
  return serialized(async () => {
    const list = await loadEphemeral()
    const found = list.find((a) => a.id === id)
    if (!found) return { ok: false, reason: 'missing' }
    if (found.savedAs) {
      const existing = getAgentSync(found.savedAs)
      if (existing) return { ok: true, agent: existing }
    }
    const saved = await saveAgent(found.input)
    if (saved.ok) await persist(list.map((a) => (a.id === id ? { ...a, savedAs: saved.agent.id } : a)))
    return saved
  })
}

/** Test hook. */
export function resetEphemeralCache(): void {
  cache = null
}
