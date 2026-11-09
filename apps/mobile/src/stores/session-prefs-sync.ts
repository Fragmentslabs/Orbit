import type { SessionPrefsSnapshot } from '@orbit/shared'
import { useConnectionStore } from './connection-store'
import { useSessionReasoning } from './session-reasoning'
import { usePermissionPrefs } from './permission-prefs'

/**
 * Thinking and autonomy PER CHAT coming from the desktop. The desktop is the source of
 * truth: it pushes the whole snapshot on connect (GET /api/session-prefs) and on
 * every change (WS event 'session:prefs-change').
 *
 * `authoritative` separates the two cases, as in the per-chat modes — and both are
 * authoritative for the chats that already exist: the phone's own choices reach the
 * desktop through 'session:prefs-select' and come back, so what is in the snapshot is
 * richer than a local cache that can be weeks old. The draft stays local.
 */

/** The draft is per device — it never travels in either direction. */
const DRAFT_KEY = 'draft'

async function ensureHydrated(): Promise<void> {
  const pending: Promise<void>[] = []
  if (!useSessionReasoning.getState().hydrated) pending.push(useSessionReasoning.getState().hydrate())
  if (!usePermissionPrefs.getState().hydrated) pending.push(usePermissionPrefs.getState().hydrate())
  if (pending.length > 0) await Promise.all(pending)
}

function withoutDraft<T>(map: Record<string, T> | undefined): Record<string, T> {
  if (!map || typeof map !== 'object') return {}
  return Object.fromEntries(Object.entries(map).filter(([key]) => key !== DRAFT_KEY))
}

export function applyRemoteSessionPrefs(prefs: SessionPrefsSnapshot, authoritative: boolean): void {
  if (!prefs || typeof prefs !== 'object') return

  const reasoning = withoutDraft(prefs.reasoning)
  if (Object.keys(reasoning).length > 0) {
    useSessionReasoning.getState().applySync(reasoning, authoritative)
  } else if (authoritative) {
    // Empty map live = nobody chose anything there; here no override is
    // left either (every chat goes back to following the level of the model).
    useSessionReasoning.getState().applySync({}, true)
  }

  const permission = withoutDraft(prefs.permission)
  const permissionState = usePermissionPrefs.getState()
  for (const [sessionId, mode] of Object.entries(permission)) {
    if (permissionState.modes[sessionId] === mode) continue
    permissionState.applyRemoteMode(sessionId, mode)
  }
}

/** Desktop snapshot — called on connect. */
export async function fetchSessionPrefs(): Promise<void> {
  const { http } = useConnectionStore.getState()
  if (!http) return
  await ensureHydrated()
  try {
    const res = await http.getSessionPrefs()
    if (res.ok && res.data) applyRemoteSessionPrefs(res.data, true)
  } catch {
    // Offline — keeps what is already on the device.
  }
}
