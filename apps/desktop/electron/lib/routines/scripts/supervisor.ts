import type { Routine, ScriptActivity } from '@shared/routines'
import { scriptApproved, triggerScript } from '@shared/routines'
import { applyCheck, isDue, isFailing } from './activity'
import { runScript } from './runner'
import { readScriptRecord, writeScriptRecord } from './store'

/**
 * Keeps the trigger scripts of the active routines running. The scheduler calls it on every tick;
 * a check only happens when its interval (or its backoff) says it is due. The script is free: the
 * agent runs only when a check fires, through `startRun` — which the scheduler provides, so a busy
 * routine just keeps the fire waiting for the next tick.
 */

export interface SupervisorDeps {
  /** Starts an execution with the fired payloads; null = it could not start right now. */
  startRun(routine: Routine, payloads: string[]): Promise<string | null>
  /** The routine is running (an execution has not finished). */
  isRunning(routineId: string): boolean
  onActivity(activity: ScriptActivity): void
  /** The script crossed into "failing": tell the person once. */
  onFailing(routine: Routine, error: string): void
}

/** Checks in flight: a slow script is never started twice. */
const checking = new Set<string>()

export async function superviseScripts(routines: readonly Routine[], deps: SupervisorDeps, now = Date.now()): Promise<void> {
  await Promise.all(
    routines.map(async (routine) => {
      const script = triggerScript(routine)
      if (!routine.active || routine.trigger?.kind !== 'script' || !script || !scriptApproved(script)) return
      if (checking.has(routine.id)) return
      checking.add(routine.id)
      try {
        await superviseOne(routine, script, routine.trigger.everyMinutes, deps, now)
      } catch (err) {
        console.error(`[routines] script of "${routine.title}" failed unexpectedly:`, err)
      } finally {
        checking.delete(routine.id)
      }
    }),
  )
}

async function superviseOne(
  routine: Routine,
  script: NonNullable<ReturnType<typeof triggerScript>>,
  everyMinutes: number,
  deps: SupervisorDeps,
  now: number,
): Promise<void> {
  const record = await readScriptRecord(routine.id)
  let { activity } = record
  let { state } = record

  // Fires the routine could not take earlier (it was busy) go first.
  if (activity.pending.length > 0 && !deps.isRunning(routine.id)) {
    if ((await deps.startRun(routine, activity.pending)) !== null) {
      activity = { ...activity, pending: [] }
      await writeScriptRecord(routine.id, { state, activity })
      deps.onActivity(activity)
    }
  }

  if (!isDue(activity, now)) return
  const wasFailing = isFailing(activity)
  const outcome = await runScript({ script, folders: routine.folders, state })
  const applied = applyCheck(
    activity,
    outcome.ok ? { ok: true, fires: outcome.fires, logs: outcome.logs } : { ok: false, error: outcome.error, logs: outcome.logs },
    now,
    everyMinutes,
  )
  activity = applied.activity
  // A failed check keeps the old memory: half of its work must not count as done.
  if (outcome.ok) state = outcome.state
  await writeScriptRecord(routine.id, { state, activity })
  deps.onActivity(activity)
  if (!wasFailing && isFailing(activity) && !outcome.ok) deps.onFailing(routine, outcome.error)

  if (applied.accepted.length > 0 && !deps.isRunning(routine.id)) {
    if ((await deps.startRun(routine, activity.pending)) !== null) {
      activity = { ...activity, pending: [] }
      await writeScriptRecord(routine.id, { state, activity })
      deps.onActivity(activity)
    }
  }
}
