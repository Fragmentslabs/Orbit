/**
 * @orbit/companion-client — barrel export
 *
 * Cliente de comunicação mobile→desktop para o Orbit.
 * Fornece WebSocket (streaming, events) e HTTP (preferences, models).
 */

export { CompanionWebSocket } from './websocket-client'
export { CompanionHttp } from './http-client'
export type { HttpResult } from './http-client'
export { generateConnectionPayload, parseConnectionPayload, isValidPin } from './qr-code'
export type { QrPayload } from './qr-code'
export type { ConnectionConfig, ConnectionState } from './types'

// Re-export shared types commonly used alongside the client
export {
  newMessageId,
  type CompanionRequest,
  type CompanionEvent,
  type WsMessage,
  type ApiResponse,
} from '@orbit/shared'
