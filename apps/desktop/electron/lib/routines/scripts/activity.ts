import {
  MAX_SCRIPT_CHECKS_KEPT,
  MIN_FIRE_GAP_MS,
  SCRIPT_FAILING_AFTER,
  type ScriptActivity,
  type ScriptCheck,
} from '@shared/routines'

/**
 * Pure rules of a trigger script's life: when the next check is due, how a failure backs off,
 * and which fires are let through. No clock, no disk — the supervisor feeds them.
 */

export function emptyActivity(routineId: string): ScriptActivity {
  return { routineId, checks: [], failures: 0, nextCheckAt: 0, pending: [] }
}

export function isDue(activity: ScriptActivity, now: number): boolean {
  return now >= activity.nextCheckAt
}

/** Backoff: each consecutive failure doubles the wait, up to an hour (never below the interval). */
export function nextCheckAfter(now: number, everyMinutes: number, failures: number): number {
  const base = everyMinutes * 60_000
  if (failures === 0) return now + base
  return now + Math.max(base, Math.min(base * 2 ** failures, 60 * 60_000))
}

export function isFailing(activity: Pick<ScriptActivity, 'failures'>): boolean {
  return activity.failures >= SCRIPT_FAILING_AFTER
}

/**
 * Applies one finished check: records it, updates the backoff and lets through at most one
 * batch of fires per {@link MIN_FIRE_GAP_MS}. Returns the new activity and how many fires were
 * accepted (the rest were dropped as too soon, and the check says so).
 */
export function applyCheck(
  activity: ScriptActivity,
  outcome: { ok: true; fires: string[]; logs: string[] } | { ok: false; error: string; logs: string[] },
  now: number,
  everyMinutes: number,
): { activity: ScriptActivity; accepted: string[] } {
  let accepted: string[] = []
  let check: ScriptCheck
  if (outcome.ok) {
    const tooSoon = activity.lastFireAt !== undefined && now - activity.lastFireAt < MIN_FIRE_GAP_MS
    accepted = tooSoon ? [] : outcome.fires
    check = {
      at: now,
      ok: true,
      fired: accepted.length,
      ...(tooSoon && outcome.fires.length > 0 ? { error: 'Fire ignored: too soon after the last one.' } : {}),
      ...(outcome.logs.length > 0 ? { logs: outcome.logs } : {}),
    }
  } else {
    check = { at: now, ok: false, fired: 0, error: outcome.error, ...(outcome.logs.length > 0 ? { logs: outcome.logs } : {}) }
  }
  const failures = outcome.ok ? 0 : activity.failures + 1
  return {
    accepted,
    activity: {
      ...activity,
      checks: [...activity.checks, check].slice(-MAX_SCRIPT_CHECKS_KEPT),
      failures,
      nextCheckAt: nextCheckAfter(now, everyMinutes, failures),
      ...(accepted.length > 0 ? { lastFireAt: now, pending: [...activity.pending, ...accepted].slice(-5) } : {}),
    },
  }
}
