import { shell } from 'electron'
import type { SessionInfo } from '@shared/chat'
import type { NewRoutineInput, Routine, RoutineRun, ScriptActivity } from '@shared/routines'
import { isScriptTriggered, scriptFingerprint } from '@shared/routines'
import { readScriptRecord, removeScriptRecord } from './scripts/store'
import { removeWebhookRecord } from './webhooks/store'
import {
  addRoutine,
  listRoutines,
  listRuns,
  pruneRuns,
  removeRoutine,
  removeRoutineRuns,
  updateRoutine,
} from './repo'
import { ensureRoutineChat, syncRunMessages } from './chat-session'
import { ensureRoutineFolder, readMemory } from './folder'
import { emit, runNow, startScheduler, stopScheduler } from './scheduler'

/**
 * Routines facade: this is what the IPC consumes (same shape as
 * pipeline/index.ts). The scheduler handles execution; the CRUD lives here.
 */

export { generateRoutine } from './generator'
export { runNow, startScheduler, stopScheduler }

/**
 * The routine's own chat — the one conversation that outlives the executions. Created on
 * first use, so a routine that never ran already has where to be talked to.
 */
export async function chatSession(id: string): Promise<SessionInfo | null> {
  const routine = (await listRoutines()).find((r) => r.id === id)
  if (!routine) return null
  const session = await ensureRoutineChat(routine)
  // Before the screen shows the conversation, every execution is already in it — including the
  // ones from before this chat existed. It is what makes each one readable (and reachable)
  // in the one scroll, instead of only in the list of the panel.
  const runs = (await listRuns()).filter((run) => run.routineId === id)
  await syncRunMessages(session.id, routine, runs).catch((err) =>
    console.error('[routines] could not sync the executions into the chat:', err),
  )
  return session
}

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
    folders: [...input.folders],
    visionModel: input.visionModel,
    agent: input.agent,
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
  // The routine's own folder (memory.md + scripts/) is created the first time it is needed —
  // a routine that only answers in the chat never writes anything. The `folders` are the extras
  // it may open and edit, not this one.
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
 * The routine's own folder, ensured on demand (routines created before it existed get one here).
 * What the edit dialog shows and the run reads.
 */
export async function routineFolderInfo(
  id: string,
): Promise<{ folder: string; memory: string; scripts: string[] } | null> {
  const routine = (await listRoutines()).find((r) => r.id === id)
  if (!routine) return null
  const folder = await ensureRoutineFolder(routine)
  if (folder !== routine.folder) await updateRoutineFields(routine.id, { folder })
  return { folder, memory: await readMemory(folder), scripts: (routine.scripts ?? []).map((s) => s.name) }
}

/** Opens the routine folder in the Finder. */
export async function openRoutineFolder(id: string): Promise<string | null> {
  const info = await routineFolderInfo(id)
  if (!info) return null
  const error = await shell.openPath(info.folder)
  return error || null
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
  await removeWebhookRecord(id)
  emit({ type: 'routine-removed', id })
}

/** Drops the metrics of runs whose chat no longer exists. */
export function pruneOrphanRuns(liveSessionIds: string[]): Promise<number> {
  return pruneRuns(liveSessionIds)
}
