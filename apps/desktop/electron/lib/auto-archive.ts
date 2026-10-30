import { setArchivedState } from '@shared/archive'
import { StorageKeys, type SessionInfo } from '@shared/chat'
import { getAppSettings, onAppSettingsChange } from './app-settings'
import { getRunningSessionIds } from './chat-engine'
import { broadcastSessionEvent } from './companion-server'
import { listKeys, readJson, writeJson } from './storage'

/**
 * Automatic archiving of inactive conversations (Preferences → General).
 *
 * Archiving is reversible: the conversation leaves the main list and goes to
 * the archived group, with its folder preserved. Left out are what the user
 * marked to stay (pinned), what is not one of their conversations (routine
 * executions and orchestration sub-sessions) and what is answering right now.
 */

const DAY_MS = 24 * 60 * 60 * 1000
const INTERVAL_MS = 6 * 60 * 60 * 1000

export function staleSessions(
  sessions: SessionInfo[],
  days: number,
  now: number,
  running: ReadonlySet<string>,
): SessionInfo[] {
  const cutoff = now - days * DAY_MS
  return sessions.filter(
    (s) =>
      !s.archived &&
      !s.pinned &&
      !s.routineId &&
      !s.parentId &&
      !running.has(s.id) &&
      s.updatedAt < cutoff,
  )
}

export async function archiveInactiveSessions(now = Date.now()): Promise<number> {
  const days = getAppSettings().autoArchiveDays
  if (!days) return 0
  const keys = await listKeys(StorageKeys.sessionPrefix)
  const sessions = (await Promise.all(keys.map((k) => readJson<SessionInfo>(k)))).filter(
    (s): s is SessionInfo => s != null,
  )
  const stale = staleSessions(sessions, days, now, new Set(getRunningSessionIds()))
  for (const session of stale) {
    // updatedAt stays as it was: archiving is not activity, and touching it
    // would reorder the archived list.
    const next = setArchivedState(session, true, now)
    await writeJson(StorageKeys.session(session.id), next)
    broadcastSessionEvent({ type: 'session', sessionId: session.id, session: next })
  }
  if (stale.length > 0) console.log(`[auto-archive] ${stale.length} inactive conversation(s) archived`)
  return stale.length
}

export function setupAutoArchive(): void {
  const run = () => void archiveInactiveSessions().catch((err) => console.error('[auto-archive] failed:', err))
  setInterval(run, INTERVAL_MS)
  // Turning the option on (or shortening the window) counts right away, not only on the next round.
  onAppSettingsChange((next, prev) => {
    if (next.autoArchiveDays && next.autoArchiveDays !== prev.autoArchiveDays) run()
  })
  run()
}
