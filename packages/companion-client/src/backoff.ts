/**
 * Reconnection backoff policy — one place for the delay curve, shared by the phone
 * and the desktop-to-desktop client.
 */

export interface BackoffPolicy {
  /** Delay of the first retry; doubles on each failed attempt. */
  baseMs: number
  /** Ceiling of the delay. */
  maxMs: number
  /** Failed attempts before giving up. `Infinity` never gives up (desktop peers). */
  maxAttempts: number
}

/** Delay before retry number `attempt` (0-based): base · 2^attempt, capped at max. */
export function backoffDelay(attempt: number, policy: BackoffPolicy): number {
  return Math.min(policy.baseMs * Math.pow(2, Math.min(attempt, 30)), policy.maxMs)
}

export function exhausted(attempt: number, policy: BackoffPolicy): boolean {
  return attempt >= policy.maxAttempts
}
