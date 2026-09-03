/**
 * Protocolo compartilhado entre o servidor WebSocket do Orbit desktop
 * e o app companion (mobile/web). Define tipos de mensagem, eventos
 * e o handshake de autenticação.
 */

import type { SendMessageOptions, SessionMode, FilePart, WorkerModelConfig, ReasoningConfig, PermissionMode, PlanReview, OrchestrationPlan, AskItem } from './chat'
import type { AnalyticsRange } from './analytics'
import type { NovaRotinaInput, Rotina, RotinaEvent, RotinaModelo } from './rotinas'
import type {
  Esteira,
  EsteiraEvent,
  FaseTemplate,
  NovaEsteiraInput,
  NovaTaskInput,
  Projeto,
  Task,
} from './esteira'

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

/**
 * Estado da sessao que nao vem nas mensagens: plano de orquestracao, review de
 * plano e pedidos pendentes (permissao/pergunta). O mobile so conhecia os tres
 * pelos eventos ao vivo, entao ao reabrir a conversa — ou ao parear depois que
 * o card ja tinha sido emitido — os cards sumiam mesmo com o pedido pendente.
 */
export interface GetSessionStateRequest {
  type: 'session:state'
  sessionId: string
}

/** Pedido pendente como o desktop persiste: AskItem + agrupamento de lote. */
export type PendingAskState = AskItem & { batchId?: string }

export interface SessionStateResponse {
  planReview?: PlanReview
  plan?: OrchestrationPlan
  /** Lista autoritativa dos pedidos pendentes da sessao (vazia = nenhum). */
  pendingAsks?: PendingAskState[]
}

/**
 * Sessoes com engine rodando no desktop (chat, loop, orquestracao). O mobile so
 * sabia disso pelos eventos de status ao vivo: conectar no meio de uma execucao
 * mostrava a conversa parada, e reconectar depois dela terminar deixava o
 * spinner preso. Espelha o IPC 'chat:running' que o renderer usa apos reload.
 */
export interface GetRunningSessionsRequest {
  type: 'sessions:running'
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
  /** Modelo de visão delegado (modo Visão), configurado no app. */
  visionModel?: WorkerModelConfig
  /** Pasta principal (modo código) — persiste na sessão ao enviar. */
  directory?: string
  /** Pastas adicionais (modo código). */
  extraDirectories?: string[]
  /** Configuração do modo loop. Mesma forma que o SendMessageInput da engine —
   *  sem ela o desktop caía no padrão, ignorando o que foi configurado no app. */
  loopConfig?: { maxIterations: number }
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
  /** Sessão alvo da escolha — ausente/null = chat novo (draft + default global). */
  sessionId?: string | null
}

/** Modos ativáveis por chat que o desktop e os companions compartilham. Os
 *  seis primeiros vivem no mode-overrides; 'simple' e 'brain' têm store
 *  próprio em cada app, mas viajam no mesmo mapa. */
export type ChatModeKey =
  | 'search'
  | 'browser'
  | 'plan'
  | 'subagents'
  | 'orchestra'
  | 'vision'
  | 'simple'
  | 'brain'

/** modo → (sessionId → ativo). A chave 'draft' é o chat ainda sem sessão. */
export type SessionModeOverrides = Partial<Record<ChatModeKey, Record<string, boolean>>>

export interface SelectSessionModeRequest {
  type: 'modes:select'
  mode: ChatModeKey
  value: boolean
  /** Sessão alvo — ausente/null = chat novo (draft). */
  sessionId?: string | null
}

/** Modelo por chat empurrado pelo desktop aos companions. Estava sendo emitido
 *  e consumido sem tipo dos dois lados (`as any`), então uma mudança no formato
 *  passaria despercebida. */
export interface SessionModelChangeEvent {
  type: 'session:model-change'
  overrides: Record<string, { providerId: string; modelId: string }>
}

/** Mapa completo de modos por chat empurrado pelo desktop aos companions. */
export interface SessionModeChangeEvent {
  type: 'session:mode-change'
  overrides: SessionModeOverrides
}

/** Configuração global dos modos delegados: o modelo (e o thinking) dos
 *  workers de subagentes/orquestração e o modelo do modo Visão. Diferente dos
 *  modos, isto não é por chat — vale para o app inteiro. */
export interface WorkerConfigSnapshot {
  workerModel: WorkerModelConfig | null
  workerReasoning: ReasoningConfig | null
  visionModel: WorkerModelConfig | null
}

export interface SetWorkerConfigRequest {
  type: 'worker-config:set'
  config: WorkerConfigSnapshot
}

export interface WorkerConfigChangeEvent {
  type: 'worker-config:change'
  config: WorkerConfigSnapshot
}

/** Modos ligados por padrão num chat novo, por modo do app. Mesma forma nos
 *  dois apps (ActiveModeDefaults de cada model-mode-prefs). */
export interface ChatModeDefaults {
  simple: boolean
  brain: boolean
  thinking: boolean
  search: boolean
  browser: boolean
  plan: boolean
  subagents: boolean
  orchestra: boolean
  vision: boolean
}

/**
 * Preferencias do app que valem nos dois lados: defaults de modo por tipo de
 * chat, modo de permissao e criacao automatica de pastas. Antes cada app
 * guardava as suas (o /api/preferences do companion era um armazem paralelo que
 * ninguem no desktop lia), entao mudar no celular nao mudava nada no desktop.
 * O desktop e a fonte da verdade: elas vivem no renderer, e o celular espelha.
 */
export interface AppPreferences {
  chatModes: ChatModeDefaults
  codeModes: ChatModeDefaults
  permissionMode: PermissionMode
  autoCreateFolders: boolean
}

export interface GetAppPreferencesRequest {
  type: 'prefs:get'
}

export interface SetAppPreferencesRequest {
  type: 'prefs:set'
  prefs: AppPreferences
}

export interface AppPreferencesChangeEvent {
  type: 'prefs:change'
  prefs: AppPreferences
}

export interface GetCatalogRequest {
  type: 'catalog:get'
}

export interface GetAnalyticsRequest {
  type: 'analytics:summary'
  /** Presets ou intervalo customizado (type: 'custom', from/to em ms). */
  range?: AnalyticsRange
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

/** Arquiva/desarquiva a pasta. Os chats dela acompanham o estado — mesma
 *  cascata do toggleFolderArchive do desktop. */
export interface ArchiveFolderRequest {
  type: 'folders:archive'
  folderId: string
  archived: boolean
}

export interface DeleteFolderRequest {
  type: 'folders:delete'
  folderId: string
}

/** Reorganiza a sidebar: mescla pastas duplicadas do mesmo projeto e recolhe
 *  chats de código soltos para a pasta do projeto. Roda no renderer do
 *  desktop (o mapa de pastas automáticas mora no localStorage dele), então o
 *  companion-server só repassa o pedido. */
export interface OrganizeSidebarRequest {
  type: 'sidebar:organize'
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

// --- Git (branch da pasta de trabalho) ---------------------------------------

/** Branches locais da pasta de trabalho + a atual. */
export interface ListBranchesRequest {
  type: 'git:branches'
  directory: string
}

export interface BranchesResponse {
  branches: string[]
  current: string
}

/** Troca a branch. Falha (com a mensagem do git) se houver mudanca pendente
 *  que o checkout sobrescreveria — o mesmo comportamento do desktop. */
export interface CheckoutBranchRequest {
  type: 'git:checkout'
  directory: string
  branch: string
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

// ─── Rotinas ─────────────────────────────────────────────────────────────────

export interface ListRotinasRequest {
  type: 'rotinas:list'
}

export interface CreateRotinaRequest {
  type: 'rotinas:create'
  input: NovaRotinaInput
}

export interface UpdateRotinaRequest {
  type: 'rotinas:update'
  id: string
  patch: Partial<Rotina>
}

export interface DeleteRotinaRequest {
  type: 'rotinas:delete'
  id: string
}

/** "Executar agora" — mesma execução do scheduler, sem mexer na agenda. */
export interface RunRotinaRequest {
  type: 'rotinas:run'
  id: string
}

/** Descarta métricas de execuções cujo chat não existe mais. */
export interface PruneRotinasRequest {
  type: 'rotinas:prune-runs'
  sessionIds: string[]
}

export interface GenerateRotinaRequest {
  type: 'rotinas:generate'
  descricao: string
  modelo: RotinaModelo
  pastas: string[]
  idioma?: string
  modo?: 'chat' | 'code'
  visionDisponivel?: boolean
}

// ─── Esteira ─────────────────────────────────────────────────────────────────

/** Snapshot completo para o app abrir a tela de esteira numa tacada só. */
export interface ListEsteiraRequest {
  type: 'esteira:list'
}

export interface CreateEsteiraRequest {
  type: 'esteira:create'
  input: NovaEsteiraInput
}

export interface UpdateEsteiraRequest {
  type: 'esteira:update'
  id: string
  patch: Partial<Esteira>
}

export interface DeleteEsteiraRequest {
  type: 'esteira:delete'
  id: string
}

/** Cria um projeto (dono das pastas) — o fluxo "nova esteira" cria os dois. */
export interface CreateEsteiraProjetoRequest {
  type: 'esteira:create-projeto'
  nome: string
  pastas: string[]
}

export interface UpdateEsteiraProjetoRequest {
  type: 'esteira:update-projeto'
  id: string
  patch: Partial<Pick<Projeto, 'nome' | 'pastas'>>
}

export interface CreateEsteiraTaskRequest {
  type: 'esteira:create-task'
  input: NovaTaskInput
}

export interface UpdateEsteiraTaskRequest {
  type: 'esteira:update-task'
  esteiraId: string
  taskId: string
  patch: Partial<Pick<Task, 'titulo' | 'descricao' | 'dependeDe' | 'anotacoes'>>
}

export interface DeleteEsteiraTaskRequest {
  type: 'esteira:delete-task'
  esteiraId: string
  taskId: string
}

/** Inicia a task na fase indicada — `fase > 0` = início manual por drag (D8). */
export interface StartEsteiraTaskRequest {
  type: 'esteira:start-task'
  esteiraId: string
  taskId: string
  fase?: number
}

export interface PauseEsteiraTaskRequest {
  type: 'esteira:pause-task'
  esteiraId: string
  taskId: string
}

export interface ResumeEsteiraTaskRequest {
  type: 'esteira:resume-task'
  esteiraId: string
  taskId: string
}

export interface ToggleEsteiraFilaRequest {
  type: 'esteira:toggle-fila'
  esteiraId: string
  ligar: boolean
}

/** "Salvar como padrão" do editor de fase — grava/sobrescreve o template. */
export interface SaveEsteiraTemplateRequest {
  type: 'esteira:save-template'
  template: FaseTemplate
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
  | GetSessionStateRequest
  | GetRunningSessionsRequest
  | GetAppPreferencesRequest
  | SetAppPreferencesRequest
  | SendMessageRequest
  | CreateSessionRequest
  | AbortRequest
  | ApproveAskRequest
  | GetModelsRequest
  | SelectModelRequest
  | SelectSessionModeRequest
  | SetWorkerConfigRequest
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
  | ArchiveFolderRequest
  | DeleteFolderRequest
  | OrganizeSidebarRequest
  | ListBranchesRequest
  | CheckoutBranchRequest
  | ListDirsRequest
  | ListMemoriesRequest
  | UpdateMemoryRequest
  | DeleteMemoryRequest
  | PromoteMemoryRequest
  | GetMemoryDocRequest
  | ListRotinasRequest
  | CreateRotinaRequest
  | UpdateRotinaRequest
  | DeleteRotinaRequest
  | RunRotinaRequest
  | PruneRotinasRequest
  | GenerateRotinaRequest
  | ListEsteiraRequest
  | CreateEsteiraRequest
  | UpdateEsteiraRequest
  | DeleteEsteiraRequest
  | CreateEsteiraProjetoRequest
  | UpdateEsteiraProjetoRequest
  | CreateEsteiraTaskRequest
  | UpdateEsteiraTaskRequest
  | DeleteEsteiraTaskRequest
  | StartEsteiraTaskRequest
  | PauseEsteiraTaskRequest
  | ResumeEsteiraTaskRequest
  | ToggleEsteiraFilaRequest
  | SaveEsteiraTemplateRequest
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

/** Evento de rotina retransmitido do desktop (espelhos dos RotinaEvent). */
export interface RotinaEventMessage {
  type: 'rotinas:event'
  event: RotinaEvent
}

/** Evento de esteira retransmitido do desktop (espelhos dos EsteiraEvent):
 *  tasks concluindo, fases avançando, progresso/pensamento/tools ao vivo. */
export interface EsteiraEventMessage {
  type: 'esteira:event'
  event: EsteiraEvent
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
  | RotinaEventMessage
  | EsteiraEventMessage
  | PendingAskNotification
  | NewMessageNotification
  | SessionModelChangeEvent
  | SessionModeChangeEvent
  | WorkerConfigChangeEvent
  | AppPreferencesChangeEvent
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
