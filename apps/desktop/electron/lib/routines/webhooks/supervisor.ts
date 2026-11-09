import { MIN_FIRE_GAP_MS, type Routine, type WebhookActivity } from '@shared/routines'
import type { SupervisorDeps } from '../scripts/supervisor'
import { readWebhookRecord, writeWebhookRecord } from './store'

/**
 * Turns the payloads the receiver accepted into runs, through the same `startRun` the script
 * triggers use. An accepted call is never dropped for being close to the previous one: it waits
 * in `pending` and the next drain hands everything that gathered to ONE run, once the fire gap
 * has passed and the routine is free.
 */

export type WebhookSupervisorDeps = Pick<SupervisorDeps, 'startRun' | 'isRunning'> & {
  onActivity(activity: WebhookActivity): void
}

/** Serializes the work on one routine's record: the receiver and the tick both write it. */
const chains = new Map<string, Promise<unknown>>()

export function withRoutineLock<T>(routineId: string, work: () => Promise<T>): Promise<T> {
  const run = (chains.get(routineId) ?? Promise.resolve()).then(work, work)
  chains.set(routineId, run.catch(() => undefined))
  return run
}

/** Starts a run with the waiting payloads when the routine may take them. Returns whether it did. */
export function drainWebhook(routine: Routine, deps: WebhookSupervisorDeps, now = Date.now()): Promise<boolean> {
  return withRoutineLock(routine.id, async () => {
    if (!routine.active || routine.trigger?.kind !== 'webhook') return false
    const record = await readWebhookRecord(routine.id)
    if (!record || record.activity.pending.length === 0) return false
    const { activity } = record
    if (activity.lastFireAt !== undefined && now - activity.lastFireAt < MIN_FIRE_GAP_MS) return false
    if (deps.isRunning(routine.id)) return false
    if ((await deps.startRun(routine, activity.pending)) === null) return false
    const next: WebhookActivity = { ...activity, pending: [], lastFireAt: now }
    await writeWebhookRecord(routine.id, { ...record, activity: next })
    deps.onActivity(next)
    return true
  })
}

export async function superviseWebhooks(routines: readonly Routine[], deps: WebhookSupervisorDeps, now = Date.now()): Promise<void> {
  await Promise.all(
    routines
      .filter((r) => r.active && r.trigger?.kind === 'webhook')
      .map((r) =>
        drainWebhook(r, deps, now).catch((err) => console.error(`[routines] webhook of "${r.title}" failed unexpectedly:`, err)),
      ),
  )
}
