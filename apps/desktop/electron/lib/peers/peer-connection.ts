import { ConnectionCore } from '@orbit/companion-client'
import type { ChatEvent, FolderInfo, SessionInfo } from '@shared/chat'
import type { MemoryEvent } from '@shared/memory'
import type { PipelineEvent } from '@shared/pipeline'
import type { RoutineEvent } from '@shared/routines'
import { normalizeGrants, PEER_SYNC_TYPES, remoteSessionId, type PeerRunningItem, type PeerSyncEvent } from '@shared/peers'
import { sanitizePeerName } from './pairing'
import { indexRemoteIds } from './remote-index'
import { openPeerSocket } from './peer-socket'
import { loadPeerLists, savePeerLists } from './peer-list-cache'
import { ctx, decryptToken, persist, type PeerError, type StoredPeer } from './peer-state'

/**
 * One paired desktop. The resilience (ping/pong, offline queue, backoff, dead-socket
 * detection) is the shared `ConnectionCore` — the same one the phone uses; this class
 * only plugs in the pinned-TLS socket and the `peer:auth` handshake, and mirrors that
 * machine's sessions, folders and running chats.
 */

const RUNNING_STATUSES = new Set(['submitted', 'streaming', 'cancelling', 'fallback'])
const CERT_ERRORS = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|SIGNATURE/i

export class PeerConnection {
  error: PeerError
  /** Handshake refused, token revoked or certificate changed: only the person can fix it. */
  stopped = false
  sessions: SessionInfo[] = []
  folders: FolderInfo[] = []
  running = new Set<string>()
  /** sessionId → pending request ids (questions/permissions waiting on that machine). */
  waiting = new Map<string, Set<string>>()
  private token: string | null = null
  private wasOnline = false
  private sessionsTimer: ReturnType<typeof setTimeout> | null = null
  private readonly core: ConnectionCore

  constructor(public peer: StoredPeer) {
    this.core = new ConnectionCore({
      openSocket: (events) =>
        openPeerSocket(this.peer, ctx.identity!, { ...events, error: (err) => (this.onSocketError(err), events.error(err)) }),
      handshake: {
        start: (send) => send(JSON.stringify({ type: 'peer:auth', token: this.token })),
        onMessage: (msg) => {
          const m = msg as { type?: string; name?: unknown; grants?: unknown }
          if (m.type === 'peer:auth-ok') return { kind: 'ok', info: m }
          if (m.type === 'peer:auth-error') return { kind: 'rejected' }
          return { kind: 'ignore' }
        },
      },
      // A desktop never gives up: it is on the same network, and it will be back.
      backoff: { baseMs: 2_000, maxMs: 30_000, maxAttempts: Infinity },
      heartbeat: { intervalMs: 15_000, pongTimeoutMs: 8_000, aliveCheckMs: 4_000 },
      requestTimeoutMs: 20_000,
      queueTimeoutMs: 15_000,
      resetAttemptsOn: 'connected',
      hooks: {
        onStatus: (status) => this.onStatus(status === 'connected'),
        onAttempt: () => {},
        onConnected: (info) => this.onAuthenticated(info as { name?: unknown; grants?: unknown }),
        onRejected: () => this.fail('revoked'),
        onGiveUp: () => {},
        onOpenError: () => {
          this.error ??= 'unreachable'
        },
        onPong: () => {},
        onEvent: (payload) => this.onPayload(payload),
        onSocketClosed: (code) => {
          if (code === 4001) this.fail('revoked')
        },
      },
    })
  }

  get online(): boolean {
    return this.core.isOnline()
  }

  connect(): void {
    if (this.stopped || !ctx.identity) return
    this.token = decryptToken(this.peer)
    if (!this.token) return this.fail('revoked')
    this.core.start()
  }

  /** Wake from sleep, unlocked screen, window focus, a beacon at a new address. */
  reconnectNow(): void {
    if (!this.stopped) this.core.checkAlive()
  }

  close(): void {
    this.stopped = true
    this.core.destroy()
  }

  request<T = unknown>(payload: { type: string; [key: string]: unknown }): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('offline'))
    return this.core.request(payload).then((res) => {
      if (!res.ok) throw new Error(typeof res.error === 'string' ? res.error : 'error')
      indexRemoteIds(this.peer.peerId, res.data)
      return res.data as T
    })
  }

  // ─── Core callbacks ───────────────────────────────────────────────────────

  private fail(error: PeerError): void {
    this.error = error
    this.stopped = true
    this.core.halt()
    ctx.hooks?.changed()
  }

  private onSocketError(raw: unknown): void {
    const err = raw as Error & { code?: string }
    if (CERT_ERRORS.test(err?.code ?? '') || CERT_ERRORS.test(err?.message ?? '')) {
      // A different certificate on the pinned address: another machine took the IP, the
      // other Orbit was reinstalled — or someone is in the middle. Never fall back: the
      // person pairs again, comparing the code.
      this.fail('certificate_changed')
    } else if (!this.error) {
      this.error = 'unreachable'
    }
  }

  private onStatus(online: boolean): void {
    if (this.wasOnline && !online) {
      this.running.clear()
      this.waiting.clear()
    }
    this.wasOnline = online
    ctx.hooks?.changed()
  }

  private onAuthenticated(info: { name?: unknown; grants?: unknown }): void {
    this.error = undefined
    if (typeof info.name === 'string') this.peer.name = sanitizePeerName(info.name)
    this.peer.grants = normalizeGrants(info.grants)
    void persist()
    ctx.hooks?.changed()
    void this.loadInitial()
  }

  // ─── What that machine has ────────────────────────────────────────────────

  /** Cold start: the last known lists, shown before the socket authenticates. */
  async restoreLists(): Promise<void> {
    const cached = await loadPeerLists(this.peer.peerId)
    if (!cached || this.online || this.sessions.length || this.folders.length) return
    this.sessions = cached.sessions
    this.folders = cached.folders
    this.emitSessions()
    this.emitFolders()
  }

  get hasLists(): boolean {
    return this.sessions.length > 0 || this.folders.length > 0
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
      this.saveLists()
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

  private saveLists(): void {
    savePeerLists(this.peer.peerId, () => ({ sessions: this.sessions, folders: this.folders }))
  }

  private onPayload(payload: { type: string; [key: string]: unknown }): void {
    if (payload.type === 'chat:event') this.onChatEvent(payload.event as ChatEvent)
    // Only a full-control peer is sent these; the renderer applies them to the
    // routines/pipeline screens while this machine is the active environment.
    else if (payload.type === 'routines:event') ctx.hooks?.emit({ type: 'routines', peerId: this.peer.peerId, event: payload.event as RoutineEvent })
    else if (payload.type === 'memory:event') ctx.hooks?.emit({ type: 'memory', peerId: this.peer.peerId, event: payload.event as MemoryEvent })
    else if (payload.type === 'pipeline:event') ctx.hooks?.emit({ type: 'pipeline', peerId: this.peer.peerId, event: payload.event as PipelineEvent })
    // Settings mirrors and notices: sent by the server under the same policy as the phone's.
    else if (PEER_SYNC_TYPES.has(payload.type)) ctx.hooks?.emit({ type: 'sync', peerId: this.peer.peerId, event: payload as unknown as PeerSyncEvent })
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
      this.saveLists()
      return
    }
    if (!sid) return
    const namespaced = remoteSessionId(this.peer.peerId, sid)
    const out = (
      event.type === 'session' ? { ...event, sessionId: namespaced, session: { ...event.session, id: namespaced } } : { ...event, sessionId: namespaced }
    ) as ChatEvent
    ctx.hooks?.emit({ type: 'chat', peerId: this.peer.peerId, event: out })
  }

  private queueSessions(): void {
    if (this.sessionsTimer) return
    this.sessionsTimer = setTimeout(() => {
      this.sessionsTimer = null
      this.emitSessions()
      this.saveLists()
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
    ctx.hooks?.emit({ type: 'sessions', peerId: this.peer.peerId, sessions })
  }

  emitFolders(): void {
    ctx.hooks?.emit({ type: 'folders', peerId: this.peer.peerId, folders: this.folders })
  }

  emitStatuses(): void {
    ctx.hooks?.emit({ type: 'statuses', peerId: this.peer.peerId, running: [...this.running].map((sid) => remoteSessionId(this.peer.peerId, sid)) })
    ctx.hooks?.changed()
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
