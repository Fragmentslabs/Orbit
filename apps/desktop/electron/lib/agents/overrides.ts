import { AGENT_FORMAT_VERSION, BUILTIN_PROFILES, type BuiltinOverride } from '@shared/agents'
import { readJson, writeJson } from '../storage'
import { agentEvents } from './store'
import { sanitizeBuiltinOverride } from './validate'

/**
 * What the person changed in the built-in agents. A built-in is edited by layering a small
 * override over the definition that ships, never by copying it: the craft's tools and turn
 * context stay as shipped, and "restore default" is just deleting the override.
 */

const KEY = 'agent-overrides'

let cache: Record<string, BuiltinOverride> | null = null
let queue: Promise<unknown> = Promise.resolve()
const serialized = <T>(task: () => Promise<T>): Promise<T> => {
  const run = queue.then(task, task)
  queue = run.catch(() => undefined)
  return run
}

export async function loadOverrides(): Promise<Record<string, BuiltinOverride>> {
  if (cache) return cache
  const saved = await readJson<{ overrides?: Record<string, unknown> }>(KEY).catch(() => null)
  const raw = saved?.overrides && typeof saved.overrides === 'object' ? saved.overrides : {}
  cache = {}
  for (const id of BUILTIN_PROFILES) {
    const override = sanitizeBuiltinOverride(raw[id])
    if (Object.keys(override).length) cache[id] = override
  }
  return cache
}

/** Synchronous lookup for the engine; valid after `loadOverrides` (profileOf awaits it). */
export const getOverrideSync = (id: string): BuiltinOverride | undefined => cache?.[id]

async function persist(next: Record<string, BuiltinOverride>): Promise<void> {
  await writeJson(KEY, { version: AGENT_FORMAT_VERSION, overrides: next })
  cache = next
  agentEvents.emit('changed')
}

/** Replaces the override of a built-in. Unknown ids are refused. */
export function saveOverride(id: string, raw: unknown): Promise<boolean> {
  return serialized(async () => {
    if (!(BUILTIN_PROFILES as readonly string[]).includes(id)) return false
    const current = await loadOverrides()
    const override = sanitizeBuiltinOverride(raw)
    const next = { ...current }
    if (Object.keys(override).length) next[id] = override
    else delete next[id]
    await persist(next)
    return true
  })
}

export const resetOverride = (id: string): Promise<boolean> => saveOverride(id, {})

/** Test hook. */
export function resetOverrideCache(): void {
  cache = null
}
