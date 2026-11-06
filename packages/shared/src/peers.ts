/**
 * Orbit ↔ Orbit on the same network (see docs/multi-desktop-peers.md).
 *
 * A desktop can pair with another desktop and see its chats, follow the ones
 * running, open its pieces (motion, design, slides, artifacts) and, when the
 * other side allows, send messages and browse the project files.
 *
 * The phone keeps its own server (plain WS, port 3847). Desktops talk through a
 * separate server with mutual TLS (port 3849): each install has a self-signed
 * certificate, the pairing code shown on both screens is derived from both
 * certificates, and after pairing each side pins the other's certificate.
 */

import type { ChatEvent, SessionInfo } from './chat'

export const PEER_PROTOCOL_VERSION = 1
/** Mutual-TLS server (HTTPS + WSS on the same port) for desktop peers. */
export const PEER_PORT = 3849
/** UDP port of the discovery beacon. */
export const PEER_BEACON_PORT = 3850
/** A pairing request waits this long for the person on the other side. */
export const PEER_PAIR_TTL_MS = 60_000

/** What the receiving machine lets a paired desktop do. Viewing chats and
 *  pieces is always granted once paired; the rest is opt-in. */
export interface PeerGrants {
  /** Send messages to its chats and stop a running turn. */
  send: boolean
  /** Browse and read the files of the chats' project folders. */
  files: boolean
}

export const NO_GRANTS: PeerGrants = { send: false, files: false }

export function normalizeGrants(value: unknown): PeerGrants {
  const v = (value ?? {}) as Partial<PeerGrants>
  return { send: v.send === true, files: v.files === true }
}

// ─── Ids ─────────────────────────────────────────────────────────────────────

const PEER_ID_RE = /^p_[a-f0-9]{16}$/

export function isPeerId(value: unknown): value is string {
  return typeof value === 'string' && PEER_ID_RE.test(value)
}

const REMOTE_PREFIX = 'peer:'

/**
 * A session of another desktop, as this desktop sees it: `peer:<peerId>:<id>`.
 * The prefix is what makes every IPC that receives a session id (motion
 * bundles, piece cards, the panel bucket) route to the right machine instead of
 * looking it up on the local disk.
 */
export function remoteSessionId(peerId: string, sessionId: string): string {
  return `${REMOTE_PREFIX}${peerId}:${sessionId}`
}

export function parseRemoteSessionId(id: string | null | undefined): { peerId: string; sessionId: string } | null {
  if (!id || !id.startsWith(REMOTE_PREFIX)) return null
  const rest = id.slice(REMOTE_PREFIX.length)
  const sep = rest.indexOf(':')
  if (sep <= 0) return null
  const peerId = rest.slice(0, sep)
  const sessionId = rest.slice(sep + 1)
  if (!isPeerId(peerId) || !sessionId) return null
  return { peerId, sessionId }
}

export function isRemoteSessionId(id: string | null | undefined): boolean {
  return parseRemoteSessionId(id) !== null
}

// ─── Renderer-facing state ───────────────────────────────────────────────────

/** A desktop this machine paired WITH (it can see that one). */
export interface KnownPeer {
  peerId: string
  name: string
  host: string
  port: number
  /** What that machine granted us. */
  grants: PeerGrants
  pairedAt: number
  online: boolean
  /** Last connection problem, already translated to a short code. */
  error?: 'unreachable' | 'certificate_changed' | 'revoked' | 'version'
}

/** A desktop seen on the network by the beacon. */
export interface DiscoveredPeer {
  peerId: string
  name: string
  host: string
  port: number
  version: string
  /** Already paired with it (it shows as "connected" instead of "Connect"). */
  paired: boolean
}

/** Someone asking to see this machine. Shown as a card to accept or decline. */
export interface IncomingPairRequest {
  requestId: string
  peerId: string
  name: string
  address: string
  /** Six digits, the same on both screens. */
  code: string
  expiresAt: number
}

export type OutgoingPairStatus = 'connecting' | 'waiting' | 'accepted' | 'declined' | 'expired' | 'error'

export interface OutgoingPairState {
  host: string
  port: number
  name?: string
  code?: string
  status: OutgoingPairStatus
  /** Reason code for declined/error: not_discoverable, rate_limited, busy, version, unreachable. */
  reason?: string
  expiresAt?: number
}

/** A running chat on another desktop — the "Running on other desktops" strip. */
export interface PeerRunningItem {
  peerId: string
  peerName: string
  /** Namespaced (`peer:<peerId>:<id>`). */
  sessionId: string
  title: string
  /** Waiting for the person on that machine (a question or a plan to approve). */
  waiting: boolean
}

/** A device that can see THIS machine (phone or desktop). */
export interface GrantedDevice {
  /** Stable, non-secret handle (hash of the token) used to revoke. */
  id: string
  deviceName: string
  kind: 'phone' | 'desktop'
  grants?: PeerGrants
  pairedAt: number
  lastSeenAt: number
  connected: boolean
}

export interface PeersSnapshot {
  discoverable: boolean
  selfName: string
  selfPeerId: string
  /** Where another computer reaches this one (for typing it by hand). */
  selfAddress: { ip: string; port: number }
  peers: KnownPeer[]
  discovered: DiscoveredPeer[]
  incoming: IncomingPairRequest[]
  outgoing: OutgoingPairState | null
  running: PeerRunningItem[]
  devices: GrantedDevice[]
  /** The mutual-TLS server could not start (port taken, certificate error). */
  serverError: string | null
}

/** main → renderer. Session ids inside are already namespaced. */
export type PeersEvent =
  | { type: 'snapshot'; snapshot: PeersSnapshot }
  | { type: 'sessions'; peerId: string; sessions: SessionInfo[] }
  | { type: 'chat'; peerId: string; event: ChatEvent }
  | { type: 'statuses'; peerId: string; running: string[] }

// ─── Wire protocol (peer server) ─────────────────────────────────────────────

export interface PeerPairRequestMessage {
  type: 'peer:pair-request'
  protocolVersion: number
  peerId: string
  name: string
  /** 32 random bytes, hex. Mixed into the code with both certificates. */
  nonce: string
}

export type PeerPairDeclineReason =
  | 'declined'
  | 'expired'
  | 'not_discoverable'
  | 'rate_limited'
  | 'busy'
  | 'version'
  | 'invalid'

export type PeerPairServerMessage =
  | { type: 'peer:pair-pending'; requestId: string; nonce: string; name: string; peerId: string; expiresAt: number }
  | { type: 'peer:pair-accepted'; token: string; grants: PeerGrants; peerId: string; name: string }
  | { type: 'peer:pair-declined'; reason: PeerPairDeclineReason }

/** The pieces a remote card can open. */
export type RemotePieceKind = 'motion' | 'design' | 'slides'

export interface RemotePieceRef {
  id?: string
  path?: string
  /** The REMOTE (un-namespaced) session id. */
  sessionId?: string
  name?: string
}

export interface RemotePieceResolved {
  id: string
  /** Entry relative to the piece folder, with `/` (motion, slides). */
  entry?: string
  title: string
}

export interface RemoteFileEntry {
  name: string
  /** Relative to the root, with `/`. */
  path: string
  dir: boolean
  size?: number
}

export interface RemoteFileTree {
  /** The project folders of the session (display names). */
  roots: { index: number; name: string }[]
  root: number
  path: string
  entries: RemoteFileEntry[]
}

export interface RemoteFileContent {
  root: number
  path: string
  size: number
  mime: string
  encoding: 'utf8' | 'base64'
  content: string
  /** The file was larger than the limit: only the start came. */
  truncated: boolean
}
