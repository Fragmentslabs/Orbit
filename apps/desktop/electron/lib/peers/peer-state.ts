import { safeStorage } from 'electron'
import type { CompanionHttp } from '@orbit/companion-client'
import type { KnownPeer, PeerGrants, PeersEvent } from '@shared/peers'
import { writeJson } from '../storage'
import type { PeerIdentity } from './identity'
import type { PeerConnection } from './peer-connection'

/**
 * What the peer-client modules share: the identity, the renderer hooks, the paired
 * desktops as stored on disk (with their tokens encrypted) and one live connection each.
 */

export const KNOWN_KEY = 'peers/known'

export interface StoredPeer {
  peerId: string
  name: string
  host: string
  port: number
  /** PEM of its certificate — the only one trusted for this peer. */
  cert: string
  /** Our device token on that machine, encrypted with the OS keychain when available. */
  token: string
  tokenEnc: 'safe' | 'plain'
  grants: PeerGrants
  pairedAt: number
}

export interface PeerHooks {
  emit: (event: PeersEvent) => void
  changed: () => void
}

export const ctx = {
  identity: null as PeerIdentity | null,
  hooks: null as PeerHooks | null,
  selfName: () => 'Orbit',
  stored: [] as StoredPeer[],
  connections: new Map<string, PeerConnection>(),
  /** REST client per peer — the same `CompanionHttp` the phone uses, over pinned TLS. */
  httpClients: new Map<string, CompanionHttp>(),
}

export type PeerError = KnownPeer['error']

export function encryptToken(token: string): Pick<StoredPeer, 'token' | 'tokenEnc'> {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { token: safeStorage.encryptString(token).toString('base64'), tokenEnc: 'safe' }
    }
  } catch {
    /* falls back to the file's own 0600 permission */
  }
  return { token, tokenEnc: 'plain' }
}

export function decryptToken(peer: StoredPeer): string | null {
  try {
    return peer.tokenEnc === 'safe' ? safeStorage.decryptString(Buffer.from(peer.token, 'base64')) : peer.token
  } catch {
    return null
  }
}

export async function persist(): Promise<void> {
  await writeJson(KNOWN_KEY, ctx.stored)
}
