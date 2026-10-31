import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Hook, HookInput, HookRun, HookWithRun } from '@shared/hooks'
import { HOOK_EVENTS, HOOK_MAX_TIMEOUT_MS, hookMatcher } from '@shared/hooks'
import { dataDir } from '../storage'

/**
 * Where the hooks live: Orbit's own data folder, never the repository. A hook runs
 * code on its own, so a `.orbit/hooks.json` that came with a cloned project would
 * run a stranger's commands the moment the folder opened. Here every hook was
 * written by the user, or by an agent whose card the user approved.
 *
 * The last run of each hook stays in memory only: it is what the list shows to
 * answer "why can't the agent commit?", and it is worth nothing after a restart.
 */

const HOOKS_FILE = 'hooks.json'

let hooks: Hook[] = []
const lastRuns = new Map<string, HookRun>()
let changed: (() => void) | undefined

function filePath(): string {
  return path.join(dataDir(), HOOKS_FILE)
}

function isHook(value: unknown): value is Hook {
  const h = value as Hook | null
  return (
    !!h &&
    typeof h.id === 'string' &&
    HOOK_EVENTS.includes(h.event) &&
    typeof h.match === 'string' &&
    typeof h.command === 'string' &&
    typeof h.enabled === 'boolean'
  )
}

export async function loadHooks(): Promise<void> {
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(filePath(), 'utf8'))
    hooks = Array.isArray(parsed) ? parsed.filter(isHook) : []
  } catch {
    hooks = []
  }
}

async function save(): Promise<void> {
  await fsp.mkdir(dataDir(), { recursive: true })
  await fsp.writeFile(filePath(), JSON.stringify(hooks, null, 2), 'utf8')
  changed?.()
}

/** The windows refresh their list when a hook is added from a chat. */
export function onHooksChanged(listener: () => void): void {
  changed = listener
}

/** Why the input is not a hook, or null when it is fine. */
export function validateHook(input: HookInput): string | null {
  if (!HOOK_EVENTS.includes(input.event)) return `unknown event "${String(input.event)}"`
  if (!input.command.trim()) return 'the command is empty'
  if (!hookMatcher(input.match)) return `"${input.match}" is not a valid regular expression`
  return null
}

function normalize(input: HookInput): HookInput {
  return {
    event: input.event,
    match: input.match.trim() || '*',
    command: input.command.trim(),
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    ...(input.directory ? { directory: path.resolve(input.directory) } : {}),
    ...(input.timeoutMs ? { timeoutMs: Math.min(Math.max(input.timeoutMs, 1_000), HOOK_MAX_TIMEOUT_MS) } : {}),
  }
}

export async function addHook(input: HookInput, createdBy: Hook['createdBy']): Promise<Hook> {
  const error = validateHook(input)
  if (error) throw new Error(error)
  const hook: Hook = { id: randomUUID().slice(0, 8), ...normalize(input), enabled: true, createdAt: Date.now(), createdBy }
  hooks.push(hook)
  await save()
  return hook
}

export async function updateHook(id: string, input: HookInput): Promise<Hook | null> {
  const error = validateHook(input)
  if (error) throw new Error(error)
  const index = hooks.findIndex((h) => h.id === id)
  if (index < 0) return null
  const { description: _d, directory: _p, timeoutMs: _t, ...kept } = hooks[index]
  // Edited on the screen = written by the user from here on.
  hooks[index] = { ...kept, ...normalize(input), createdBy: 'user' }
  lastRuns.delete(id)
  await save()
  return hooks[index]
}

export async function setHookEnabled(id: string, enabled: boolean): Promise<void> {
  const hook = hooks.find((h) => h.id === id)
  if (!hook || hook.enabled === enabled) return
  hook.enabled = enabled
  await save()
}

export async function removeHook(id: string): Promise<Hook | null> {
  const hook = hooks.find((h) => h.id === id)
  if (!hook) return null
  hooks = hooks.filter((h) => h.id !== id)
  lastRuns.delete(id)
  await save()
  return hook
}

export function getHook(id: string): Hook | undefined {
  return hooks.find((h) => h.id === id)
}

export function listHooks(): HookWithRun[] {
  return hooks.map((h) => ({ ...h, ...(lastRuns.has(h.id) ? { lastRun: lastRuns.get(h.id) } : {}) }))
}

export function noteHookRun(id: string, run: HookRun): void {
  lastRuns.set(id, run)
}

/** Enabled hooks of an event that apply to this tool in this folder (null = no folder). */
export function hooksFor(event: Hook['event'], toolName: string, directory: string | null): Hook[] {
  return hooks.filter((h) => {
    if (!h.enabled || h.event !== event) return false
    if (h.directory) {
      if (!directory) return false
      const rel = path.relative(h.directory, path.resolve(directory))
      if (rel.startsWith('..') || path.isAbsolute(rel)) return false
    }
    return hookMatcher(h.match)?.test(toolName) ?? false
  })
}

/** Test seam: replaces the in-memory list without touching the disk. */
export function __setHooksForTest(next: Hook[]): void {
  hooks = next
  lastRuns.clear()
}
