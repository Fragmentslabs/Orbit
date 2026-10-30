import type { PermissionMode } from '@shared/chat'

/**
 * Autonomy level per chat. The renderer is the source of truth (each chat's
 * choice lives in its localStorage) and pushes the map on every change; the
 * phone also travels through here, in the same snapshot.
 *
 * There used to be ONE global mode: switching to Full in one chat loosened them
 * all, including turns already running in other chats. Now each session reads its
 * own level — turns started by the selector (`options.followGlobalPermission`)
 * keep reading it on every tool, so switching in the middle of a response still
 * brakes/frees the next action, but only in that chat.
 */

/** Last published level — fallback for whoever has no entry in the map yet. */
let latest: PermissionMode | null = null

const perSession = new Map<string, PermissionMode>()

function isMode(value: unknown): value is PermissionMode {
  return value === 'ask' || value === 'approve' || value === 'full'
}

export function setGlobalMode(mode: PermissionMode | undefined): void {
  if (isMode(mode)) latest = mode
}

/** Map sessionId → level, pushed by the renderer on every change. The key
 *  'draft' is per device and does not enter. */
export function setSessionModes(modes: Record<string, PermissionMode> | null | undefined): void {
  perSession.clear()
  if (!modes) return
  for (const [sessionId, mode] of Object.entries(modes)) {
    if (sessionId === 'draft' || !isMode(mode)) continue
    perSession.set(sessionId, mode)
  }
}

/** Level of the session; `initial` while nobody has published anything for it. */
export function globalMode(sessionId: string | undefined, initial: PermissionMode): PermissionMode {
  const fromSession = sessionId ? perSession.get(sessionId) : undefined
  return fromSession ?? latest ?? initial
}
