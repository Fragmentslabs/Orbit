import type { FolderInfo, SessionInfo } from '@shared/chat'
import { isPeerId } from '@shared/peers'
import { readJson, removeJson, writeJson } from '../storage'

/**
 * The last sessions + folders list of each paired desktop, kept on disk so a cold
 * start shows the remote sidebar before the socket authenticates. The first
 * `loadInitial` after connecting replaces it.
 */

export interface PeerListSnapshot {
  sessions: SessionInfo[]
  folders: FolderInfo[]
}

const SAVE_DEBOUNCE_MS = 1500
const timers = new Map<string, ReturnType<typeof setTimeout>>()

const keyOf = (peerId: string) => `peers/lists/${peerId}`

export async function loadPeerLists(peerId: string): Promise<PeerListSnapshot | null> {
  if (!isPeerId(peerId)) return null
  try {
    const raw = await readJson<Partial<PeerListSnapshot>>(keyOf(peerId))
    if (!raw) return null
    return {
      sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
      folders: Array.isArray(raw.folders) ? raw.folders : [],
    }
  } catch {
    return null
  }
}

/** Debounced: session events arrive in bursts, one write is enough. */
export function savePeerLists(peerId: string, snapshot: () => PeerListSnapshot): void {
  if (!isPeerId(peerId) || timers.has(peerId)) return
  timers.set(
    peerId,
    setTimeout(() => {
      timers.delete(peerId)
      void writeJson(keyOf(peerId), snapshot()).catch(() => {})
    }, SAVE_DEBOUNCE_MS),
  )
}

export async function forgetPeerLists(peerId: string): Promise<void> {
  const timer = timers.get(peerId)
  if (timer) clearTimeout(timer)
  timers.delete(peerId)
  if (isPeerId(peerId)) await removeJson(keyOf(peerId)).catch(() => {})
}
