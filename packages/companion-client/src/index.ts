/**
 * @orbit/companion-client — barrel export
 *
 * Mobile→desktop communication client for Orbit.
 * Provides WebSocket (streaming, events) and HTTP (preferences, models).
 */

export { CompanionWebSocket } from './websocket-client'
export { CompanionHttp } from './http-client'
export type { HttpResult } from './http-client'
export { generateConnectionPayload, parseConnectionPayload, isValidPin } from './qr-code'
export type { QrPayload } from './qr-code'
export type { ConnectionConfig, ConnectionState, ConnectionErrorReason } from './types'

// Re-export shared types commonly used alongside the client
export {
  newMessageId,
  type CompanionRequest,
  type CompanionEvent,
  type WsMessage,
  type ApiResponse,
} from '@orbit/shared'

// Transport-agnostic connection core (shared by the phone and desktop peers)
export { ConnectionCore } from './connection-core'
export type {
  CoreSocket,
  SocketEvents,
  CoreHooks,
  CoreOptions,
  CoreStatus,
  Handshake,
  HandshakeOutcome,
  HeartbeatPolicy,
} from './connection-core'
export { backoffDelay, type BackoffPolicy } from './backoff'
