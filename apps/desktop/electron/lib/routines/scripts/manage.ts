import type { Routine, RoutineScript, ScriptTestResult } from '@shared/routines'
import { SECRET_NAME_PATTERN, scriptFingerprint, scriptRoots } from '@shared/routines'
import { listRoutines, updateRoutine } from '../repo'
import { emit } from '../scheduler'
import { runScript, type ScriptOutcome } from './runner'
import { readScriptRecord } from './store'

/** What an agent may write; the id and the approval are never its to set. */
export type ScriptDraft = Pick<RoutineScript, 'name' | 'summary' | 'code' | 'hosts' | 'readFiles' | 'secrets' | 'databases'>

/** Database paths as the script will ask for them: trimmed, no duplicates. */
export function cleanDatabases(paths: readonly string[] | undefined): string[] | undefined {
  const clean = [...new Set((paths ?? []).map((p) => p.trim()).filter(Boolean))]
  return clean.length > 0 ? clean : undefined
}

export function newScriptId(): string {
  return `scr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** A script name is how the agent calls it: letters, digits and underscores. */
export function validScriptName(name: string): boolean {
  return /^[a-z][a-z0-9_]{1,40}$/.test(name)
}

/** Hosts as bare domains, lower case, no duplicates. */
export function cleanHosts(hosts: readonly string[]): string[] {
  return [...new Set(hosts.map((h) => h.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean))]
}

/** Secret names a script asks for: valid, no duplicates; absent when none. */
export function cleanSecretNames(names: readonly string[] | undefined): string[] | undefined {
  const clean = [...new Set((names ?? []).map((n) => n.trim()).filter((n) => SECRET_NAME_PATTERN.test(n)))]
  return clean.length > 0 ? clean : undefined
}

/**
 * Adds or replaces a script of a routine BY AN AGENT. The approval is dropped on purpose: whatever
 * the agent wrote, the person has to look at it before it runs. Returns whether the script was
 * already approved before this change (so the agent can tell the person it needs a new approval).
 */
export async function saveScriptFromAgent(routineId: string, draft: ScriptDraft): Promise<{ ok: true; routine: Routine } | { ok: false; error: string }> {
  if (!validScriptName(draft.name)) return { ok: false, error: 'The script name must be lower case letters, digits and underscores.' }
  const updated = await updateRoutine(routineId, (routine) => {
    const scripts = routine.scripts ?? []
    const existing = scripts.find((s) => s.name === draft.name)
    const next: RoutineScript = {
      id: existing?.id ?? newScriptId(),
      name: draft.name,
      summary: draft.summary.trim(),
      code: draft.code,
      hosts: cleanHosts(draft.hosts),
      readFiles: draft.readFiles || undefined,
      secrets: cleanSecretNames(draft.secrets),
      databases: cleanDatabases(draft.databases),
      // approvedFingerprint stays out: a new or changed script waits for the person.
    }
    return { ...routine, scripts: existing ? scripts.map((s) => (s.id === existing.id ? next : s)) : [...scripts, next] }
  })
  if (!updated) return { ok: false, error: 'Routine not found.' }
  emit({ type: 'routine', routine: updated })
  return { ok: true, routine: updated }
}

/** The person approves the current version of a script (the UI calls this, never an agent). */
export async function approveScript(routineId: string, scriptId: string): Promise<Routine | null> {
  const updated = await updateRoutine(routineId, (routine) => ({
    ...routine,
    scripts: routine.scripts?.map((s) => (s.id === scriptId ? { ...s, approvedFingerprint: scriptFingerprint(s) } : s)),
  }))
  if (updated) emit({ type: 'routine', routine: updated })
  return updated
}

/** A run's outcome as a short text for the model. */
export function describeOutcome(outcome: ScriptOutcome): string {
  const logs = outcome.logs.length > 0 ? `\nLogs:\n${outcome.logs.join('\n')}` : ''
  if (!outcome.ok) return `The script failed: ${outcome.error}${logs}`
  const result = JSON.stringify(outcome.result)
  const fires = outcome.fires.length > 0 ? `\nIt would wake the routine ${outcome.fires.length} time(s) with: ${outcome.fires.join(' | ').slice(0, 1500)}` : '\nIt did not fire.'
  return `The script ran. Result: ${result.length > 6000 ? result.slice(0, 6000) + '… (cut)' : result}${fires}${logs}`
}

/**
 * The person tests a script from the screen. Nothing is kept and nothing is fired: the script
 * sees the memory it has now, may change it only inside this run, and its fires are just listed.
 * It runs even before approval, since the person is looking at its code and asked for it.
 */
export async function testScript(routineId: string, scriptId: string): Promise<ScriptTestResult> {
  const routine = (await listRoutines()).find((r) => r.id === routineId)
  const script = routine?.scripts?.find((s) => s.id === scriptId)
  if (!routine || !script) return { ok: false, error: 'Script not found.', logs: [] }
  const { state } = await readScriptRecord(routineId)
  const outcome = await runScript({ script, folders: scriptRoots(routine.folder, routine.folders), state })
  return outcome.ok
    ? { ok: true, result: outcome.result, fires: outcome.fires, logs: outcome.logs }
    : { ok: false, error: outcome.error, logs: outcome.logs }
}

/** Removes a script. The one that triggers the routine stays: without it the routine would have no way to run. */
export async function removeScript(routineId: string, scriptId: string): Promise<Routine | null> {
  const updated = await updateRoutine(routineId, (routine) => {
    const triggerId = routine.trigger?.kind === 'script' ? routine.trigger.scriptId : undefined
    if (scriptId === triggerId) return routine
    const scripts = routine.scripts?.filter((s) => s.id !== scriptId)
    return { ...routine, scripts: scripts?.length ? scripts : undefined }
  })
  if (updated) emit({ type: 'routine', routine: updated })
  return updated
}
