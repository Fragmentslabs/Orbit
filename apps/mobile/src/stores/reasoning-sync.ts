import type { ReasoningPrefsMap } from '@orbit/shared'
import { useConnectionStore } from '~/stores/connection-store'
import { useReasoningPrefsStore } from '~/stores/reasoning-prefs'

/**
 * Thinking per model coming from the desktop (toggle + variant). The desktop is the
 * source of truth: it pushes the whole map on connect (GET
 * /api/reasoning-prefs) and on every change (WS event 'reasoning:change').
 *
 * `authoritative` separates the two cases, as in session-modes-sync: in the
 * connect snapshot the choice made on the phone wins (only keys the
 * mobile does not have enter); in the live event the desktop has just changed, so it
 * overwrites.
 */
export async function applyReasoningPrefs(
  remote: ReasoningPrefsMap,
  authoritative: boolean,
): Promise<void> {
  // The live event may arrive before the local hydration (which reads the storage
  // of the device): applying it straight would erase a toggle made offline. It hydrates
  // first — it is idempotent and the connect also goes through here.
  if (!useReasoningPrefsStore.getState().hydrated) {
    await useReasoningPrefsStore.getState().hydrate()
  }
  useReasoningPrefsStore.getState().applySync(remote, !authoritative)
}

/** Snapshot of the thinking per model of the desktop — called on connect. */
export async function fetchReasoningPrefs(): Promise<void> {
  const { http } = useConnectionStore.getState()
  if (!http) return
  if (!useReasoningPrefsStore.getState().hydrated) {
    await useReasoningPrefsStore.getState().hydrate()
  }
  try {
    const res = await http.getReasoningPrefs()
    if (res.ok && res.data) {
      const prefs = (res.data as { prefs?: ReasoningPrefsMap }).prefs
      if (prefs) await applyReasoningPrefs(prefs, false)
    }
  } catch {
    // Offline — keeps what is already on the device.
  }
}
