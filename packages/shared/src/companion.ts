/**
 * Protocolo compartilhado entre o servidor WebSocket do Orbit desktop
 * e o app companion (mobile/web). Define tipos de mensagem, eventos
 * e o handshake de autenticação.
 */

import type { SendMessageOptions, SessionMode, FilePart, WorkerModelConfig, PermissionMode } from './chat'

// ─── Handshake ───────────────────────────────────────────────────────────────

/** PIN gerado no desktop para pareamento (6 dígitos). */
export type PairingPin = string

/** Motivo de rejeição na autenticação. */
export type AuthRejectReason = 'invalid_pin' | 'already_paired' | 'rate_limited'

// ─── Client → Server (Requests) ──────────────────────────────────────────────

export interface AuthRequest {
  type: 'auth'
  /** PIN de pareamento — obrigatório apenas no primeiro pareamento. */
  pin?: PairingPin
  /** Token de dispositivo persistente, emitido no auth:ok do primeiro
   *  pareamento. Permite reconectar sem PIN (que expira em 5 min). */
  token?: string
  deviceName?: string
}

export interface ListSessionsRequest {
  type: 'sessions:list'
}

export interface SearchSessionsRequest {
  type: 'sessions:search'
  query: string
}

export interface GetMessagesRequest {
  type: 'messages:get'
  sessionId: string
  limit?: number
  /** Número de mensagens mais recentes já carregadas; usado para paginação para cima. */
  offset?: number
}

export interface SendMessageRequest {
  type: 'messages:send'
  sessionId: string
  text: string
  providerId?: string
  modelId?: string
  /** Modos do input (pesquisa, browser, thinking, simples, brain…). */
  options?: SendMessageOptions
  /** Arquivos anexados à mensagem do usuário */
  files?: FilePart[]
  /** Modelo dos workers (subagentes/orquestração), configurado no app. */
  workerModel?: WorkerModelConfig
  /** Pasta principal (modo código) — persiste na sessão ao enviar. */
  directory?: string
  /** Pastas adicionais (modo código). */
  extraDirectories?: string[]
}

export interface CreateSessionRequest {
  type: 'sessions:create'
  mode: SessionMode
  title?: string
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

export interface RenameSessionRequest {
  type: 'sessions:rename'
  sessionId: string
  title: string
}

export interface PinSessionRequest {
  type: 'sessions:pin'
  sessionId: string
  pinned: boolean
}

export interface ArchiveSessionRequest {
  type: 'sessions:archive'
  sessionId: string
  archived: boolean
}

export interface DeleteSessionRequest {
  type: 'sessions:delete'
  sessionId: string
}

export interface ForkSessionRequest {
  type: 'sessions:fork'
  sessionId: string
  messageId?: string
}

export interface MoveSessionToFolderRequest {
  type: 'sessions:move-folder'
  sessionId: string
  folderId: string | null
}

export interface ListFoldersRequest {
  type: 'folders:list'
}

export interface CreateFolderRequest {
  type: 'folders:create'
  mode: SessionMode
  name: string
}

export interface RenameFolderRequest {
  type: 'folders:rename'
  folderId: string
  name: string
}

export interface PinFolderRequest {
  type: 'folders:pin'
  folderId: string
  pinned: boolean
}

export interface DeleteFolderRequest {
  type: 'folders:delete'
  folderId: string
}

// ─── Memórias (Brain) ────────────────────────────────────────────────────────

export interface ListMemoriesRequest {
  type: 'memory:list'
}

export interface UpdateMemoryRequest {
  type: 'memory:update'
  id: string
  patch: { text?: string; tags?: string[]; weight?: number }
}

export interface DeleteMemoryRequest {
  type: 'memory:delete'
  id: string
}

export interface PromoteMemoryRequest {
  type: 'memory:promote'
  id: string
}

/** Busca o documento .md anexado de uma memória (hasDoc). */
export interface GetMemoryDocRequest {
  type: 'memory:doc'
  id: string
}

/** Lista subdiretórios de um caminho do DESKTOP (seletor de pastas do app). */
export interface ListDirsRequest {
  type: 'fs:list-dirs'
  /** Caminho absoluto no desktop — ausente = home do usuário. */
  path?: string
}

export interface ListDirsResponse {
  /** Caminho listado (resolvido). */
  path: string
  /** Diretório pai, ou null se já é a raiz. */
  parent: string | null
  /** Subdiretórios visíveis (sem ocultos). */
  dirs: { name: string; path: string }[]
}

export interface RevertSessionRequest {
  type: 'sessions:revert'
  sessionId: string
  messageId: string
}

export interface UnrevertSessionRequest {
  type: 'sessions:unrevert'
  sessionId: string
}

// ─── Plan Review (Modo Plano) ─────────────────────────────────────────────────

export interface ReadPlanFileRequest {
  type: 'plan:read-file'
  sessionId: string
}

export interface AcceptPlanReviewRequest {
  type: 'plan:review-accept'
  sessionId: string
  messageId: string
  permissionMode: PermissionMode
  providerId?: string
  modelId?: string
  orchestrate?: boolean
}

export interface RejectPlanReviewRequest {
  type: 'plan:review-reject'
  sessionId: string
}

export interface RevisePlanReviewRequest {
  type: 'plan:review-revise'
  sessionId: string
  messageId: string
  feedback: string
  permissionMode: PermissionMode
  providerId?: string
  modelId?: string
}

// ─── Orchestration ────────────────────────────────────────────────────────────

export interface ApproveOrchestrationRequest {
  type: 'orchestration:approve'
  sessionId: string
  planId: string
  taskIds?: string[]
}

export interface RejectOrchestrationRequest {
  type: 'orchestration:reject'
  sessionId: string
}

export type CompanionRequest =
  | AuthRequest
  | ListSessionsRequest
  | SearchSessionsRequest
  | GetMessagesRequest
  | SendMessageRequest
  | CreateSessionRequest
  | AbortRequest
  | ApproveAskRequest
  | GetModelsRequest
  | SelectModelRequest
  | GetCatalogRequest
  | GetAnalyticsRequest
  | GetStatusRequest
  | RenameSessionRequest
  | PinSessionRequest
  | ArchiveSessionRequest
  | DeleteSessionRequest
  | ForkSessionRequest
  | MoveSessionToFolderRequest
  | ListFoldersRequest
  | CreateFolderRequest
  | RenameFolderRequest
  | PinFolderRequest
  | DeleteFolderRequest
  | ListDirsRequest
  | ListMemoriesRequest
  | UpdateMemoryRequest
  | DeleteMemoryRequest
  | PromoteMemoryRequest
  | GetMemoryDocRequest
  | RevertSessionRequest
  | UnrevertSessionRequest
  | ReadPlanFileRequest
  | AcceptPlanReviewRequest
  | RejectPlanReviewRequest
  | RevisePlanReviewRequest
  | ApproveOrchestrationRequest
  | RejectOrchestrationRequest

// ─── Server → Client (Responses + Events) ────────────────────────────────────

export interface AuthOkResponse {
  type: 'auth:ok'
  deviceName: string
  serverVersion: string
  /** Token persistente do dispositivo — o app guarda e usa nas próximas
   *  conexões no lugar do PIN. */
  deviceToken?: string
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
