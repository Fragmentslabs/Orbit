import { CompanionHttp } from '@orbit/companion-client'
import type { MediaEntry, MediaUsage } from '@shared/media'
import { isPeerId, normalizeGrants, type KnownPeer, type PeerGrants, type PeerRunningItem } from '@shared/peers'
import { readJson } from '../storage'
import type { PeerIdentity } from './identity'
import { forgetPeerAssets, rememberRemoteId } from './remote-index'
import { peerFetch } from './peer-http'
import { forgetPeerLists } from './peer-list-cache'
import { PeerConnection } from './peer-connection'
import { ctx, decryptToken, KNOWN_KEY, persist, type PeerHooks, type StoredPeer } from './peer-state'

export { cancelPairing, outgoingState, startPairing } from './peer-pairing-out'

/**
 * The desktops THIS machine paired with: the public surface of the peer client. Each
 * one has a `PeerConnection` (pinned WSS on the shared connection core); the REST
 * client is the same `CompanionHttp` the phone uses, over pinned TLS.
 */

export async function initPeerClient(input: { identity: PeerIdentity; selfName: () => string; hooks: PeerHooks }): Promise<void> {
  ctx.identity = input.identity
  ctx.selfName = input.selfName
  ctx.hooks = input.hooks
  const raw = (await readJson<StoredPeer[]>(KNOWN_KEY)) ?? []
  ctx.stored = raw.filter((p) => isPeerId(p.peerId) && typeof p.cert === 'string' && typeof p.host === 'string')
  for (const peer of ctx.stored) {
    const conn = new PeerConnection(peer)
    ctx.connections.set(peer.peerId, conn)
    conn.connect()
    // The sidebar of that machine shows what it had last time, before the socket authenticates.
    void conn.restoreLists()
  }
}

export function knownPeers(): KnownPeer[] {
  return ctx.stored.map((p) => {
    const conn = ctx.connections.get(p.peerId)
    return {
      peerId: p.peerId,
      name: p.name,
      host: p.host,
      port: p.port,
      grants: normalizeGrants(p.grants),
      pairedAt: p.pairedAt,
      online: conn?.online ?? false,
      ...(conn?.error ? { error: conn.error } : {}),
    }
  })
}

export function runningOnPeers(): PeerRunningItem[] {
  return [...ctx.connections.values()].flatMap((c) => (c.online ? c.runningItems() : []))
}

/** What remote-assets needs to fetch a file from this peer. */
export function peerTransport(peerId: string): { host: string; port: number; cert: string; token: string; identity: PeerIdentity } | null {
  const peer = ctx.stored.find((p) => p.peerId === peerId)
  const conn = ctx.connections.get(peerId)
  if (!peer || !ctx.identity || !conn || conn.stopped) return null
  const token = decryptToken(peer)
  return token ? { host: peer.host, port: peer.port, cert: peer.cert, token, identity: ctx.identity } : null
}

export function peerRequest<T = unknown>(peerId: string, payload: { type: string; [key: string]: unknown }): Promise<T> {
  const conn = ctx.connections.get(peerId)
  if (!conn) return Promise.reject(new Error('unknown_peer'))
  return conn.request<T>(payload)
}

/** The REST client of a peer — the same package class the phone uses. */
function httpFor(peerId: string): CompanionHttp | null {
  const peer = ctx.stored.find((p) => p.peerId === peerId)
  if (!peer || !ctx.identity) return null
  const cached = ctx.httpClients.get(peerId)
  if (cached) return cached
  const token = decryptToken(peer)
  if (!token) return null
  const client = new CompanionHttp({
    host: peer.host,
    port: peer.port,
    pin: '',
    token,
    httpUrl: `https://${peer.host}:${peer.port}`,
    fetchImpl: peerFetch(ctx.identity, peer.cert),
  })
  ctx.httpClients.set(peerId, client)
  return client
}

/**
 * The peer's media registry. Every id that comes back is remembered so the
 * renderer's scheme handlers (`orbit-media://`, `orbit-artifact://`, pieces)
 * fetch the file from that machine instead of looking for it on this disk.
 * `path` is blanked: it is the other machine's filesystem layout.
 */
export async function peerMediaList(peerId: string): Promise<MediaEntry[]> {
  const http = httpFor(peerId)
  if (!http) throw new Error('unknown_peer')
  const res = await http.listMedia()
  if (!res.ok || !Array.isArray(res.data)) throw new Error(res.error ?? 'media_list_failed')
  return res.data.map((entry) => {
    for (const id of [entry.id, entry.thumb, entry.thumbDark, entry.motionId, entry.designId, entry.slidesId]) {
      if (typeof id === 'string' && id) rememberRemoteId(id, peerId)
    }
    return { ...entry, path: '' }
  })
}

export async function peerMediaUsage(peerId: string): Promise<MediaUsage> {
  const http = httpFor(peerId)
  if (!http) throw new Error('unknown_peer')
  const res = await http.mediaUsage()
  if (!res.ok || !res.data) throw new Error(res.error ?? 'media_usage_failed')
  return res.data
}

export async function peerDeleteMedia(peerId: string, id: string): Promise<boolean> {
  const http = httpFor(peerId)
  if (!http) throw new Error('unknown_peer')
  const res = await http.deleteMedia(id)
  if (!res.ok) throw new Error(res.error ?? 'media_delete_failed')
  return res.data?.deleted === true
}

export function peerGrants(peerId: string): PeerGrants {
  return normalizeGrants(ctx.stored.find((p) => p.peerId === peerId)?.grants)
}

export function resendPeerSessions(peerId?: string): void {
  for (const conn of ctx.connections.values()) {
    if (peerId && conn.peer.peerId !== peerId) continue
    if (conn.online) {
      conn.emitSessions()
      conn.emitStatuses()
      conn.emitFolders()
    } else if (conn.hasLists) {
      // Cold start: the renderer asks before the socket has authenticated.
      conn.emitSessions()
      conn.emitFolders()
    }
  }
}

export function reconnectPeers(): void {
  for (const conn of ctx.connections.values()) conn.reconnectNow()
}

export async function forgetPeer(peerId: string): Promise<void> {
  ctx.connections.get(peerId)?.close()
  ctx.connections.delete(peerId)
  ctx.httpClients.delete(peerId)
  ctx.stored = ctx.stored.filter((p) => p.peerId !== peerId)
  forgetPeerAssets(peerId)
  await forgetPeerLists(peerId)
  await persist()
  ctx.hooks?.changed()
}

/** A beacon showed the peer at another address (DHCP): follow it — the certificate still decides. */
export function notePeerAddress(peerId: string, host: string, port: number): void {
  const peer = ctx.stored.find((p) => p.peerId === peerId)
  if (!peer || (peer.host === host && peer.port === port)) return
  const conn = ctx.connections.get(peerId)
  if (conn?.online) return
  peer.host = host
  peer.port = port
  // The REST client embeds the address and the pinned certificate.
  ctx.httpClients.delete(peerId)
  void persist()
  if (conn && !conn.stopped) conn.reconnectNow()
}

