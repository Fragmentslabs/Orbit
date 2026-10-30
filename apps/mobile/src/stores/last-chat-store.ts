import { Storage } from '~/lib/storage'

/**
 * Last chat opened on the device. When reopening the app (or reconnecting), the initial
 * route goes back to it instead of falling into a new chat — the `activeSessionId`
 * of the session-store is only memory and died with the process.
 */

const LAST_SESSION_KEY = 'orbit_last_session'

/** null (new chat opened) clears the key. */
export async function saveLastSessionId(sessionId: string | null): Promise<void> {
  try {
    if (sessionId) await Storage.setItem(LAST_SESSION_KEY, sessionId)
    else await Storage.removeItem(LAST_SESSION_KEY)
  } catch {
    // Persistence is opportunistic.
  }
}

export async function loadLastSessionId(): Promise<string | null> {
  try {
    const raw = await Storage.getItem(LAST_SESSION_KEY)
    return raw || null
  } catch {
    return null
  }
}
