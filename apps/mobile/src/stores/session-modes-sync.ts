import type { SessionModeOverrides } from '@orbit/shared'
import { useConnectionStore } from '~/stores/connection-store'
import { useModeOverrides, type OverridableMode } from '~/stores/mode-overrides'
import { useSimplePrefs } from '~/stores/simple-prefs'
import { useBrainPrefs } from '~/stores/brain-prefs'

/**
 * Active modes per chat coming from the desktop (research, browser, plan,
 * subagents, orchestration, vision, simple and brain). The desktop is the source of
 * truth: it pushes the whole map on connect (GET /api/session-modes) and on every
 * change (WS event 'session:mode-change').
 *
 * `authoritative` separates the two cases, and BOTH are authoritative for the chats
 * that already exist: the desktop is the source of truth of the per-chat modes, so on
 * connect its snapshot replaces the local one (only the draft, which is a different
 * new chat in each device, stays). Before, the phone's copy won the snapshot and a chat
 * whose mode was switched on in the desktop opened off here; the phone's own toggles
 * reach the desktop through 'modes:select' and come back in the snapshot.
 */

const MODE_OVERRIDE_KEYS: OverridableMode[] = [
  'search',
  'browser',
  'plan',
  'subagents',
  'orchestra',
  'vision',
]

/** The draft is per device: "draft" on the desktop is a different chat from "draft" on
 *  the phone, so that key never travels (neither from here nor from there). */
const DRAFT_KEY = 'draft'

function sameMap(a: Record<string, boolean | undefined>, b: Record<string, boolean>): boolean {
  const aKeys = Object.keys(a).filter((k) => a[k] !== undefined)
  const bKeys = Object.keys(b)
  return aKeys.length === bKeys.length && bKeys.every((k) => a[k] === b[k])
}

/** Merges a map sessionId → active; returns null when nothing changed.
 *
 *  In the live event the desktop map replaces the local one (that is the only way a mode
 *  switched off there, which disappears from the map, also disappears here); in the connect
 *  snapshot it only fills in what is missing, so as not to undo a choice made on the phone. */
function merge(
  local: Record<string, boolean | undefined>,
  remote: Record<string, boolean> | undefined,
  authoritative: boolean,
): Record<string, boolean> | null {
  if (!remote || typeof remote !== 'object') return null

  if (authoritative) {
    const next: Record<string, boolean> = {}
    for (const [sessionId, value] of Object.entries(remote)) {
      if (sessionId === DRAFT_KEY || typeof value !== 'boolean') continue
      next[sessionId] = value
    }
    const draft = local[DRAFT_KEY]
    if (draft !== undefined) next[DRAFT_KEY] = draft
    return sameMap(local, next) ? null : next
  }

  const next = { ...local }
  let changed = false
  for (const [sessionId, value] of Object.entries(remote)) {
    if (sessionId === DRAFT_KEY || typeof value !== 'boolean') continue
    if (next[sessionId] !== undefined) continue
    next[sessionId] = value
    changed = true
  }
  return changed ? (next as Record<string, boolean>) : null
}

export function applyRemoteModes(remote: SessionModeOverrides, authoritative: boolean): void {
  if (!remote || typeof remote !== 'object') return

  const modeState = useModeOverrides.getState()
  const modeMap = { ...modeState.overrides }
  let modesChanged = false
  for (const mode of MODE_OVERRIDE_KEYS) {
    const merged = merge(modeMap[mode] ?? {}, remote[mode], authoritative)
    if (merged) {
      modeMap[mode] = merged
      modesChanged = true
    }
  }
  if (modesChanged) modeState.applySync(modeMap)

  const simpleState = useSimplePrefs.getState()
  const simple = merge(simpleState.overrides, remote.simple, authoritative)
  if (simple) simpleState.applySync(simple)

  const brainState = useBrainPrefs.getState()
  const brain = merge(brainState.overrides, remote.brain, authoritative)
  if (brain) brainState.applySync(brain)
}

/** The connect may arrive before the hydration of the stores; applying the snapshot
 *  over a still empty state would make the next hydration undo everything. */
async function ensureHydrated(): Promise<void> {
  const pending: Promise<void>[] = []
  if (!useModeOverrides.getState().hydrated) pending.push(useModeOverrides.getState().hydrate())
  if (!useSimplePrefs.getState().hydrated) pending.push(useSimplePrefs.getState().hydrate())
  if (!useBrainPrefs.getState().hydrated) pending.push(useBrainPrefs.getState().hydrate())
  if (pending.length > 0) await Promise.all(pending)
}

/** Snapshot of the per-chat modes of the desktop — called on connect. */
export async function fetchSessionModes(): Promise<void> {
  const { http } = useConnectionStore.getState()
  if (!http) return
  await ensureHydrated()
  try {
    const res = await http.getSessionModes()
    if (res.ok && res.data) {
      const remote = (res.data as { overrides?: SessionModeOverrides }).overrides
      if (remote) applyRemoteModes(remote, true)
    }
  } catch {
    // Offline — keeps what is already on the device.
  }
}
