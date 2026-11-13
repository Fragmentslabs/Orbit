/**
 * WebSocket client for communication with Orbit Desktop.
 *
 * Encapsulates: authentication via PIN, request/response with ID correlation,
 * event subscription, heartbeat, reconnection with exponential backoff
 * and queue of requests during disconnection.
 */

import {
  type CompanionRequest,
  type CompanionEvent,
  type WsMessage,
  type ApiResponse,
  type AuthOkResponse,
  type AuthRequest,
  newMessageId,
} from '@orbit/shared'
import type { ConnectionConfig, ConnectionState, ConnectionErrorReason } from './types'

// ─── Event Handlers ──────────────────────────────────────────────────────────

type EventHandler = (event: CompanionEvent) => void
type StateChangeHandler = (state: ConnectionState) => void

// ─── Constants ───────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL = 15_000
/** With no message from the desktop at all for this time after a ping, the socket
 *  is taken as dead. On the phone this is common: iOS suspends the app in the
 *  background, the network switches Wi-Fi, and the socket comes back with readyState OPEN but without
 *  anyone on the other side — the UI said "connected" and everything sent vanished. */
const PONG_TIMEOUT = 8_000
/** Coming back from the background the check has to be quick: the person is already
 *  with a finger on the send button. */
const ALIVE_CHECK_TIMEOUT = 4_000
const RECONNECT_BASE_DELAY = 1_000
const RECONNECT_MAX_DELAY = 30_000
const RECONNECT_MAX_ATTEMPTS = 5
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

// ─── CompanionWebSocket ──────────────────────────────────────────────────────

export class CompanionWebSocket {
  private ws: WebSocket | null = null
  private config: ConnectionConfig | null = null
  private state: ConnectionState = { status: 'disconnected' }
  private eventHandlers = new Map<string, Set<EventHandler>>()
  private stateHandlers = new Set<StateChangeHandler>()
  private pendingRequests = new Map<
    string,
    { resolve: (v: ApiResponse) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()
  private queuedRequests: {
    msg: WsMessage
    resolve: (v: ApiResponse) => void
    reject: (e: Error) => void
    timer: ReturnType<typeof setTimeout>
  }[] = []
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private shouldReconnect = false
  private lastPing = 0
  /** Last time ANY message arrived from the desktop (pong, response, event). */
  private lastInbound = 0
  private pongTimer: ReturnType<typeof setTimeout> | null = null
  /** Explicit disconnect(): checkAlive cannot resurrect the connection. */
  private closedByUser = false

  // ─── Public API ──────────────────────────────────────────────────────────

  /** Connects to the desktop. */
  connect(config: ConnectionConfig): void {
    this.config = config
    this.shouldReconnect = true
    this.closedByUser = false
    this.reconnectAttempt = 0
    this.setState({ reconnectAttempt: 0 })

    // If a socket already exists (reconnection without an explicit disconnect() — e.g. the
    // connection screen calling connect() again), close the previous one BEFORE
    // opening another. Without this every connect() leaked a connection on the server,
    // which accumulated the same device N times in the connected list.
    if (this.ws) {
      const old = this.ws
      this.ws = null
      old.onopen = null
      old.onmessage = null
      old.onclose = null
      old.onerror = null
      if (old.readyState === WebSocket.OPEN || old.readyState === WebSocket.CONNECTING) {
        try {
          old.close()
        } catch { /* ignore */ }
      }
    }

    this.open()
  }

  /** Closes the connection (without reconnection). */
  disconnect(): void {
    this.shouldReconnect = false
    this.closedByUser = true
    this.cleanup()
    this.setState({ status: 'disconnected' })
  }

  /** Sends a request and waits for the correlated response. */
  send(request: CompanionRequest): Promise<ApiResponse> {
    return new Promise((resolve, reject) => {
      const id = newMessageId()
      const msg: WsMessage = { id, payload: request }

      if (this.state.status !== 'connected') {
        // Queue to send upon reconnecting — with a deadline. Without it the promise
        // stayed hanging until the next connection, and a "create chat" + "send"
        // from minutes before fired suddenly, creating a conversation and sending
        // a message when the person was already in another chat.
        const entry = {
          msg,
          resolve,
          reject,
          timer: setTimeout(() => {
            this.queuedRequests = this.queuedRequests.filter((q) => q !== entry)
            reject(new Error(`Request ${request.type} timed out (offline)`))
          }, REQUEST_TIMEOUT),
        }
        this.queuedRequests.push(entry)
        return
      }

      this.sendWithCorrelation(id, msg, resolve, reject)
    })
  }

  /** Subscribes to an event type from the server. */
  subscribe(eventType: string, handler: EventHandler): () => void {
    if (!this.eventHandlers.has(eventType)) {
      this.eventHandlers.set(eventType, new Set())
    }
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
   * comes back to the foreground. Connected: sends a ping and, without an answer in
   * a few seconds, drops it and reconnects. Gave up reconnecting (exhausted the
   * attempts while the app was idle): starts over from scratch.
   */
  checkAlive(): void {
    if (!this.config || this.closedByUser) return
    if (this.state.status === 'connected') {
      this.ping(ALIVE_CHECK_TIMEOUT)
      return
    }
    if (this.state.status === 'disconnected' && this.state.errorReason !== 'invalid_pin') {
      this.shouldReconnect = true
      this.reconnectAttempt = 0
      this.cleanup()
      this.open()
    }
  }

  /** Current state of the connection. */
  getState(): Readonly<ConnectionState> {
    return this.state
  }

  // Stores the token in the current config — reconnections (backoff) already use the token

  private open(): void {
    if (!this.config) return

    this.setState({ status: 'connecting' })
    const { host, port } = this.config
    const url = `ws://${host}:${port}`

    try {
      this.ws = new WebSocket(url)
    } catch (err) {
      this.setState({ status: 'disconnected', errorReason: 'socket_error', error: String(err) })
      this.scheduleReconnect()
      return
    }

    this.ws.onopen = () => {
      this.reconnectAttempt = 0
      this.authenticate()
    }

    this.ws.onmessage = (event) => {
      this.handleMessage(event.data)
    }

    this.ws.onclose = () => {
      this.cleanup()
      if (this.shouldReconnect) {
        this.scheduleReconnect()
      } else {
        this.setState({ status: 'disconnected' })
      }
    }

    this.ws.onerror = () => {
      // Unknown reason: keep the raw value for diagnostics (it is not
    }
  }

  private authenticate(): void {
    if (!this.config) return

    this.setState({ status: 'authenticating' })
    const authRequest: AuthRequest = {
      type: 'auth',
      pin: this.config.pin || undefined,
      token: this.config.token,
      deviceName: this.config.deviceName,
    }

    const id = newMessageId()
    const msg: WsMessage = { id, payload: authRequest }

    // displayable — the UI translates through errorReason).
    this.ws?.send(JSON.stringify(msg))
  }

  private handleMessage(raw: string): void {
    let msg: WsMessage
    try {
      msg = JSON.parse(raw) as WsMessage
    } catch {
      return
    }

    this.lastInbound = Date.now()
    const { payload } = msg

    // Heartbeat pong — updates latency
    if (payload.type === 'auth:ok') {
      const ok = payload as AuthOkResponse
      // Stores the token in the current config — reconnections (backoff) already use the token
      if (ok.deviceToken && this.config) {
        this.config = { ...this.config, token: ok.deviceToken }
      }
      this.setState({
        status: 'connected',
        serverVersion: ok.serverVersion,
        deviceName: ok.deviceName,
        deviceToken: ok.deviceToken,
      })
      this.startHeartbeat()
      this.flushQueue()
      return
    }

    if (payload.type === 'auth:error') {
      const reason = authErrorReason(payload.reason)
      this.setState({
        status: 'disconnected',
        errorReason: reason,
        // Unknown reason: keep the raw value for diagnostics (it is not
        // displayable — the UI translates through errorReason).
        error: reason === 'unknown' ? String(payload.reason) : undefined,
      })
      this.shouldReconnect = false
      this.cleanup()
      return
    }

    // Heartbeat pong — updates latency
    if ((payload as { type: string }).type === 'pong') {
      const now = Date.now()
      this.setState({ lastActivity: now, latency: now - this.lastPing })
      return
    }

    // API responses (correlated)
    if (payload.type === 'api:response') {
      const apiRes = payload as ApiResponse
      const pending = this.pendingRequests.get(apiRes.requestId)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingRequests.delete(apiRes.requestId)
        pending.resolve(apiRes)
      }
      return
    }

    // Events — broadcast to subscribers
    this.emit(payload.type, payload as CompanionEvent)
  }

  private sendWithCorrelation(
    id: string,
    msg: WsMessage,
    resolve: (v: ApiResponse) => void,
    reject: (e: Error) => void,
  ): void {
    const timer = setTimeout(() => {
      this.pendingRequests.delete(id)
      reject(new Error(`Request ${msg.payload.type} timed out`))
    }, REQUEST_TIMEOUT)

    this.pendingRequests.set(id, { resolve, reject, timer })

    try {
      this.ws?.send(JSON.stringify(msg))
    } catch (err) {
      clearTimeout(timer)
      this.pendingRequests.delete(id)
      reject(new Error(`Failed to send: ${err}`))
    }
  }

  private flushQueue(): void {
    const queue = [...this.queuedRequests]
    this.queuedRequests = []

    for (const { msg, resolve, reject, timer } of queue) {
      clearTimeout(timer)
      if (this.state.status === 'connected') {
        this.sendWithCorrelation(msg.id, msg, resolve, reject)
      } else {
        reject(new Error('Connection lost before queue flush'))
      }
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => this.ping(PONG_TIMEOUT), HEARTBEAT_INTERVAL)
  }

  /** Sends a ping and waits for ANY message from the desktop within the deadline
   *  (pong, response or event — everything proves the socket is alive). */
  private ping(timeout: number): void {
    if (this.pongTimer) return
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.dropDeadSocket()
      return
    }
    const sentAt = Date.now()
    this.lastPing = sentAt
    try {
      ws.send(JSON.stringify({ id: '', payload: { type: 'ping' } }))
    } catch {
      this.dropDeadSocket()
      return
    }
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null
      if (this.ws === ws && this.lastInbound < sentAt) this.dropDeadSocket()
    }, timeout)
  }

  /** Socket without an answer: closes it (rejecting what was pending, instead of
   *  letting each request die on its own timeout) and reconnects. */
  private dropDeadSocket(): void {
    if (!this.shouldReconnect) return
    this.cleanup()
    this.reconnectAttempt = 0
    this.setState({ status: 'connecting', reconnectAttempt: 0 })
    this.open()
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer)
      this.pongTimer = null
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return

    if (this.reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) {
      this.shouldReconnect = false
      // Only the code: the text (translated, with the attempt count
      // interpolated) is built by the app.
      this.setState({
        status: 'disconnected',
        errorReason: 'connect_failed',
        error: undefined,
        reconnectAttempt: this.reconnectAttempt,
      })
      return
    }

    const delay = Math.min(
      RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempt),
      RECONNECT_MAX_DELAY,
    )
    this.reconnectAttempt++
    this.setState({ reconnectAttempt: this.reconnectAttempt })

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.open()
    }, delay)
  }

  private cleanup(): void {
    this.stopHeartbeat()

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    // Reject all pending requests
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Connection closed'))
    }
    this.pendingRequests.clear()

    if (this.ws) {
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onclose = null
      this.ws.onerror = null

      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close()
      }
      this.ws = null
    }
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
    const handlers = this.eventHandlers.get(type)
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event)
        } catch { /* swallow */ }
      }
    }
    // Also emit to wildcard subscribers
    const wildcard = this.eventHandlers.get('*')
    if (wildcard) {
      for (const handler of wildcard) {
        try {
          handler(event)
        } catch { /* swallow */ }
      }
    }
  }
}
