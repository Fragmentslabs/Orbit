import { parseRemoteSessionId, remoteSessionId } from "@shared/peers"

/**
 * Which machine the screens are reading from.
 *
 * The app has one set of screens (routines, pipeline, usage, chat list…). When the
 * environment selector points at another desktop, the same screens must show THAT
 * machine's data, so the data layer (`ipc.ts`) asks this module "who am I talking
 * to?" instead of every component branching on it.
 *
 * It lives apart from the peers store on purpose: `ipc.ts` is imported by the
 * store, and the store would otherwise import it back.
 */

let activePeer: string | null = null
const listeners = new Set<(peerId: string | null) => void>()

/** The paired desktop being used right now, or null for this computer. */
export function getActivePeer(): string | null {
  return activePeer
}

export function setActivePeer(peerId: string | null): void {
  if (peerId === activePeer) return
  activePeer = peerId
  for (const listener of listeners) listener(peerId)
}

/** Runs when the environment changes (selector, forgotten peer, reload). */
export function onActivePeerChange(listener: (peerId: string | null) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Session ids that come from a peer are namespaced; this puts one on a remote id. */
export function namespaced(peerId: string, sessionId: string): string {
  return parseRemoteSessionId(sessionId) ? sessionId : remoteSessionId(peerId, sessionId)
}
