import crypto from 'node:crypto'
import type { TLSSocket } from 'node:tls'
import { safeStorage } from 'electron'
import { WebSocket } from 'ws'
import { CompanionHttp } from '@orbit/companion-client'
import type { ChatEvent, FolderInfo, SessionInfo } from '@shared/chat'
import type { MediaEntry, MediaUsage } from '@shared/media'
import type { MemoryEvent } from '@shared/memory'
import type { PipelineEvent } from '@shared/pipeline'
import type { RoutineEvent } from '@shared/routines'
import {
  PEER_PROTOCOL_VERSION,
  isPeerId,
  normalizeGrants,
  remoteSessionId,
  type KnownPeer,
  type OutgoingPairState,
  type PeerGrants,
  type PeerPairServerMessage,
  type PeerRunningItem,
  type PeersEvent,
} from '@shared/peers'
import { readJson, writeJson } from '../storage'
import type { PeerIdentity } from './identity'
import { newNonce, pairingCode, sanitizePeerName } from './pairing'
import { fingerprintOf } from './identity'
import { firstContactClientTlsOptions, pinnedClientTlsOptions, remoteCertificatePem, remoteFingerprint } from './tls-options'
import { forgetPeerAssets, indexRemoteIds, rememberRemoteId } from './remote-index'
import { peerFetch } from './peer-http'

/**
 * The desktops THIS machine paired with: their pinned certificate, our token for
 * them, one WSS connection each (pinned, with our client certificate), reconnect with
 * backoff, and the outgoing pairing flow.
 */

const KNOWN_KEY = 'peers/known'
const REQUEST_TIMEOUT_MS = 20_000

interface StoredPeer {
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

interface Hooks {
  emit: (event: PeersEvent) => void
  changed: () => void
}

let identity: PeerIdentity | null = null
let hooks: Hooks | null = null
let selfName = () => 'Orbit'
let stored: StoredPeer[] = []
const connections = new Map<string, PeerConnection>()
/** REST client per peer — the same `CompanionHttp` the phone uses, over pinned TLS. */
const httpClients = new Map<string, CompanionHttp>()
let outgoing: { state: OutgoingPairState; ws: WebSocket | null } | null = null

function encryptToken(token: string): Pick<StoredPeer, 'token' | 'tokenEnc'> {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { token: safeStorage.encryptString(token).toString('base64'), tokenEnc: 'safe' }
    }
  } catch {
    /* falls back to the file's own 0600 permission */
  }
  return { token, tokenEnc: 'plain' }
}

function decryptToken(peer: StoredPeer): string | null {
  try {
    return peer.tokenEnc === 'safe' ? safeStorage.decryptString(Buffer.from(peer.token, 'base64')) : peer.token
  } catch {
    return null
  }
}

async function persist(): Promise<void> {
  await writeJson(KNOWN_KEY, stored)
}

// ─── One connection per peer ────────────────────────────────────────────────

const RUNNING_STATUSES = new Set(['submitted', 'streaming', 'cancelling', 'fallback'])
const CERT_ERRORS = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|SIGNATURE/i

class PeerConnection {
  ws: WebSocket | null = null
  online = false
  error: KnownPeer['error']
  stopped = false
  private attempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  sessions: SessionInfo[] = []
  folders: FolderInfo[] = []
  running = new Set<string>()
  /** sessionId → pending request ids (questions/permissions waiting on that machine). */
  waiting = new Map<string, Set<string>>()
  private sessionsTimer: ReturnType<typeof setTimeout> | null = null

  constructor(public peer: StoredPeer) {}

  connect(): void {
    if (this.stopped || !identity) return
    const token = decryptToken(this.peer)
    if (!token) {
      this.error = 'revoked'
      hooks?.changed()
      return
    }
    const ws = new WebSocket(`wss://${this.peer.host}:${this.peer.port}`, {
      ...pinnedClientTlsOptions(identity, this.peer.cert),
      handshakeTimeout: 8000,
      maxPayload: 64 * 1024 * 1024,
    })
    this.ws = ws
    let authed = false
    ws.on('open', () => ws.send(JSON.stringify({ type: 'peer:auth', token })))
    ws.on('message', (data: Buffer) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>
      } catch {
        return
      }
      if (!authed) {
        if (msg.type === 'peer:auth-ok') {
          authed = true
          this.attempt = 0
          this.online = true
          this.error = undefined
          if (typeof msg.name === 'string') this.peer.name = sanitizePeerName(msg.name)
          this.peer.grants = normalizeGrants(msg.grants)
          void persist()
          hooks?.changed()
          void this.loadInitial()
        } else if (msg.type === 'peer:auth-error') {
          this.error = 'revoked'
          this.stopped = true
          hooks?.changed()
        }
        return
      }
      this.onMessage(msg)
    })
    ws.on('error', (err: Error & { code?: string }) => {
      if (CERT_ERRORS.test(err.code ?? '') || CERT_ERRORS.test(err.message)) {
        // A different certificate on the pinned address: another machine took the IP, the
        // other Orbit was reinstalled — or someone is in the middle. Never fall back: the
        // person pairs again, comparing the code.
        this.error = 'certificate_changed'
        this.stopped = true
      } else if (!this.error) {
        this.error = 'unreachable'
      }
    })
    ws.on('close', (code) => {
      const wasOnline = this.online
      this.online = false
      this.ws = null
      this.failPending('disconnected')
      if (code === 4001) {
        this.error = 'revoked'
        this.stopped = true
      }
      if (wasOnline || this.stopped) {
        this.running.clear()
        this.waiting.clear()
        emitRunning()
      }
      hooks?.changed()
      this.scheduleRetry()
    })
  }

  private scheduleRetry(): void {
    if (this.stopped) return
    if (this.retryTimer) clearTimeout(this.retryTimer)
    const delay = Math.min(30_000, 2000 * 2 ** Math.min(this.attempt, 4))
    this.attempt += 1
    this.retryTimer = setTimeout(() => this.connect(), delay)
  }

  reconnectNow(): void {
    if (this.online || this.stopped) return
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.attempt = 0
    this.ws?.terminate()
    this.connect()
  }

  close(): void {
    this.stopped = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.ws?.close()
    this.failPending('closed')
  }

  private failPending(reason: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
    this.pending.clear()
  }

  request<T = unknown>(payload: { type: string; [key: string]: unknown }): Promise<T> {
    const ws = this.ws
    if (!ws || !this.online) return Promise.reject(new Error('offline'))
    const id = crypto.randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('timeout'))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      ws.send(JSON.stringify({ id, payload }))
    })
  }

  private async loadInitial(): Promise<void> {
    try {
      const [sessions, running, folders] = await Promise.all([
        this.request<SessionInfo[]>({ type: 'sessions:list' }),
        this.request<string[]>({ type: 'sessions:running' }),
        // Read-only pairings refuse this; the list still works, just flat.
        this.request<FolderInfo[]>({ type: 'folders:list' }).catch(() => [] as FolderInfo[]),
      ])
      this.sessions = Array.isArray(sessions) ? sessions : []
      this.running = new Set(Array.isArray(running) ? running : [])
      this.folders = Array.isArray(folders) ? folders : []
      this.emitSessions()
      this.emitFolders()
      await Promise.all(
        [...this.running].map(async (sid) => {
          const state = await this.request<{ pendingAsks?: { requestId?: string }[] }>({ type: 'session:state', sessionId: sid }).catch(() => null)
          const asks = state?.pendingAsks ?? []
          if (asks.length) this.waiting.set(sid, new Set(asks.map((a, i) => a.requestId ?? String(i))))
        }),
      )
      this.emitStatuses()
    } catch {
      /* the next event or reconnect fills it in */
    }
  }

  private onMessage(msg: Record<string, unknown>): void {
    const payload = msg.payload as Record<string, unknown> | undefined
    if (!payload) return
    if (payload.type === 'api:response') {
      const p = this.pending.get(String(payload.requestId))
      if (!p) return
      this.pending.delete(String(payload.requestId))
      clearTimeout(p.timer)
      if (payload.ok) {
        indexRemoteIds(this.peer.peerId, payload.data)
        p.resolve(payload.data)
      } else {
        p.reject(new Error(typeof payload.error === 'string' ? payload.error : 'error'))
      }
      return
    }
    if (payload.type === 'chat:event') this.onChatEvent(payload.event as ChatEvent)
    // Only a full-control peer is sent these; the renderer applies them to the
    // routines/pipeline screens while this machine is the active environment.
    else if (payload.type === 'routines:event') hooks?.emit({ type: 'routines', peerId: this.peer.peerId, event: payload.event as RoutineEvent })
    else if (payload.type === 'memory:event') hooks?.emit({ type: 'memory', peerId: this.peer.peerId, event: payload.event as MemoryEvent })
    else if (payload.type === 'pipeline:event') hooks?.emit({ type: 'pipeline', peerId: this.peer.peerId, event: payload.event as PipelineEvent })
  }

  private onChatEvent(event: ChatEvent): void {
    if (!event || typeof event !== 'object') return
    const sid = 'sessionId' in event ? event.sessionId : ''
    if (event.type === 'message' || event.type === 'messages' || event.type === 'part') indexRemoteIds(this.peer.peerId, event)

    if (event.type === 'status') {
      const was = this.running.has(sid)
      if (RUNNING_STATUSES.has(event.status)) this.running.add(sid)
      else {
        this.running.delete(sid)
        this.waiting.delete(sid)
      }
      if (was !== this.running.has(sid)) this.emitStatuses()
    } else if (event.type === 'permission' || event.type === 'question') {
      const set = this.waiting.get(sid) ?? new Set<string>()
      set.add(event.requestId)
      this.waiting.set(sid, set)
      this.emitStatuses()
    } else if (event.type === 'ask:batch') {
      const set = this.waiting.get(sid) ?? new Set<string>()
      for (const item of event.items) set.add((item as { requestId?: string }).requestId ?? event.batchId)
      this.waiting.set(sid, set)
      this.emitStatuses()
    } else if (event.type === 'ask:done') {
      const set = this.waiting.get(sid)
      if (set) {
        set.delete(event.requestId)
        if (!set.size) this.waiting.delete(sid)
        this.emitStatuses()
      }
    } else if (event.type === 'session') {
      const i = this.sessions.findIndex((s) => s.id === sid)
      if (i >= 0) this.sessions[i] = { ...this.sessions[i], ...event.session }
      else this.sessions.unshift(event.session)
      this.queueSessions()
    } else if (event.type === 'session:deleted') {
      this.sessions = this.sessions.filter((s) => s.id !== sid)
      this.queueSessions()
    } else if (event.type === 'title') {
      const s = this.sessions.find((x) => x.id === sid)
      if (s) s.title = event.title
      this.queueSessions()
    }

    if (event.type === 'folders') {
      this.folders = Array.isArray(event.folders) ? event.folders : []
      this.emitFolders()
      return
    }
    if (!sid) return
    const namespaced = remoteSessionId(this.peer.peerId, sid)
    const out = (
      event.type === 'session' ? { ...event, sessionId: namespaced, session: { ...event.session, id: namespaced } } : { ...event, sessionId: namespaced }
    ) as ChatEvent
    hooks?.emit({ type: 'chat', peerId: this.peer.peerId, event: out })
  }

  private queueSessions(): void {
    if (this.sessionsTimer) return
    this.sessionsTimer = setTimeout(() => {
      this.sessionsTimer = null
      this.emitSessions()
    }, 250)
  }

  emitSessions(): void {
    // Archived chats travel too: the sidebar shows the same sections as on the
    // machine that owns them.
    const sessions = this.sessions.map((s) => ({
      ...s,
      id: remoteSessionId(this.peer.peerId, s.id),
      parentId: s.parentId ? remoteSessionId(this.peer.peerId, s.parentId) : s.parentId,
      folderId: s.folderId,
    }))
    hooks?.emit({ type: 'sessions', peerId: this.peer.peerId, sessions })
  }

  emitFolders(): void {
    hooks?.emit({ type: 'folders', peerId: this.peer.peerId, folders: this.folders })
  }

  emitStatuses(): void {
    hooks?.emit({ type: 'statuses', peerId: this.peer.peerId, running: [...this.running].map((sid) => remoteSessionId(this.peer.peerId, sid)) })
    emitRunning()
  }

  runningItems(): PeerRunningItem[] {
    return [...this.running].map((sid) => ({
      peerId: this.peer.peerId,
      peerName: this.peer.name,
      sessionId: remoteSessionId(this.peer.peerId, sid),
      title: this.sessions.find((s) => s.id === sid)?.title ?? '',
      waiting: (this.waiting.get(sid)?.size ?? 0) > 0,
    }))
  }
}

function emitRunning(): void {
  hooks?.changed()
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function initPeerClient(input: { identity: PeerIdentity; selfName: () => string; hooks: Hooks }): Promise<void> {
  identity = input.identity
  selfName = input.selfName
  hooks = input.hooks
  const raw = (await readJson<StoredPeer[]>(KNOWN_KEY)) ?? []
  stored = raw.filter((p) => isPeerId(p.peerId) && typeof p.cert === 'string' && typeof p.host === 'string')
  for (const peer of stored) {
    const conn = new PeerConnection(peer)
    connections.set(peer.peerId, conn)
    conn.connect()
  }
}

export function knownPeers(): KnownPeer[] {
  return stored.map((p) => {
    const conn = connections.get(p.peerId)
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
  return [...connections.values()].flatMap((c) => (c.online ? c.runningItems() : []))
}

export function outgoingState(): OutgoingPairState | null {
  return outgoing?.state ?? null
}

/** What remote-assets needs to fetch a file from this peer. */
export function peerTransport(peerId: string): { host: string; port: number; cert: string; token: string; identity: PeerIdentity } | null {
  const peer = stored.find((p) => p.peerId === peerId)
  const conn = connections.get(peerId)
  if (!peer || !identity || !conn || conn.stopped) return null
  const token = decryptToken(peer)
  return token ? { host: peer.host, port: peer.port, cert: peer.cert, token, identity } : null
}

export function peerRequest<T = unknown>(peerId: string, payload: { type: string; [key: string]: unknown }): Promise<T> {
  const conn = connections.get(peerId)
  if (!conn) return Promise.reject(new Error('unknown_peer'))
  return conn.request<T>(payload)
}

/** The REST client of a peer — the same package class the phone uses. */
function httpFor(peerId: string): CompanionHttp | null {
  const peer = stored.find((p) => p.peerId === peerId)
  if (!peer || !identity) return null
  const cached = httpClients.get(peerId)
  if (cached) return cached
  const token = decryptToken(peer)
  if (!token) return null
  const client = new CompanionHttp({
    host: peer.host,
    port: peer.port,
    pin: '',
    token,
    httpUrl: `https://${peer.host}:${peer.port}`,
    fetchImpl: peerFetch(identity, peer.cert),
  })
  httpClients.set(peerId, client)
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
  return normalizeGrants(stored.find((p) => p.peerId === peerId)?.grants)
}

export function resendPeerSessions(peerId?: string): void {
  for (const conn of connections.values()) {
    if (peerId && conn.peer.peerId !== peerId) continue
    if (conn.online) {
      conn.emitSessions()
      conn.emitStatuses()
      conn.emitFolders()
    }
  }
}

export function reconnectPeers(): void {
  for (const conn of connections.values()) conn.reconnectNow()
}

export async function forgetPeer(peerId: string): Promise<void> {
  connections.get(peerId)?.close()
  connections.delete(peerId)
  httpClients.delete(peerId)
  stored = stored.filter((p) => p.peerId !== peerId)
  forgetPeerAssets(peerId)
  await persist()
  hooks?.changed()
}

/** A beacon showed the peer at another address (DHCP): follow it — the certificate still decides. */
export function notePeerAddress(peerId: string, host: string, port: number): void {
  const peer = stored.find((p) => p.peerId === peerId)
  if (!peer || (peer.host === host && peer.port === port)) return
  const conn = connections.get(peerId)
  if (conn?.online) return
  peer.host = host
  peer.port = port
  // The REST client embeds the address and the pinned certificate.
  httpClients.delete(peerId)
  void persist()
  if (conn && !conn.stopped) conn.reconnectNow()
}

// ─── Outgoing pairing ───────────────────────────────────────────────────────

function setOutgoing(state: OutgoingPairState | null): void {
  if (!state) outgoing = null
  else if (outgoing) outgoing.state = state
  else outgoing = { state, ws: null }
  hooks?.changed()
}

export function cancelPairing(): void {
  const ws = outgoing?.ws
  outgoing = null
  try {
    ws?.close()
  } catch {
    /* already closed */
  }
  hooks?.changed()
}

export function startPairing(host: string, port: number): void {
  if (!identity) return
  cancelPairing()
  const me = identity
  const requesterNonce = newNonce()
  let serverPem: string | null = null
  let serverFp: string | null = null
  let finished = false
  const state: OutgoingPairState = { host, port, status: 'connecting' }
  outgoing = { state, ws: null }
  hooks?.changed()

  const ws = new WebSocket(`wss://${host}:${port}`, { ...firstContactClientTlsOptions(me), handshakeTimeout: 8000 })
  outgoing.ws = ws
  const isCurrent = () => outgoing?.ws === ws

  ws.on('upgrade', (res) => {
    serverPem = remoteCertificatePem(res.socket as TLSSocket)
    serverFp = remoteFingerprint(res.socket as TLSSocket)
  })
  ws.on('open', () => {
    if (!serverPem || !serverFp) {
      ws.close()
      return
    }
    ws.send(JSON.stringify({ type: 'peer:pair-request', protocolVersion: PEER_PROTOCOL_VERSION, peerId: me.peerId, name: selfName(), nonce: requesterNonce }))
  })
  ws.on('message', async (data: Buffer) => {
    if (!isCurrent()) return
    let msg: PeerPairServerMessage
    try {
      msg = JSON.parse(data.toString()) as PeerPairServerMessage
    } catch {
      return
    }
    if (msg.type === 'peer:pair-pending' && serverFp) {
      const code = pairingCode({
        requesterFingerprint: me.fingerprint,
        responderFingerprint: serverFp,
        requesterNonce,
        responderNonce: msg.nonce,
      })
      setOutgoing({ host, port, status: 'waiting', code, name: sanitizePeerName(msg.name), expiresAt: msg.expiresAt })
    } else if (msg.type === 'peer:pair-accepted' && serverPem && isPeerId(msg.peerId)) {
      finished = true
      // The certificate we pin is the one THIS TLS session presented — the same one the
      // code was computed from — never anything the message says.
      if (fingerprintOf(serverPem) !== serverFp) return setOutgoing({ host, port, status: 'error', reason: 'invalid' })
      const peer: StoredPeer = {
        peerId: msg.peerId,
        name: sanitizePeerName(msg.name),
        host,
        port,
        cert: serverPem,
        ...encryptToken(msg.token),
        grants: normalizeGrants(msg.grants),
        pairedAt: Date.now(),
      }
      connections.get(peer.peerId)?.close()
      httpClients.delete(peer.peerId)
      stored = [...stored.filter((p) => p.peerId !== peer.peerId), peer]
      await persist()
      const conn = new PeerConnection(peer)
      connections.set(peer.peerId, conn)
      setOutgoing({ host, port, status: 'accepted', name: peer.name })
      setTimeout(() => conn.connect(), 400)
    } else if (msg.type === 'peer:pair-declined') {
      finished = true
      setOutgoing({ host, port, status: msg.reason === 'expired' ? 'expired' : 'declined', reason: msg.reason, name: outgoing?.state.name })
    }
  })
  ws.on('error', () => {
    if (!isCurrent() || finished) return
    finished = true
    setOutgoing({ host, port, status: 'error', reason: 'unreachable' })
  })
  ws.on('close', () => {
    if (!isCurrent() || finished) return
    finished = true
    setOutgoing({ host, port, status: 'error', reason: 'unreachable' })
  })
}
