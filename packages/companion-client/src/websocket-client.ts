/**
 * WebSocket client for communication with Orbit Desktop (the phone side).
 *
 * A thin layer over `ConnectionCore`: it supplies the browser socket and the PIN/token
 * `auth` handshake, and maps the core's status onto the `ConnectionState` the app
 * renders. Heartbeat, offline queue, backoff and dead-socket detection live in the core.
 */

import {
  type CompanionRequest,
  type CompanionEvent,
  type ApiResponse,
  type AuthOkResponse,
  type AuthRequest,
  newMessageId,
} from '@orbit/shared'
import type { ConnectionConfig, ConnectionState, ConnectionErrorReason } from './types'
import { ConnectionCore, type Handshake } from './connection-core'
import { openBrowserSocket } from './browser-socket'

type EventHandler = (event: CompanionEvent) => void
type StateChangeHandler = (state: ConnectionState) => void

const HEARTBEAT_INTERVAL = 15_000
/** With no message from the desktop at all for this time after a ping, the socket
 *  is taken as dead. On the phone this is common: iOS suspends the app in the
 *  background, the network switches Wi-Fi, and the socket comes back with readyState OPEN but without
 *  anyone on the other side — the UI said "connected" and everything sent vanished. */
const PONG_TIMEOUT = 8_000
/** Coming back from the background the check has to be quick: the person is already
 *  with a finger on the send button. */
const ALIVE_CHECK_TIMEOUT = 4_000
const REQUEST_TIMEOUT = 15_000

/**
 * Normalizes the `reason` of auth:error. The desktop may be newer than the app and
 * send a reason this client does not know yet — in that case it becomes
 * 'unknown' (with the raw value preserved in `error` for diagnostics).
 */
function authErrorReason(reason: unknown): ConnectionErrorReason {
  return reason === 'invalid_pin' || reason === 'already_paired' || reason === 'rate_limited'
    ? reason
    : 'unknown'
}

export class CompanionWebSocket {
  private config: ConnectionConfig | null = null
  private state: ConnectionState = { status: 'disconnected' }
  private eventHandlers = new Map<string, Set<EventHandler>>()
  private stateHandlers = new Set<StateChangeHandler>()
  private core: ConnectionCore

  constructor() {
    const handshake: Handshake = {
      start: (send) => {
        const config = this.config
        if (!config) return
        const auth: AuthRequest = {
          type: 'auth',
          pin: config.pin || undefined,
          token: config.token,
          deviceName: config.deviceName,
        }
        send(JSON.stringify({ id: newMessageId(), payload: auth }))
      },
      onMessage: (msg) => {
        const payload = (msg as { payload?: { type?: string; reason?: unknown } }).payload
        if (payload?.type === 'auth:ok') return { kind: 'ok', info: payload }
        if (payload?.type === 'auth:error') return { kind: 'rejected', info: payload.reason }
        return { kind: 'ignore' }
      },
    }

    this.core = new ConnectionCore({
      openSocket: (events) => {
        const { host, port } = this.config!
        return openBrowserSocket(`ws://${host}:${port}`, events)
      },
      handshake,
      backoff: { baseMs: 1_000, maxMs: 30_000, maxAttempts: 5 },
      heartbeat: { intervalMs: HEARTBEAT_INTERVAL, pongTimeoutMs: PONG_TIMEOUT, aliveCheckMs: ALIVE_CHECK_TIMEOUT },
      requestTimeoutMs: REQUEST_TIMEOUT,
      queueTimeoutMs: REQUEST_TIMEOUT,
      resetAttemptsOn: 'open',
      hooks: {
        onStatus: (status) => this.setState({ status }),
        onAttempt: (reconnectAttempt) => this.setState({ reconnectAttempt }),
        onConnected: (info) => {
          const ok = info as AuthOkResponse
          // Reconnections (backoff) already authenticate with the token the desktop issued.
          if (ok.deviceToken && this.config) this.config = { ...this.config, token: ok.deviceToken }
          this.setState({ serverVersion: ok.serverVersion, deviceName: ok.deviceName, deviceToken: ok.deviceToken })
        },
        onRejected: (reason) => {
          const errorReason = authErrorReason(reason)
          // Unknown reason: keep the raw value for diagnostics (it is not
          // displayable — the UI translates through errorReason).
          this.setState({ errorReason, error: errorReason === 'unknown' ? String(reason) : undefined })
        },
        onGiveUp: (attempt) => {
          // Only the code: the text (translated, with the attempt count
          // interpolated) is built by the app.
          this.setState({ errorReason: 'connect_failed', error: undefined, reconnectAttempt: attempt })
        },
        onOpenError: (err) => this.setState({ errorReason: 'socket_error', error: String(err) }),
        onPong: (latency, at) => this.setState({ lastActivity: at, latency }),
        onEvent: (payload) => this.emit(payload.type, payload as unknown as CompanionEvent),
      },
    })
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /** Connects to the desktop (replacing a previous socket, if any). */
  connect(config: ConnectionConfig): void {
    this.config = config
    this.core.start()
  }

  /** Closes the connection (without reconnection). */
  disconnect(): void {
    this.core.stop()
  }

  /** Sends a request and waits for the correlated response; queued (15s) while offline. */
  send(request: CompanionRequest): Promise<ApiResponse> {
    return this.core.request(request as { type: string })
  }

  /** Subscribes to an event type from the server. */
  subscribe(eventType: string, handler: EventHandler): () => void {
    if (!this.eventHandlers.has(eventType)) this.eventHandlers.set(eventType, new Set())
    this.eventHandlers.get(eventType)!.add(handler)
    return () => {
      this.eventHandlers.get(eventType)?.delete(handler)
    }
  }

  /** Listens for connection state changes. */
  onStateChange(handler: StateChangeHandler): () => void {
    this.stateHandlers.add(handler)
    return () => {
      this.stateHandlers.delete(handler)
    }
  }

  /**
   * Checks whether the socket still has someone on the other side — call it when the app
   * comes back to the foreground. Connected: pings and, without an answer in
   * a few seconds, drops it and reconnects. Gave up reconnecting: starts over.
   */
  checkAlive(): void {
    if (this.config) this.core.checkAlive()
  }

  /** Current state of the connection. */
  getState(): Readonly<ConnectionState> {
    return this.state
  }

  private setState(next: Partial<ConnectionState>): void {
    this.state = { ...this.state, ...next } as ConnectionState
    for (const handler of this.stateHandlers) {
      try {
        handler(this.state)
      } catch { /* swallow */ }
    }
  }

  private emit(type: string, event: CompanionEvent): void {
    for (const key of [type, '*']) {
      for (const handler of this.eventHandlers.get(key) ?? []) {
        try {
          handler(event)
        } catch { /* swallow */ }
      }
    }
  }
}
