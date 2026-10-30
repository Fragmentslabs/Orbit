import type { SessionInfo } from './chat'

/**
 * Archiving and deletion of archived conversations.
 *
 * Every change of `archived` goes through `setArchivedState`, so that `archivedAt`
 * follows: it is from it that the automatic deletion counts the deadline, and not from
 * `updatedAt` — archiving by hand a conversation that has been idle for months cannot make it
 * vanish on the spot.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** The session with archiving on/off; `archivedAt` follows. */
export function setArchivedState<T extends SessionInfo>(session: T, archived: boolean, now = Date.now()): T {
  if (session.archived === archived) return session
  return { ...session, archived, archivedAt: archived ? now : null }
}

export interface ArchivedCleanupPlan {
  /** Archived for longer than the deadline: they can be deleted. */
  expired: SessionInfo[]
  /**
   * Archived before `archivedAt` existed: the deadline starts now (they get the
   * current date), instead of going away at once as soon as the option is turned on.
   */
  undated: SessionInfo[]
}

/**
 * What the automatic cleanup does with archived conversations. Left out are the
 * pinned ones, the ones that are answering and the orchestration workers (they
 * go away with the orchestrator, in the deletion cascade).
 */
export function planArchivedCleanup(
  sessions: SessionInfo[],
  days: number,
  now: number,
  running: ReadonlySet<string>,
): ArchivedCleanupPlan {
  const cutoff = now - days * DAY_MS
  const expired: SessionInfo[] = []
  const undated: SessionInfo[] = []
  for (const s of sessions) {
    if (!s.archived || s.pinned || s.parentId || running.has(s.id)) continue
    if (typeof s.archivedAt !== 'number') undated.push(s)
    else if (s.archivedAt <= cutoff) expired.push(s)
  }
  return { expired, undated }
}
