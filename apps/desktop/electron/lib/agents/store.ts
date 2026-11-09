import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { AGENT_FORMAT_VERSION, AGENT_LIMITS, type AgentDefinition } from '@shared/agents'
import { readJson, writeJson } from '../storage'
import { agentInputProblem, sanitizeAgentInput } from './validate'

/**
 * The agents the person made. One small file under the app storage; the list is capped and
 * every record is validated on the way in AND on the way out, so a hand-edited or damaged
 * file can never put an invalid agent in front of the engine.
 *
 * The engine needs a synchronous lookup (the toolset is built synchronously), so the list is
 * cached in memory; `loadAgents` fills the cache and every write keeps it in step.
 */

const KEY = 'agents'
const SAFE_ID = /^[a-zA-Z0-9_-]{1,64}$/

export const agentEvents = new EventEmitter()

let cache: AgentDefinition[] | null = null
/** Serializes read-modify-write: two quick saves from the editor must not lose one another. */
let queue: Promise<unknown> = Promise.resolve()
const serialized = <T>(task: () => Promise<T>): Promise<T> => {
  const run = queue.then(task, task)
  queue = run.catch(() => undefined)
  return run
}

function revive(raw: unknown): AgentDefinition | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Partial<AgentDefinition>
  if (typeof record.id !== 'string' || !SAFE_ID.test(record.id)) return null
  const input = sanitizeAgentInput(record)
  if (agentInputProblem(input)) return null
  const now = Date.now()
  return {
    ...input,
    version: AGENT_FORMAT_VERSION,
    id: record.id,
    origin: record.origin === 'imported' ? 'imported' : 'user',
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : now,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : now,
  }
}

export async function loadAgents(): Promise<AgentDefinition[]> {
  if (cache) return cache
  const saved = await readJson<{ agents?: unknown[] }>(KEY).catch(() => null)
  const list = Array.isArray(saved?.agents) ? saved.agents : []
  cache = list
    .map(revive)
    .filter((a): a is AgentDefinition => a !== null)
    .slice(0, AGENT_LIMITS.agents)
  return cache
}

/** Synchronous lookup for the engine. Only valid after `loadAgents` (profileOf awaits it). */
/** Every saved agent, synchronously. Only valid after `loadAgents`. */
export const listAgentsSync = (): AgentDefinition[] => cache ?? []

export const getAgentSync = (id: string): AgentDefinition | null => cache?.find((a) => a.id === id) ?? null

async function persist(next: AgentDefinition[]): Promise<AgentDefinition[]> {
  await writeJson(KEY, { version: AGENT_FORMAT_VERSION, agents: next })
  cache = next
  agentEvents.emit('changed', next)
  return next
}

export type SaveResult = { ok: true; agent: AgentDefinition } | { ok: false; reason: 'name' | 'limit' | 'missing' }

/** Creates the agent (no `id`) or replaces the editable part of an existing one. */
export function saveAgent(raw: unknown, id?: string): Promise<SaveResult> {
  return serialized(async () => {
    const input = sanitizeAgentInput(raw)
    if (agentInputProblem(input)) return { ok: false, reason: 'name' }
    const list = await loadAgents()
    const now = Date.now()
    if (id !== undefined) {
      const existing = list.find((a) => a.id === id)
      if (!existing) return { ok: false, reason: 'missing' }
      const agent: AgentDefinition = { ...existing, ...input, allowedTools: input.allowedTools, craft: input.craft, defaultModel: input.defaultModel, thinking: input.thinking, updatedAt: now }
      await persist(list.map((a) => (a.id === id ? agent : a)))
      return { ok: true, agent }
    }
    if (list.length >= AGENT_LIMITS.agents) return { ok: false, reason: 'limit' }
    const agent: AgentDefinition = {
      ...input,
      version: AGENT_FORMAT_VERSION,
      id: `ag_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      origin: 'user',
      createdAt: now,
      updatedAt: now,
    }
    await persist([...list, agent])
    return { ok: true, agent }
  })
}

/** A copy with a new id; a duplicate is always the person's own, whatever the original was. */
export function duplicateAgent(id: string, copyLabel: string): Promise<SaveResult> {
  return serialized(async () => {
    const list = await loadAgents()
    const source = list.find((a) => a.id === id)
    if (!source) return { ok: false, reason: 'missing' }
    if (list.length >= AGENT_LIMITS.agents) return { ok: false, reason: 'limit' }
    const { id: _id, version: _version, origin: _origin, createdAt: _created, updatedAt: _updated, ...editable } = source
    const input = sanitizeAgentInput({ ...editable, name: `${source.name} ${copyLabel}` })
    const now = Date.now()
    const agent: AgentDefinition = {
      ...input,
      version: AGENT_FORMAT_VERSION,
      id: `ag_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      origin: 'user',
      createdAt: now,
      updatedAt: now,
    }
    await persist([...list, agent])
    return { ok: true, agent }
  })
}

export function removeAgent(id: string): Promise<boolean> {
  return serialized(async () => {
    const list = await loadAgents()
    if (!list.some((a) => a.id === id)) return false
    await persist(list.filter((a) => a.id !== id))
    return true
  })
}

/** Test hook: forget the cache so the next load reads the file again. */
export function resetAgentCache(): void {
  cache = null
}
