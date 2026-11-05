/**
 * Protocol shared between the Orbit desktop WebSocket server
 * and the companion app (mobile/web). Defines message types, events
 * and the authentication handshake.
 */

import type { SendMessageOptions, SessionMode, FilePart, WorkerModelConfig, ReasoningConfig, PermissionMode, PlanReview, OrchestrationPlan, AskItem, ModelRotation, RotationConfig, QueuedMessage, OrchestrationSettings } from './chat'
import type { VoiceEngineId, VoiceEngineStatus } from './voice'
import type { AnalyticsRange } from './analytics'
import type { NewRoutineInput, Routine, RoutineEvent, RoutineModel } from './routines'
import type {
  NewPipelineInput,
  PlannedTask,
  NewTaskInput,
  PhaseTemplate,
  Pipeline,
  PipelineEvent,
  Project,
  Task,
} from './pipeline'

// ─── Handshake ───────────────────────────────────────────────────────────────

/** PIN generated on the desktop for pairing (6 digits). */
export type PairingPin = string

/** Reason for rejection at authentication. */
export type AuthRejectReason = 'invalid_pin' | 'already_paired' | 'rate_limited'

// ─── Client → Server (Requests) ──────────────────────────────────────────────

export interface AuthRequest {
  type: 'auth'
  /** Pairing PIN — required only on the first pairing. */
  pin?: PairingPin
  /** Persistent device token, issued in the auth:ok of the first
   *  pairing. It allows reconnecting without a PIN (which expires in 5 min). */
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
 * Session state that does not come with the messages: orchestration plan, plan
 * review and pending requests (permission/question). The phone knew the three of
 * them only from the live events, so reopening the conversation — or pairing
 * after the card had already been emitted — made the cards vanish even with the
 * request still pending.
 */
export interface GetSessionStateRequest {
  type: 'session:state'
  sessionId: string
}

/** Pending request as the desktop persists it: AskItem + batch grouping. */
export type PendingAskState = AskItem & { batchId?: string }

export interface SessionStateResponse {
  planReview?: PlanReview
  plan?: OrchestrationPlan
  /** Authoritative list of the session's pending requests (empty = none). */
  pendingAsks?: PendingAskState[]
}

/**
 * Sessions with an engine running on the desktop (chat, loop, orchestration).
 * The phone knew that only from the live status events: connecting in the middle
 * of a run showed the conversation stopped, and reconnecting after it finished
 * left the spinner stuck. Mirrors the 'chat:running' IPC the renderer uses after
 * a reload.
 */
export interface GetRunningSessionsRequest {
  type: 'sessions:running'
}

export interface GetMessagesRequest {
  type: 'messages:get'
  sessionId: string
  limit?: number
  /** Number of most recent messages already loaded; used for paging upwards. */
  offset?: number
}

export interface SendMessageRequest {
  type: 'messages:send'
  sessionId: string
  text: string
  providerId?: string
  modelId?: string
  /** Input modes (search, browser, thinking, simple, brain…). */
  options?: SendMessageOptions
  /** Files attached to the user's message */
  files?: FilePart[]
  /** Workers' model (subagents/orchestration), configured in the app. */
  workerModel?: WorkerModelConfig
  /** Delegated vision model (Vision mode), configured in the app. */
  visionModel?: WorkerModelConfig
  /** Main folder (code mode) — persists in the session when sending. */
  directory?: string
  /** Additional folders (code mode). */
  extraDirectories?: string[]
  /** Loop mode configuration. Same shape as the engine's SendMessageInput —
   *  without it the desktop fell back to the default, ignoring what was configured in the app. */
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
  /** Target session of the choice — absent/null = new chat (draft + global default). */
  sessionId?: string | null
}

/** Modes switchable per chat that the desktop and the companions share. The
 *  first six live in the mode-overrides; 'simple' and 'brain' have their own
 *  store in each app, but travel in the same map. */
export type ChatModeKey =
  | 'search'
  | 'browser'
  | 'plan'
  | 'subagents'
  | 'orchestra'
  | 'vision'
  | 'simple'
  | 'brain'

/** mode → (sessionId → active). The 'draft' key is the chat still without a session. */
export type SessionModeOverrides = Partial<Record<ChatModeKey, Record<string, boolean>>>

export interface SelectSessionModeRequest {
  type: 'modes:select'
  mode: ChatModeKey
  value: boolean
  /** Target session — absent/null = new chat (draft). */
  sessionId?: string | null
}

/** Model per chat pushed by the desktop to the companions. It was being emitted
 *  and consumed without a type on both sides (`as any`), so a change in the format
 *  would go unnoticed. */
export interface SessionModelChangeEvent {
  type: 'session:model-change'
  overrides: Record<string, { providerId: string; modelId: string }>
}

/** Rotation chosen for a chat, made in a companion. Mirror of
 *  `models:select`: the rotations live in the desktop renderer (localStorage),
 *  so the phone's choice is applied there and comes back to everyone through the broadcast.
 *  A null `rotationId` undoes it (the chat goes back to the model). */
export interface SelectRotationRequest {
  type: 'rotation:select'
  rotationId: string | null
  /** Target session — absent/null = new chat (draft). */
  sessionId?: string | null
}

/** CRUD of rotations made in a companion: it sends the whole list, like
 *  `prefs:set`. The desktop renderer persists it and answers through the broadcast —
 *  it avoids one verb per operation and keeps a single source of truth. */
export interface SetRotationsRequest {
  type: 'rotation:set'
  rotations: ModelRotation[]
}

/** Complete state of the rotation (list + choice per chat) pushed by the
 *  desktop to the companions, in the same format the main receives from the renderer. */
export interface RotationChangeEvent {
  type: 'rotation:change'
  config: RotationConfig
}

/** Complete map of modes per chat pushed by the desktop to the companions. */
export interface SessionModeChangeEvent {
  type: 'session:mode-change'
  overrides: SessionModeOverrides
}

/** Reasoning preference of a model (toggle + chosen variant). */
export interface ModelReasoningPref {
  enabled: boolean
  variantId?: string
}

/** Thinking per model (key `providerId/modelId`) — the same map the two
 *  apps keep in localStorage/AsyncStorage as `orbit-reasoning-prefs`. */
export type ReasoningPrefsMap = Record<string, ModelReasoningPref>

/** Thinking toggle made in a companion — the desktop renderer is the source of
 *  truth (it persists and sends the whole map back to everyone through the broadcast). */
export interface SelectReasoningRequest {
  type: 'reasoning:select'
  providerId: string
  modelId: string
  pref: ModelReasoningPref
}

/** Complete map of thinking per model pushed by the desktop to the companions. */
export interface ReasoningPrefsChangeEvent {
  type: 'reasoning:change'
  prefs: ReasoningPrefsMap
}

// ─── Preferences PER CHAT (thinking and permission) ──────────────────────────
// Same design as the model and the modes per chat: the 'draft' key is the chat still
// without a session (and it does not travel between devices). The desktop renderer is the
// source of truth — the maps live in its localStorage —, pushes the snapshot on every
// change and applies what arrives from the companions.

/** sessionId → thinking preference of that chat. */
export type SessionReasoningMap = Record<string, ModelReasoningPref>

/** sessionId → autonomy level (ask/approve/full) of that chat. */
export type SessionPermissionMap = Record<string, PermissionMode>

export interface SessionPrefsSnapshot {
  reasoning: SessionReasoningMap
  permission: SessionPermissionMap
}

/** Preference of ONE chat changed in a companion. The renderer applies it in the right
 *  store and sends the whole snapshot back through 'session:prefs-change'. */
export interface SelectSessionPrefsRequest {
  type: 'session:prefs-select'
  /** Target session — absent/null = new chat (draft). */
  sessionId?: string | null
  reasoning?: ModelReasoningPref
  permission?: PermissionMode
}

/** Snapshot of the preferences per chat pushed by the desktop. */
export interface SessionPrefsChangeEvent {
  type: 'session:prefs-change'
  prefs: SessionPrefsSnapshot
}

// ─── Shared message queue ────────────────────────────────────────────────────
// The queue lives in the desktop renderer — it is what sends the next item when
// the session becomes free, so there is only ONE queue per chat, seen and edited
// the same way by the desktop and by the phone. The phone only stores locally what
// it wrote without connection, and delivers it here when it reconnects.

/** sessionId → items of the queue, in the order of sending. */
export type MessageQueueSnapshot = Record<string, QueuedMessage[]>

/** Queue operation made by a companion; the desktop applies it and sends the whole
 *  queue back to everyone through 'queue:change'. */
export type MessageQueueOp =
  | { op: 'enqueue'; sessionId: string; msg: QueuedMessage; front?: boolean }
  | { op: 'remove'; sessionId: string; msgId: string }
  | { op: 'move-to-front'; sessionId: string; msgId: string }
  | { op: 'update'; sessionId: string; msgId: string; text: string }
  | { op: 'send-now'; sessionId: string; msgId: string }

export interface GetMessageQueueRequest {
  type: 'queue:get'
}

export interface MessageQueueOpRequest {
  type: 'queue:op'
  op: MessageQueueOp
}

/** Whole queue pushed by the desktop on every change. Attachments travel without the
 *  content (empty `url`): a photo in data URL went along on every keystroke. */
export interface MessageQueueChangeEvent {
  type: 'queue:change'
  queues: MessageQueueSnapshot
}

/** Global configuration of the delegated modes: the model (and the thinking)
 *  of the subagent/orchestration workers and the Vision mode model. Unlike the
 *  modes, this is not per chat — it applies to the whole app. */
export interface WorkerConfigSnapshot {
  workerModel: WorkerModelConfig | null
  workerReasoning: ReasoningConfig | null
  visionModel: WorkerModelConfig | null
  /**
   * Conductor of the orchestra (planning and synthesis). Optional: an app that
   * does not know the field yet does not send it, and absent = keep what is there.
   */
  orchestratorModel?: WorkerModelConfig | null
  orchestratorReasoning?: ReasoningConfig | null
  /** Orchestrator behavior. Absent = keep what is there. */
  orchestration?: OrchestrationSettings
}

export interface SetWorkerConfigRequest {
  type: 'worker-config:set'
  config: WorkerConfigSnapshot
}

export interface WorkerConfigChangeEvent {
  type: 'worker-config:change'
  config: WorkerConfigSnapshot
}

/** Modes on by default in a new chat, per app mode. Same shape in both
 *  apps (ActiveModeDefaults of each model-mode-prefs). */
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
 * App preferences that are worth on both sides: mode defaults per type of
 * chat, permission mode and automatic folder creation. Before, each app
 * kept its own (the companion's /api/preferences was a parallel store that
 * nobody in the desktop read), so changing it on the phone changed nothing on the desktop.
 * The desktop is the source of truth: they live in the renderer, and the phone mirrors.
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
  /** Presets or a custom interval (type: 'custom', from/to in ms). */
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

/** Archives/unarchives the folder. Its chats follow the state — the same
 *  cascade as the desktop's toggleFolderArchive. */
export interface ArchiveFolderRequest {
  type: 'folders:archive'
  folderId: string
  archived: boolean
}

export interface DeleteFolderRequest {
  type: 'folders:delete'
  folderId: string
}

/** Reorganizes the sidebar: merges duplicate folders of the same project and collects
 *  loose code chats into the project folder. It runs in the desktop
 *  renderer (the map of automatic folders lives in its localStorage), so the
 *  companion-server only forwards the request. */
export interface OrganizeSidebarRequest {
  type: 'sidebar:organize'
}

// ─── Memories (Brain) ────────────────────────────────────────────────────────

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

/** Fetches the .md document attached to a memory (hasDoc). */
export interface GetMemoryDocRequest {
  type: 'memory:doc'
  id: string
}

/** Lists subdirectories of a path of the DESKTOP (folder picker of the app). */
export interface ListDirsRequest {
  type: 'fs:list-dirs'
  /** Absolute path on the desktop — absent = the user's home. */
  path?: string
}

export interface ListDirsResponse {
  /** Listed path (resolved). */
  path: string
  /** Parent directory, or null if it is already the root. */
  parent: string | null
  /** Visible subdirectories (no hidden ones). */
  dirs: { name: string; path: string }[]
}

// --- Git (branch of the working folder) -------------------------------------

/** Local branches of the working folder + the current one. */
export interface ListBranchesRequest {
  type: 'git:branches'
  directory: string
}

export interface BranchesResponse {
  branches: string[]
  current: string
}

/** Switches the branch. It fails (with the git message) if there is a pending change
 *  that the checkout would overwrite — the same behavior as the desktop. */
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

/** Also reverts the files of uncertain author of the active revert. */
export interface RevertUncertainSessionRequest {
  type: 'sessions:revertUncertain'
  sessionId: string
}

// ─── Routines ────────────────────────────────────────────────────────────────

export interface ListRoutinesRequest {
  type: 'routines:list'
}

export interface CreateRoutineRequest {
  type: 'routines:create'
  input: NewRoutineInput
}

export interface UpdateRoutineRequest {
  type: 'routines:update'
  id: string
  patch: Partial<Routine>
}

export interface DeleteRoutineRequest {
  type: 'routines:delete'
  id: string
}

/** "Run now" — the same execution the scheduler does, without touching the schedule. */
export interface RunRoutineRequest {
  type: 'routines:run'
  id: string
}

/** Drops the metrics of runs whose chat no longer exists. */
export interface PruneRoutinesRequest {
  type: 'routines:prune-runs'
  sessionIds: string[]
}

export interface GenerateRoutineRequest {
  type: 'routines:generate'
  description: string
  model: RoutineModel
  folders: string[]
  language?: string
  mode?: 'chat' | 'code'
  visionAvailable?: boolean
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

/** Full snapshot so the app can open the pipeline screen in one shot. */
export interface ListPipelineRequest {
  type: 'pipeline:list'
}

export interface CreatePipelineRequest {
  type: 'pipeline:create'
  input: NewPipelineInput
}

export interface UpdatePipelineRequest {
  type: 'pipeline:update'
  id: string
  patch: Partial<Pipeline>
}

export interface DeletePipelineRequest {
  type: 'pipeline:delete'
  id: string
}

/** Creates a project (owner of the folders) — the "new pipeline" flow creates both. */
export interface CreatePipelineProjectRequest {
  type: 'pipeline:create-project'
  name: string
  folders: string[]
}

export interface UpdatePipelineProjectRequest {
  type: 'pipeline:update-project'
  id: string
  patch: Partial<Pick<Project, 'name' | 'folders'>>
}

export interface CreatePipelineTaskRequest {
  type: 'pipeline:create-task'
  input: NewTaskInput
}

export interface UpdatePipelineTaskRequest {
  type: 'pipeline:update-task'
  pipelineId: string
  taskId: string
  patch: Partial<Pick<Task, 'title' | 'description' | 'dependsOn' | 'notes'>>
}

export interface DeletePipelineTaskRequest {
  type: 'pipeline:delete-task'
  pipelineId: string
  taskId: string
}

/** Starts the task at the given phase — `phase > 0` = manual start by drag (D8). */
export interface StartPipelineTaskRequest {
  type: 'pipeline:start-task'
  pipelineId: string
  taskId: string
  phase?: number
}

export interface PausePipelineTaskRequest {
  type: 'pipeline:pause-task'
  pipelineId: string
  taskId: string
}

export interface ResumePipelineTaskRequest {
  type: 'pipeline:resume-task'
  pipelineId: string
  taskId: string
}

export interface TogglePipelineQueueRequest {
  type: 'pipeline:toggle-queue'
  pipelineId: string
  enabled: boolean
}

/** "Save as default" of the phase editor — writes/overwrites the template. */
export interface SavePipelineTemplateRequest {
  type: 'pipeline:save-template'
  template: PhaseTemplate
}

// Integration branch, Merge button, history and planner (mirror of the desktop IPC).

export interface PipelineHasGitRequest {
  type: 'pipeline:has-git'
  folder: string
}

export interface PipelineDeliveriesRequest {
  type: 'pipeline:deliveries'
  pipelineId: string
}

export interface PipelineIntegrationRequest {
  type: 'pipeline:integration'
  pipelineId: string
}

export interface PipelineDestinationsRequest {
  type: 'pipeline:destinations'
  pipelineId: string
}

export interface PipelineMergeRequest {
  type: 'pipeline:merge'
  pipelineId: string
  destination?: string
}

export interface PipelineCommitIntegrationRequest {
  type: 'pipeline:commit-integration'
  pipelineId: string
}

export interface PipelineRetryIntegrationRequest {
  type: 'pipeline:retry-integration'
  pipelineId: string
  taskId: string
}

export interface PipelineArchiveCompletedRequest {
  type: 'pipeline:archive-completed'
  pipelineId: string
}

export interface PipelineDeleteDeliveryRequest {
  type: 'pipeline:delete-delivery'
  pipelineId: string
  deliveryId: string
}

export interface PipelineReopenTaskRequest {
  type: 'pipeline:reopen-task'
  pipelineId: string
  taskId: string
}

export interface PipelineTaskDiffRequest {
  type: 'pipeline:task-diff'
  pipelineId: string
  taskId: string
}

export interface PipelineRemoveTaskImageRequest {
  type: 'pipeline:remove-task-image'
  pipelineId: string
  taskId: string
  url: string
}

/** Asks the pipeline model to split a request into tasks (nothing is created yet). */
export interface PipelinePlanTasksRequest {
  type: 'pipeline:plan-tasks'
  pipelineId: string
  request: string
}

export interface PipelineCreatePlannedRequest {
  type: 'pipeline:create-planned'
  pipelineId: string
  tasks: PlannedTask[]
}

// ─── Plan Review (Plan mode) ──────────────────────────────────────────────────

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

/** "Continue" on a plan that stopped halfway (the app closed, or the run was cut). */
export interface ResumeOrchestrationRequest {
  type: 'orchestration:resume'
  sessionId: string
  providerId?: string
  modelId?: string
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
  | SelectReasoningRequest
  | SelectSessionPrefsRequest
  | SelectRotationRequest
  | SetRotationsRequest
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
  | ListRoutinesRequest
  | CreateRoutineRequest
  | UpdateRoutineRequest
  | DeleteRoutineRequest
  | RunRoutineRequest
  | PruneRoutinesRequest
  | GenerateRoutineRequest
  | ListPipelineRequest
  | CreatePipelineRequest
  | UpdatePipelineRequest
  | DeletePipelineRequest
  | CreatePipelineProjectRequest
  | UpdatePipelineProjectRequest
  | CreatePipelineTaskRequest
  | UpdatePipelineTaskRequest
  | DeletePipelineTaskRequest
  | StartPipelineTaskRequest
  | PausePipelineTaskRequest
  | ResumePipelineTaskRequest
  | TogglePipelineQueueRequest
  | SavePipelineTemplateRequest
  | PipelineHasGitRequest
  | PipelineDeliveriesRequest
  | PipelineIntegrationRequest
  | PipelineDestinationsRequest
  | PipelineMergeRequest
  | PipelineCommitIntegrationRequest
  | PipelineRetryIntegrationRequest
  | PipelineArchiveCompletedRequest
  | PipelineDeleteDeliveryRequest
  | PipelineReopenTaskRequest
  | PipelineTaskDiffRequest
  | PipelineRemoveTaskImageRequest
  | PipelinePlanTasksRequest
  | PipelineCreatePlannedRequest
  | RevertSessionRequest
  | UnrevertSessionRequest
  | RevertUncertainSessionRequest
  | ReadPlanFileRequest
  | AcceptPlanReviewRequest
  | RejectPlanReviewRequest
  | RevisePlanReviewRequest
  | ApproveOrchestrationRequest
  | RejectOrchestrationRequest
  | ResumeOrchestrationRequest
  | GetMessageQueueRequest
  | MessageQueueOpRequest

// ─── Server → Client (Responses + Events) ────────────────────────────────────

export interface AuthOkResponse {
  type: 'auth:ok'
  deviceName: string
  serverVersion: string
  /** Persistent token of the device — the app keeps it and uses it on the next
   *  connections instead of the PIN. */
  deviceToken?: string
}

export interface AuthErrorResponse {
  type: 'auth:error'
  reason: AuthRejectReason
}

export interface ApiResponse {
  type: 'api:response'
  /** Request ID (to correlate request ↔ response) */
  requestId: string
  ok: boolean
  data?: unknown
  error?: string
}

/** Chat event relayed from the desktop (mirrors of ChatEvent). */
export interface ChatEventMessage {
  type: 'chat:event'
  event: unknown // ChatEvent from shared/chat.ts
}

/** Routine event relayed from the desktop (mirrors of the RoutineEvent). */
export interface RoutineEventMessage {
  type: 'routines:event'
  event: RoutineEvent
}

/** Pipeline event relayed from the desktop (mirrors of the PipelineEvent):
 *  tasks finishing, phases advancing, progress/thinking/tools live. */
export interface PipelineEventMessage {
  type: 'pipeline:event'
  event: PipelineEvent
}

/** Notification of a new pending permission/question. */
export interface PendingAskNotification {
  type: 'notify:pending-ask'
  sessionId: string
  requestId: string
  kind: 'permission' | 'question'
  /**
   * Text of the request (claim or first question). Empty when the item does not bring its own
   * text — in that case the mobile app applies its translated fallback,
   * which is the language of the phone (the desktop translates its own, see lib/i18n.ts).
   */
  title: string
  questions?: unknown[]
}

/** Notification of a new assistant message. */
export interface NewMessageNotification {
  type: 'notify:new-message'
  sessionId: string
  sessionTitle: string
  messagePreview: string
}

/** Desktop status (online, active sessions, etc). */
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
  | RoutineEventMessage
  | PipelineEventMessage
  | PendingAskNotification
  | NewMessageNotification
  | SessionModelChangeEvent
  | SessionModeChangeEvent
  | ReasoningPrefsChangeEvent
  | SessionPrefsChangeEvent
  | RotationChangeEvent
  | WorkerConfigChangeEvent
  | AppPreferencesChangeEvent
  | MessageQueueChangeEvent
  | StatusUpdate

// ─── Voice (STT) ─────────────────────────────────────────────────────────────
// Dictation of the companion app: the phone records, converts to mono PCM16 and sends the
// base64 through the REST route POST /api/voice/transcribe; the transcription runs on
// the desktop, with a local engine (see docs/voice.md). No audio leaves for the cloud.

/** Body of POST /api/voice/transcribe. */
export interface VoiceTranscribeRequest {
  /** PCM16 audio with sign, little-endian, in base64. */
  pcm: string
  /** Sample rate of the PCM, in Hz (the app records at 16 kHz). */
  sampleRate: number
  /** Transcription engine; absent = the desktop default. */
  engine?: VoiceEngineId
  modelId?: string | null
  /** Expected language (e.g. 'pt'); absent = automatic detection. */
  language?: string
}

/** Response of POST /api/voice/transcribe. */
export interface VoiceTranscribeResponse {
  /** Recognized text (empty string when nobody spoke). */
  text: string
  /** Duration of the received audio, in milliseconds. */
  audioMs: number
  /** Time spent in the transcription, in milliseconds. */
  ms: number
}

/**
 * Body of POST /api/voice/speak — reading aloud from the phone.
 *
 * The device does not run a voice engine: it sends the TEXT and receives the URL of a WAV
 * synthesized on the desktop, served by the `audio` scope with a token in the path (the
 * same route the player already uses for the agent's audio).
 */
export interface VoiceSpeakRequest {
  /** Text to speak. Empty is 400. */
  text: string
  /** Voice M1–M5 / F1–F5; absent = the voice from the desktop preferences. */
  voice?: string
  /** Language (`pt`, `en`, …) or `auto`; absent = the one from the preferences. */
  lang?: string
  /** Speed factor 0.5–2; absent = the one from the preferences. */
  speed?: number
}

/** Response of POST /api/voice/speak. */
export interface VoiceSpeakResponse {
  /** Id of the WAV in the audio collection (`aud_….wav`). */
  id: string
  /** Absolute and signed URL — the player opens it directly, with Range. */
  url: string
  /** Duration of the audio, in milliseconds. */
  durationMs: number
  /**
   * It was already synthesized (same text, same voice): the response came from the desktop
   * cache and there was no new synthesis. Useful for diagnosis, not for the UI.
   */
  cached: boolean
}

/**
 * Why POST /api/voice/speak refused.
 *
 * The desktop sends the CODE, not the sentence: the message the person reads is written
 * by whoever knows which language they are reading in — the app. A ready sentence here
 * would arrive in Portuguese on the screen of someone using the phone in English.
 */
export type VoiceSpeakErrorCode =
  | 'tts_disabled'
  | 'voice_unavailable'
  | 'invalid_text'
  | 'text_too_long'
  | 'invalid_voice'
  | 'invalid_lang'
  | 'invalid_speed'

/** Error body of POST /api/voice/speak. */
export interface VoiceSpeakErrorResponse {
  /** Stable code, translated by the app. It is never a sentence. */
  error: VoiceSpeakErrorCode
  /**
   * Technical detail of the engine (from the bottom of the stack), for the log. It may come in the
   * desktop's language and must NOT go to the screen.
   */
  detail?: string
}

/**
 * Response of GET /api/voice/status.
 *
 * `engines` is the same portrait the voice screen of the desktop uses
 * (`VoiceEngineStatus`, from @shared/voice): the app shows the reason when
 * dictation is not ready (engine without a binary, model not downloaded).
 */
export interface VoiceStatusResponse {
  /** There is at least one engine able to transcribe now. */
  ready: boolean
  engines: VoiceEngineStatus[]
}

// ─── Wire Protocol ───────────────────────────────────────────────────────────

/** Message wrapped in the WebSocket (all messages go through this envelope). */
export interface WsMessage {
  /** Unique ID of the message (for request/response matching). */
  id: string
  /** Payload: request from the client or response/event from the server. */
  payload: CompanionRequest | CompanionEvent
}

// ─── Helper ──────────────────────────────────────────────────────────────────

let _msgId = 0
/**
 * `error` of `messages:send` when the session is still running on the desktop.
 * A new send in a running session ABORTS the current turn (that is how the
 * engine switches turns), so the desktop refuses and the app gives the message back to the
 * queue until the session becomes free.
 */
export const SESSION_BUSY_ERROR = 'session_busy'

export function newMessageId(): string {
  return `msg_${Date.now().toString(36)}_${(++_msgId).toString(36)}`
}
