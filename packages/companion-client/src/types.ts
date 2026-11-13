/**
 * Internal types of companion-client.
 * Re-exports types from @orbit/shared and adds connection settings.
 */

import type { AuthRejectReason } from '@orbit/shared'

/** Configuration required to connect to the desktop. */
export interface ConnectionConfig {
  host: string
  port: number
  /** Pairing PIN — required only on the first pairing. */
  pin: string
  /** Persistent token issued by the desktop on the first pairing —
   *  when present, it authenticates without a PIN. */
  token?: string
  /** Device name (for display on the desktop). */
  deviceName?: string
  /**
   * Absolute HTTP base of the desktop's REST API. Defaults to
   * `http://<host>:<port + 1>` (the companion server). A desktop peer passes
   * `https://<host>:<port>` because its REST surface lives on the mutual-TLS
   * server, on the same port as the WebSocket.
   */
  httpUrl?: string
  /**
   * Custom fetch — the desktop main process injects one that presents the
   * pinned client certificate (mutual TLS). Defaults to the global fetch.
   */
  fetchImpl?: typeof fetch
}

/**
 * Structured reason of the connection failure.
 *
 * The first three come from the desktop `auth:error` (pairing); the rest are
 * failures of the client itself. The displayed text is the app's responsibility (i18n) —
 * this package only carries the code.
 */
export type ConnectionErrorReason =
  | AuthRejectReason
  /** Ran out of reconnection attempts (the desktop is probably closed). */
  | 'connect_failed'
  /** The socket did not even open (invalid address/port, WebSocket unavailable). */
  | 'socket_error'
  /** Failure the app cannot name (e.g. a newer desktop sent a new reason). */
  | 'unknown'

/** State of the WebSocket connection. */
export interface ConnectionState {
  status: 'disconnected' | 'connecting' | 'authenticating' | 'connected'
  /** Code of the failure reason — it is what the UI must translate. Present in
   *  any failure state. */
  errorReason?: ConnectionErrorReason
  /** Raw technical detail (runtime exception text). Do not display it directly: it only
   *  serves as a diagnostic when `errorReason` is 'socket_error'/'unknown'. */
  error?: string
  /** Server version reported in the handshake. */
  serverVersion?: string
  /** Name of the connected desktop. */
  deviceName?: string
  /** Persistent token issued/confirmed by the desktop in auth:ok —
   *  the app must save it and reuse it in the next connections. */
  deviceToken?: string
  /** Timestamp of the last activity (heartbeat). */
  lastActivity?: number
  /** Estimated latency in ms. */
  latency?: number
  /** Reconnection attempts since the last connect(). */
  reconnectAttempt?: number
}
