import type { NewRoutineInput, Routine, RoutineRun, ScriptActivity } from '@shared/routines'
import { isScriptTriggered, scriptFingerprint } from '@shared/routines'
import { readScriptRecord, removeScriptRecord } from './scripts/store'
import {
  addRoutine,
  listRoutines,
  listRuns,
  pruneRuns,
  removeRoutine,
  removeRoutineRuns,
  updateRoutine,
} from './repo'
import { emit, rotateChat, runNow, startScheduler, stopScheduler } from './scheduler'

/**
 * Routines facade: this is what the IPC consumes (same shape as
 * pipeline/index.ts). The scheduler handles execution; the CRUD lives here.
 */

export { generateRoutine } from './generator'
export { rotateChat, runNow, startScheduler, stopScheduler }

function newId(): string {
  return `rout_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Full snapshot so the UI can open the panel in one shot. What is running comes
 * from the runs themselves (status 'running'), which the scheduler writes before
 * firing — after a renderer reload the panel comes back with the right spinner
 * without asking anything else.
 */
export async function loadAll(): Promise<{ routines: Routine[]; runs: RoutineRun[]; activities: ScriptActivity[] }> {
  const [routines, runs] = await Promise.all([listRoutines(), listRuns()])
  // Only routines woken by a script have a check log worth sending.
  const activities = await Promise.all(
    routines.filter((r) => isScriptTriggered(r)).map(async (r) => (await readScriptRecord(r.id)).activity),
  )
  return { routines, runs, activities }
}

export async function createRoutine(input: NewRoutineInput): Promise<Routine> {
  const routine: Routine = {
    // A proposal approved in the conversation card already brought its own id —
    // that stable identity is what lets the card recognise the created routine.
    id: input.id ?? newId(),
    title: input.title.trim(),
    prompt: input.prompt.trim(),
    schedule: input.schedule,
    model: input.model,
    modes: input.modes,
    mode: input.mode ?? 'code',
    folders: [...input.folders],
    visionModel: input.visionModel,
    reuseChat: input.reuseChat,
    tokenBudget: input.tokenBudget,
    review: input.review,
    team: input.team,
    // A script only runs when the person approved this exact version: creating the routine from
    // the confirmation card (or the form) is that approval.
    scripts: input.scripts?.map((s) => ({ ...s, approvedFingerprint: scriptFingerprint(s) })),
    trigger: input.trigger,
    active: input.active ?? true,
    createdAt: Date.now(),
  }
  await addRoutine(routine)
  emit({ type: 'routine', routine })
  return routine
}

export async function updateRoutineFields(
  id: string,
  patch: Partial<Omit<Routine, 'id' | 'createdAt'>>,
): Promise<Routine | null> {
  const routine = await updateRoutine(id, (current) => ({ ...current, ...patch }))
  if (routine) emit({ type: 'routine', routine })
  return routine
}

/**
 * Removes the routine and the metrics of its executions. The CHATS of each
 * execution are deleted by the renderer before this call: the deleteSession
 * cascade (stream abort, storage, prefs, panel browser) lives in the
 * session-store, and duplicating it here would give two truths about the same
 * delete.
 */
export async function removeRoutineCompletely(id: string): Promise<void> {
  await removeRoutine(id)
  await removeRoutineRuns(id)
  await removeScriptRecord(id)
  emit({ type: 'routine-removed', id })
}

/** Drops the metrics of runs whose chat no longer exists. */
export function pruneOrphanRuns(liveSessionIds: string[]): Promise<number> {
  return pruneRuns(liveSessionIds)
}
