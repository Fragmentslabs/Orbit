/**
 * Protocolo compartilhado entre o servidor WebSocket do Orbit desktop
 * e o app companion (mobile/web). Define tipos de mensagem, eventos
 * e o handshake de autenticação.
 */

// ─── Handshake ───────────────────────────────────────────────────────────────

/** PIN gerado no desktop para pareamento (6 dígitos). */
export type PairingPin = string

/** Motivo de rejeição na autenticação. */
export type AuthRejectReason = 'invalid_pin' | 'already_paired' | 'rate_limited'

// ─── Client → Server (Requests) ──────────────────────────────────────────────

export interface AuthRequest {
  type: 'auth'
  pin: PairingPin
  deviceName?: string
}

export interface ListSessionsRequest {
  type: 'sessions:list'
}

export interface GetMessagesRequest {
  type: 'messages:get'
  sessionId: string
  limit?: number
}

export interface SendMessageRequest {
  type: 'messages:send'
  sessionId: string
  text: string
  providerId?: string
  modelId?: string
}

export interface AbortRequest {
  type: 'chat:abort'
  sessionId: string
}

export interface ApproveAskRequest {
  type: 'ask:reply'
  requestId: string
  value: unknown
}

export interface GetModelsRequest {
  type: 'models:list'
}

export interface SelectModelRequest {
  type: 'models:select'
  providerId: string
  modelId: string
}

export interface GetCatalogRequest {
  type: 'catalog:get'
}

export interface GetAnalyticsRequest {
  type: 'analytics:summary'
  range?: 'total' | '30d' | '7d' | 'today'
}

export interface GetStatusRequest {
  type: 'status:get'
}

export type CompanionRequest =
  | AuthRequest
  | ListSessionsRequest
  | GetMessagesRequest
  | SendMessageRequest
  | AbortRequest
  | ApproveAskRequest
  | GetModelsRequest
  | SelectModelRequest
  | GetCatalogRequest
  | GetAnalyticsRequest
  | GetStatusRequest

// ─── Server → Client (Responses + Events) ────────────────────────────────────

export interface AuthOkResponse {
  type: 'auth:ok'
  deviceName: string
  serverVersion: string
}

export interface AuthErrorResponse {
  type: 'auth:error'
  reason: AuthRejectReason
}

export interface ApiResponse {
  type: 'api:response'
  /** ID da requisição (para correlacionar request ↔ response) */
  requestId: string
  ok: boolean
  data?: unknown
  error?: string
}

/** Evento de chat retransmitido do desktop (espelhos dos ChatEvent). */
export interface ChatEventMessage {
  type: 'chat:event'
  event: unknown // ChatEvent do shared/chat.ts
}

/** Notificação de nova permissão/question pendente. */
export interface PendingAskNotification {
  type: 'notify:pending-ask'
  sessionId: string
  requestId: string
  kind: 'permission' | 'question'
  title: string
  questions?: unknown[]
}

/** Notificação de nova mensagem do assistente. */
export interface NewMessageNotification {
  type: 'notify:new-message'
  sessionId: string
  sessionTitle: string
  messagePreview: string
}

/** Status do desktop (online, sessões ativas, etc). */
export interface StatusUpdate {
  type: 'status:update'
  online: boolean
  activeSessions: number
  pendingAsks: number
  uptime: number
}

export type CompanionEvent =
  | AuthOkResponse
  | AuthErrorResponse
  | ApiResponse
  | ChatEventMessage
  | PendingAskNotification
  | NewMessageNotification
  | StatusUpdate

// ─── Wire Protocol ───────────────────────────────────────────────────────────

/** Mensagem envelopada no WebSocket (todas as mensagens passam por este envelope). */
export interface WsMessage {
  /** ID único da mensagem (para request/response matching). */
  id: string
  /** Payload: request do client ou response/event do server. */
  payload: CompanionRequest | CompanionEvent
}

// ─── Helper ──────────────────────────────────────────────────────────────────

let _msgId = 0
export function newMessageId(): string {
  return `msg_${Date.now().toString(36)}_${(++_msgId).toString(36)}`
}
