/**
 * Transport-agnostic connection core: the resilience rules of an Orbit companion link,
 * written once and used by the phone (`CompanionWebSocket`, browser WebSocket, PIN/token
 * `auth`) and by a desktop peer (`ws` over pinned mTLS, `peer:auth`).
 *
 * The core owns: socket lifecycle, handshake gating, heartbeat (`Liveness`), request
 * correlation + offline queue (`RequestTracker`), backoff (`backoff.ts`) and
 * "is it really alive?" checks for wake/foreground. It knows nothing about URLs,
 * credentials or the shape of the handshake: those are injected.
 */

import { newMessageId, type ApiResponse, type WsMessage } from '@orbit/shared'
import { backoffDelay, exhausted, type BackoffPolicy } from './backoff'
import { Liveness } from './liveness'
import { RequestTracker } from './request-tracker'

export type CoreStatus = 'disconnected' | 'connecting' | 'authenticating' | 'connected'

/** The minimum a socket must offer — a browser WebSocket and `ws` both fit. */
export interface CoreSocket {
  send(data: string): void
  /** Graceful close. */
  close(): void
  isOpen(): boolean
  isConnecting(): boolean
}

/** What the core wants to hear from a socket. The factory wires these. */
export interface SocketEvents {
  open(): void
  message(raw: string): void
  close(code?: number): void
  error(err?: unknown): void
}

export type HandshakeOutcome =
  /** Authenticated; `info` goes to `hooks.onConnected`. */
  | { kind: 'ok'; info?: unknown }
  /** Refused for good (bad PIN, revoked token): stop reconnecting. `info` goes to `hooks.onRejected`. */
  | { kind: 'rejected'; info?: unknown }
  /** Not a handshake message, keep waiting. */
  | { kind: 'ignore' }

export interface Handshake {
  /** The socket opened: send the credentials. */
  start(send: (data: string) => void): void
  /** First messages until `ok`/`rejected`. The raw parsed JSON, whatever its shape. */
  onMessage(msg: unknown): HandshakeOutcome
}

export interface HeartbeatPolicy {
  intervalMs: number
  /** Deadline for any inbound message after a periodic ping. */
  pongTimeoutMs: number
  /** Tighter deadline when asked "are you still there?" (wake, foreground). */
  aliveCheckMs: number
}

export interface CoreHooks {
  onStatus(status: CoreStatus): void
  /** Failed reconnection attempts since the last success/restart. */
  onAttempt(attempt: number): void
  onConnected(info: unknown): void
  onRejected(info: unknown): void
  /** Every attempt used up (finite policies only). */
  onGiveUp(attempt: number): void
  /** The factory threw (invalid address, WebSocket unavailable). */
  onOpenError(err: unknown): void
  onPong(latency: number, at: number): void
  /** A server push (anything that is not a response or a pong). */
  onEvent(payload: { type: string; [key: string]: unknown }): void
  /** The socket closed on its own. Call `halt()` here to veto the reconnect. */
  onSocketClosed?(code: number | undefined): void
}

export interface CoreOptions {
  openSocket(events: SocketEvents): CoreSocket
  handshake: Handshake
  backoff: BackoffPolicy
  heartbeat: HeartbeatPolicy
  requestTimeoutMs: number
  queueTimeoutMs: number
  /** Forget failed attempts when the socket opens (phone) or only once authenticated (desktop). */
  resetAttemptsOn: 'open' | 'connected'
  hooks: CoreHooks
}

export class ConnectionCore {
  private socket: CoreSocket | null = null
  private status: CoreStatus = 'disconnected'
  private attempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private wantConnected = false
  /** Handshake refused or explicit stop(): only a fresh start() may reconnect. */
  private sealed = false
  /** Bumped whenever the socket is dropped: events of a replaced socket are ignored. */
  private generation = 0
  private readonly liveness: Liveness
  private readonly tracker: RequestTracker

  constructor(private readonly o: CoreOptions) {
    this.liveness = new Liveness({
      ...o.heartbeat,
      sendPing: () => this.writeRaw(JSON.stringify({ id: '', payload: { type: 'ping' } })),
      onDead: () => this.dropDeadSocket(),
    })
    this.tracker = new RequestTracker({
      requestTimeoutMs: o.requestTimeoutMs,
      queueTimeoutMs: o.queueTimeoutMs,
      isOnline: () => this.status === 'connected',
      transmit: (msg) => {
        if (!this.socket) throw new Error('no socket')
        this.socket.send(JSON.stringify(msg))
      },
    })
  }

  // ─── Public ────────────────────────────────────────────────────────────────

  getStatus(): CoreStatus {
    return this.status
  }

  isOnline(): boolean {
    return this.status === 'connected'
  }

  /** Opens the link (replacing any socket still around, which would leak on the server). */
  start(): void {
    this.wantConnected = true
    this.sealed = false
    this.attempt = 0
    this.o.hooks.onAttempt(0)
    this.teardownSocket()
    this.open()
  }

  /** Closes for good (no reconnect). Queued requests keep their own deadline. */
  stop(): void {
    this.wantConnected = false
    this.sealed = true
    this.teardownSocket()
    this.setStatus('disconnected')
  }

  /** Stops and rejects everything, queue included — the owner is going away. */
  destroy(): void {
    this.stop()
    this.tracker.failQueued('closed')
  }

  /** Stops reconnecting without touching the socket's state — a fatal verdict from the transport. */
  halt(): void {
    this.wantConnected = false
    this.sealed = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  request(payload: { type: string; [key: string]: unknown }): Promise<ApiResponse> {
    const msg = { id: newMessageId(), payload } as unknown as WsMessage
    return this.tracker.submit(msg)
  }

  /**
   * "Is anyone still there?" — for wake from sleep, unlock, window focus, app resume.
   * Online: a quick ping, dropping the socket if nothing answers. Otherwise (waiting
   * out a backoff, or gave up): try again right now, from the first delay.
   */
  checkAlive(): void {
    if (this.sealed) return
    if (this.status === 'connected') {
      this.liveness.probe(this.o.heartbeat.aliveCheckMs)
      return
    }
    this.restart()
  }

  // ─── Socket lifecycle ──────────────────────────────────────────────────────

  private restart(): void {
    this.wantConnected = true
    this.sealed = false
    this.attempt = 0
    this.teardownSocket()
    this.open()
  }

  private open(): void {
    this.setStatus('connecting')
    try {
      this.socket = this.o.openSocket(this.events())
    } catch (err) {
      this.o.hooks.onOpenError(err)
      this.setStatus('disconnected')
      this.scheduleReconnect()
    }
  }

  private events(): SocketEvents {
    const gen = this.generation
    const current = () => gen === this.generation
    return {
      open: () => {
        if (!current()) return
        if (this.o.resetAttemptsOn === 'open') this.resetAttempts()
        this.setStatus('authenticating')
        this.o.handshake.start((data) => this.socket?.send(data))
      },
      message: (raw) => current() && this.onRaw(raw),
      close: (code) => current() && this.onSocketClosed(code),
      error: () => {},
    }
  }

  private onRaw(raw: string): void {
    let msg: { payload?: { type?: string; [key: string]: unknown } }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    this.liveness.noteInbound()

    if (this.status === 'authenticating') {
      const outcome = this.o.handshake.onMessage(msg)
      if (outcome.kind === 'ok') {
        this.setStatus('connected')
        if (this.o.resetAttemptsOn === 'connected') this.resetAttempts()
        this.liveness.start()
        this.o.hooks.onConnected(outcome.info)
        this.tracker.flush()
      } else if (outcome.kind === 'rejected') {
        this.halt()
        this.teardownSocket()
        this.o.hooks.onRejected(outcome.info)
        this.setStatus('disconnected')
      }
      return
    }

    const payload = msg.payload
    if (!payload || typeof payload.type !== 'string') return
    if (payload.type === 'pong') {
      this.o.hooks.onPong(this.liveness.latency(), Date.now())
    } else if (payload.type === 'api:response') {
      this.tracker.resolve(payload as unknown as ApiResponse)
    } else {
      this.o.hooks.onEvent(payload as { type: string })
    }
  }

  private onSocketClosed(code: number | undefined): void {
    this.teardownSocket(false)
    this.o.hooks.onSocketClosed?.(code)
    if (this.wantConnected) {
      this.setStatus('connecting')
      this.scheduleReconnect()
    } else {
      this.setStatus('disconnected')
    }
  }

  /** Socket without an answer: close it (failing what was in flight instead of letting
   *  each request die on its own timeout) and reconnect right away. */
  private dropDeadSocket(): void {
    if (!this.wantConnected) return
    this.teardownSocket()
    this.attempt = 0
    this.o.hooks.onAttempt(0)
    this.open()
  }

  private scheduleReconnect(): void {
    if (this.retryTimer || !this.wantConnected) return
    if (exhausted(this.attempt, this.o.backoff)) {
      this.wantConnected = false
      this.o.hooks.onGiveUp(this.attempt)
      this.setStatus('disconnected')
      return
    }
    const delay = backoffDelay(this.attempt, this.o.backoff)
    this.attempt += 1
    this.o.hooks.onAttempt(this.attempt)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.wantConnected) this.open()
    }, delay)
  }

  private resetAttempts(): void {
    this.attempt = 0
    this.o.hooks.onAttempt(0)
  }

  /** Drops the socket and everything tied to it. `closeIt` false when it closed itself. */
  private teardownSocket(closeIt = true): void {
    this.generation += 1
    this.liveness.stop()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.tracker.failInFlight('Connection closed')
    const socket = this.socket
    this.socket = null
    if (socket && closeIt && (socket.isOpen() || socket.isConnecting())) {
      try {
        socket.close()
      } catch {
        /* already gone */
      }
    }
  }

  private writeRaw(data: string): boolean {
    if (!this.socket || !this.socket.isOpen()) return false
    this.socket.send(data)
    return true
  }

  private setStatus(next: CoreStatus): void {
    if (this.status === next) return
    this.status = next
    this.o.hooks.onStatus(next)
  }
}
