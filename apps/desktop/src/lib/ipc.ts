import type { MotionPropsInfo } from "./motion-props-form"
import type {
  Catalog,
  CatalogProvider,
  ChatEvent,
  ChatMessage,
  CustomProviderInput,
  CustomProviderPatch,
  DiscoveredModel,
  ModelRotation,
  ProviderProtocol,
  RotationConfig,
  SearchHit,
  ReasoningConfig,
  SendMessageInput,
  SessionRevert,
  UnrevertResult,
} from "@shared/chat"
import { normalizeAppSettings, type AppSettings } from "@shared/app-settings"
import { AGENT_CHANNELS, type AgentDefinition, type AgentGenerationResult, type AgentInput, type AgentsSnapshot, type BuiltinOverride } from "@shared/agents"
import { ARTIFACT_CHATS_CHANNELS, type ArtifactChats, type ArtifactChatsEvent, type ArtifactRef } from "@shared/artifacts"
import type { ComputerActivity, ComputerEvent, ComputerShot, ComputerStatus, ComputerTestResult } from "@shared/computer"
import type { AppPreferences, ChatModeKey, MessageQueueOp, MessageQueueSnapshot, ModelReasoningPref, ReasoningPrefsMap, SessionModeOverrides, SessionPrefsSnapshot, WorkerConfigSnapshot } from "@shared/companion"
import type { CreateWorktreeResult, WorktreeList, ValidateWorktreesFolder } from "@shared/worktrees"
import type { McpConfig, McpGenerationResult, McpServerStatus } from "@shared/mcp"
import type { PeerGrants, PeersEvent, PeersSnapshot, RemoteFileContent, RemoteFileTree } from "@shared/peers"
import type { DocumentDownload, MaterialView, MediaEntry, MediaFilter, MediaUsage, MotionBundle } from "@shared/media"
import type {
  Delivery,
  MergeOutcome,
  NewTaskInput,
  PhaseChoice,
  PlannedTask,
  PhaseTemplate,
  Pipeline,
  PipelineEvent,
  PipelineReport,
  Project,
  Task,
} from "@shared/pipeline"
import type { NodaraStatus } from "@shared/nodara"
import type { FractaStatus } from "@shared/fracta"
import type {
  NewRoutineInput,
  PendingRoutine,
  Routine,
  RoutineEvent,
  RoutineRun,
  ScriptActivity,
  ScriptTestResult,
} from "@shared/routines"
import type { InitEvent, InitStatus, Memory, MemoryEvent } from "@shared/memory"
import type { Skill, SkillCard, SkillGenerationResult, SkillMetaView, SkillProposal } from "@shared/skills"
import type { Hook, HookGenerationResult, HookInput, HookWithRun } from "@shared/hooks"
import type { AnalyticsSummary, AnalyticsRange, UsageSummaryRequest, UsageSummaryResponse } from "@shared/analytics"
import type { OverlayContext, OverlayEvent, OverlaySettings } from "@shared/overlay"
import type { PanelEvent } from "@/src/stores/panel-store"
import type {
  FragmentCallInput,
  FragmentCallResult,
  FragmentCapability,
  FragmentLogEntry,
  FragmentManifest,
  FragmentMetaPatch,
  FragmentUpdatedEvent,
} from "@shared/fragments"
import type { FragmentDataEntry, FragmentDetails, FragmentRevisionInfo } from "@shared/fragment-details"
import type { FragmentProvenance } from "@shared/fragment-provenance"

export type { SearchHit }

/** Actions triggered by the native macOS menu (menu:action). */
export type MenuAction =
  | "settings"
  | "new-chat"
  | "new-code"
  | "view-chats"
  | "view-memories"
  | "how-to"

/** Typed wrapper over the IPC bridge exposed by the preload. */

export const windowApi = {
  platform: window.platform,
  /** Native folder picker (main). `null` when the person cancels. */
  selectFolder: () =>
    (window.ipcRenderer?.invoke("select-folder") ?? Promise.resolve(null)) as Promise<string | null>,
  minimize: () => window.ipcRenderer?.invoke("window:minimize"),
  maximize: () => window.ipcRenderer?.invoke("window:maximize"),
  close: () => window.ipcRenderer?.invoke("window:close"),
  isMaximized: () => (window.ipcRenderer?.invoke("window:isMaximized") ?? Promise.resolve(false)) as Promise<boolean>,
  toggleFullscreen: () => window.ipcRenderer?.invoke("window:toggleFullscreen"),
  isFullscreen: () =>
    (window.ipcRenderer?.invoke("window:isFullscreen") ?? Promise.resolve(false)) as Promise<boolean>,
  onFullscreenChange: (listener: (fullscreen: boolean) => void) => {
    if (!window.ipcRenderer) return () => {}
    const wrapper = window.ipcRenderer.on("window:fullscreen-change", (fullscreen) =>
      listener(fullscreen as boolean),
    )
    return () => window.ipcRenderer.off("window:fullscreen-change", wrapper)
  },
  onMaximizedChange: (listener: (maximized: boolean) => void) => {
    if (!window.ipcRenderer) return () => {}
    const wrapper = window.ipcRenderer.on("window:maximized-change", (maximized) => listener(maximized as boolean))
    return () => window.ipcRenderer.off("window:maximized-change", wrapper)
  },
  /** Folder opened via "Open with Orbit" (Explorer) or a second instance */
  onOpenFolder: (listener: (directory: string) => void) => {
    if (!window.ipcRenderer) return () => {}
    const wrapper = window.ipcRenderer.on("app:open-folder", (directory) => listener(directory as string))
    return () => window.ipcRenderer.off("app:open-folder", wrapper)
  },
  /** App version (the same as package.json/artifacts) — shown in About */
  version: () => (window.ipcRenderer?.invoke("app:version") ?? Promise.resolve("")) as Promise<string>,
  /** Fetches the pending folder from the cold start (app started from Explorer) */
  consumePendingOpen: () =>
    (window.ipcRenderer?.invoke("app:consumePendingOpen") ?? Promise.resolve(null)) as Promise<string | null>,
  /** Native macOS menu actions (the menu bar at the top of the screen) */
  onMenuAction: (listener: (action: MenuAction) => void) => {
    if (!window.ipcRenderer) return () => {}
    const wrapper = window.ipcRenderer.on("menu:action", (action) => listener(action as MenuAction))
    return () => window.ipcRenderer.off("menu:action", wrapper)
  },
}

/** "Open with Orbit" integration in the Explorer context menu (Windows) */
export const openWithApi = {
  status: () =>
    window.ipcRenderer.invoke("openwith:status") as Promise<{ supported: boolean; registered: boolean; error?: string }>,
  register: () =>
    window.ipcRenderer.invoke("openwith:register") as Promise<{ ok: boolean; error?: string }>,
  unregister: () =>
    window.ipcRenderer.invoke("openwith:unregister") as Promise<{ ok: boolean; error?: string }>,
}

/**
 * Global shortcut overlay (⇧⌘space). The window belongs to main; the panel renderer
 * asks to close, to resize (the height follows the content) and listens to the
 * context main assembles on open — the selection is already read over there, because
 * after the focus the front app becomes Orbit.
 */
export const overlayApi = {
  /** The renderer mounted: main only sends `overlay:open` after this. */
  ready: () => window.ipcRenderer.send("overlay:ready"),
  toggle: () => window.ipcRenderer.invoke("overlay:toggle"),
  open: (call?: boolean) => window.ipcRenderer.invoke("overlay:open", call),
  close: () => window.ipcRenderer.invoke("overlay:close"),
  /** Content height; the window keeps the bottom edge anchored. */
  resize: (height: number) => window.ipcRenderer.invoke("overlay:resize", height),
  status: () =>
    window.ipcRenderer.invoke("overlay:status") as Promise<{ shortcut: string; ok: boolean; error?: string }>,
  settings: () => window.ipcRenderer.invoke("overlay:settings") as Promise<OverlaySettings>,
  /** Copy the answer (the renderer clipboard requires a gesture/allows it). */
  copy: (text: string) => window.ipcRenderer.invoke("clipboard:write", text) as Promise<void>,
  onOpen: (listener: (context: OverlayContext) => void) => {
    const wrapper = window.ipcRenderer.on("overlay:open", (payload) => listener(payload as OverlayContext))
    return () => window.ipcRenderer.off("overlay:open", wrapper)
  },
  onEvent: (listener: (event: OverlayEvent) => void) => {
    const wrapper = window.ipcRenderer.on("overlay:event", (payload) => listener(payload as OverlayEvent))
    return () => window.ipcRenderer.off("overlay:event", wrapper)
  },
}

export const sound = {
  play: (name: string) =>
    (window.ipcRenderer?.invoke("sound:play", name) ?? Promise.resolve(false)) as Promise<boolean>,
  /** Bytes of the input WAV — decoded in the renderer (WebAudio), which schedules
   *  the playback in the same tick as the persona wake-up. */
  entranceData: () =>
    (window.ipcRenderer?.invoke("sound:entrance-data") ?? Promise.resolve(null)) as Promise<Uint8Array | null>,
}

export const storage = {
  read: <T>(key: string) => window.ipcRenderer.invoke("storage:read", key) as Promise<T | null>,
  write: (key: string, value: unknown) => window.ipcRenderer.invoke("storage:write", key, value),
  remove: (key: string) => window.ipcRenderer.invoke("storage:remove", key),
  list: (prefix: string) => window.ipcRenderer.invoke("storage:list", prefix) as Promise<string[]>,
}

export const appSettingsApi = {
  sync: (settings: AppSettings) => window.ipcRenderer?.send("settings:sync", settings),
  /**
   * Change made IN MAIN — today only the agent's `set_user_name` tool, which writes
   * the name into the same field as the Preference. The renderer is the source of truth,
   * so without this the new name would be erased on the next `sync`.
   */
  onChange: (listener: (settings: AppSettings) => void) => {
    if (!window.ipcRenderer) return () => {}
    const wrapper = window.ipcRenderer.on("settings:changed", (raw) => listener(normalizeAppSettings(raw)))
    return () => window.ipcRenderer.off("settings:changed", wrapper)
  },
  /** Erases cookies, logins and cache of the built-in browser */
  clearBrowserData: () => window.ipcRenderer.invoke("browser:clear-data") as Promise<void>,
  /** Link clicked in the app that should open in the built-in browser */
  onLinkOpen: (listener: (url: string) => void) => {
    if (!window.ipcRenderer) return () => {}
    const wrapper = window.ipcRenderer.on("link:open", (url) => listener(url as string))
    return () => window.ipcRenderer.off("link:open", wrapper)
  },
  openExternal: (url: string) => window.ipcRenderer?.send("link:open-external", url),
}

/** Computer control (Computer Use): state, permissions and the Stop button. */
export const computerApi = {
  status: () => window.ipcRenderer.invoke("computer:status") as Promise<ComputerStatus>,
  test: () => window.ipcRenderer.invoke("computer:test") as Promise<ComputerTestResult>,
  /** Last screenshot of the conversation with the marker of the last action (main memory only) */
  shot: (sessionId: string) => window.ipcRenderer.invoke("computer:shot", sessionId) as Promise<ComputerShot | null>,
  /** Brings the thumbnail's app to the front (the chip popover's button) */
  focusApp: (sessionId: string) => window.ipcRenderer.invoke("computer:focus-app", sessionId) as Promise<boolean>,
  /** Answer typed in the floating panel: it enters the conversation queue with the options of its last send */
  reply: (sessionId: string, text: string) => window.ipcRenderer.invoke("computer:reply", sessionId, text) as Promise<boolean>,
  /** Sessions controlling right now (for the chip after a reload) */
  activity: () => window.ipcRenderer.invoke("computer:activity") as Promise<ComputerActivity[]>,
  /** Stops the control (and the turn) of a session — without an id, of all of them */
  stop: (sessionId?: string) => window.ipcRenderer.invoke("computer:stop", sessionId) as Promise<void>,
  requestAccessibility: () => window.ipcRenderer.invoke("computer:request-accessibility") as Promise<boolean>,
  /** Creates the app entry in Screen Recording and opens the panel */
  requestScreen: () => window.ipcRenderer.invoke("computer:request-screen") as Promise<{ granted: boolean }>,
  openPane: (pane: "accessibility" | "screen") => window.ipcRenderer.invoke("computer:open-pane", pane) as Promise<void>,
  onEvent: (listener: (event: ComputerEvent) => void) => {
    if (!window.ipcRenderer) return () => {}
    const wrapper = window.ipcRenderer.on("computer:event", (event) => listener(event as ComputerEvent))
    return () => window.ipcRenderer.off("computer:event", wrapper)
  },
}

export const catalogApi = {
  get: () => window.ipcRenderer.invoke("catalog:get") as Promise<Catalog>,
  /** Main updated the catalog in the background (models.dev, every 24h) */
  onUpdated: (listener: () => void) => {
    if (!window.ipcRenderer) return () => {}
    const wrapper = window.ipcRenderer.on("catalog:updated", () => listener())
    return () => window.ipcRenderer.off("catalog:updated", wrapper)
  },
}

export const authApi = {
  set: (providerId: string, key: string) => window.ipcRenderer.invoke("auth:set", providerId, key),
  remove: (providerId: string) => window.ipcRenderer.invoke("auth:remove", providerId),
  list: () => window.ipcRenderer.invoke("auth:list") as Promise<string[]>,
}

export interface DetectResult {
  providerId: string
  name: string
  baseURL: string
  detected: boolean
  models: string[]
  error?: string
}

export const customProvidersApi = {
  list: () => window.ipcRenderer.invoke("custom-providers:list") as Promise<CatalogProvider[]>,
  add: (input: CustomProviderInput) =>
    window.ipcRenderer.invoke("custom-providers:add", input) as Promise<CatalogProvider>,
  remove: (id: string) => window.ipcRenderer.invoke("custom-providers:remove", id) as Promise<void>,
  update: (id: string, patch: CustomProviderPatch) =>
    window.ipcRenderer.invoke("custom-providers:update", id, patch) as Promise<CatalogProvider>,
  detect: () => window.ipcRenderer.invoke("custom-providers:detect") as Promise<DetectResult[]>,
  /** Queries the server's /models without saving anything (the dialog only saves at the end). */
  discover: (opts: {
    baseURL: string
    apiKey?: string
    protocol?: ProviderProtocol
    /** Editing: reuses the provider's already saved key. */
    providerId?: string
  }) => window.ipcRenderer.invoke("custom-providers:discover", opts) as Promise<DiscoveredModel[]>,
  /** Queries /models and saves it into the provider (card: "fetch models"). */
  refreshModels: (id: string) =>
    window.ipcRenderer.invoke("custom-providers:refresh", id) as Promise<CatalogProvider>,
}

export interface ProcessInfo {
  pid: number
  label: string
  command: string
  cwd: string
  startTime: number
  status: "running" | "exited" | "killed"
  exitCode?: number
  /** Chat session that started the process (footer filter and the bash_* tools). */
  sessionId?: string
  /** Local server URLs announced in the output (e.g.: http://localhost:5173). */
  urls?: string[]
}

export const processApi = {
  list: (sessionId?: string) => window.ipcRenderer.invoke("process:list", sessionId) as Promise<ProcessInfo[]>,
  kill: (pid: number, sessionId?: string) => window.ipcRenderer.invoke("process:kill", pid, sessionId) as Promise<boolean>,
  output: (pid: number, sessionId?: string) => window.ipcRenderer.invoke("process:output", pid, sessionId) as Promise<string>,
}

export const sessionApi = {
  revert: (sessionId: string, messageId: string) =>
    window.ipcRenderer.invoke("session:revert", sessionId, messageId) as Promise<SessionRevert | null>,
  unrevert: (sessionId: string) =>
    window.ipcRenderer.invoke("session:unrevert", sessionId) as Promise<UnrevertResult>,
  revertUncertain: (sessionId: string) =>
    window.ipcRenderer.invoke("session:revertUncertain", sessionId) as Promise<SessionRevert | null>,
}

export const chatApi = {
  send: (input: SendMessageInput) => window.ipcRenderer.invoke("chat:send", input),
  /** Emits a ChatEvent (session/folder created or changed in the UI) to main,
   *  which forwards it to the other windows and to the companions (mobile) in real time. */
  emit: (event: ChatEvent) => {
    window.ipcRenderer?.send("chat:event:emit", event)
  },
  abort: (sessionId: string) => window.ipcRenderer.invoke("chat:abort", sessionId),
  /** Sessions still running in main (after a renderer reload, to re-emit
   *  the streaming status without waiting for the next event). */
  running: () => window.ipcRenderer.invoke("chat:running") as Promise<string[]>,
  compact: (sessionId: string) => window.ipcRenderer.invoke("chat:compact", sessionId),
  /** Continuity brief for a new chat (compaction card): main reads
   *  the history and generates the text with the auxiliary model, already with the summary header. */
  continuationBrief: (sessionId: string) =>
    window.ipcRenderer.invoke("chat:continuationBrief", sessionId) as Promise<{
      title: string
      text: string
    } | null>,
  approvePlan: (sessionId: string, planId: string, taskIds?: string[]) =>
    window.ipcRenderer.invoke("chat:approvePlan", sessionId, planId, taskIds),
  /** "Continue" on an interrupted plan: runs again the tasks it did not accept. The
   *  input is the same one a send carries (provider, worker/conductor models, modes),
   *  minus the text — the plan already knows what has to be done. */
  resumePlan: (input: SendMessageInput) => window.ipcRenderer.invoke("chat:resumePlan", input) as Promise<void>,
  /** Tries again to join into the chat the accepted work of the workers (worktrees) */
  mergeOrchestration: (sessionId: string) => window.ipcRenderer.invoke("chat:mergeOrchestration", sessionId) as Promise<void>,
  rejectPlan: (sessionId: string) => window.ipcRenderer.invoke("chat:rejectPlan", sessionId),
  savePlanFile: (directory: string, content: string) =>
    window.ipcRenderer.invoke("plan:saveFile", directory, content),
  deletePlanFile: (directory: string) =>
    window.ipcRenderer.invoke("plan:deleteFile", directory),
  readPlanFile: (directory: string) =>
    window.ipcRenderer.invoke("plan:readFile", directory) as Promise<string | null>,
  closeBrowser: (sessionId: string) => window.ipcRenderer.invoke("chat:closeBrowser", sessionId),
  askReply: (requestId: string, value: unknown) =>
    window.ipcRenderer.invoke("chat:askReply", requestId, value) as Promise<boolean>,
  onEvent: (listener: (event: ChatEvent) => void) => {
    const wrapper = window.ipcRenderer.on("chat:event", (event) => listener(event as ChatEvent))
    return () => window.ipcRenderer.off("chat:event", wrapper)
  },
}

/** Model per session: the renderer pushes the overrides map to main
 *  (HTTP cache + forwarding to the companions) and listens for selections coming from the
 *  companions (WS 'models:select' / HTTP PUT selected) to apply them in the
 *  local store — it keeps the same model per chat between desktop and mobile. */
export const sessionModelsApi = {
  sync: (overrides: Record<string, { providerId: string; modelId: string }>) => {
    window.ipcRenderer?.send("companion:session-models", overrides)
  },
  onSelect: (
    listener: (data: { providerId: string; modelId: string; sessionId?: string | null }) => void,
  ) => {
    const wrapper = window.ipcRenderer.on("companion:model-select", (data) =>
      listener(data as { providerId: string; modelId: string; sessionId?: string | null }),
    )
    return () => window.ipcRenderer.off("companion:model-select", wrapper)
  },
}

/** Model rotation: the renderer pushes the whole state (list +
 *  per-chat choice) to main, which caches it, resolves the turn's
 *  sequence and forwards it to the companions. In the reverse direction, it listens to what was
 *  done on the phone (WS 'rotation:select' / 'rotation:set') — the renderer is the
 *  source of truth, so this is where the change is persisted. */
export const rotationApi = {
  sync: (config: RotationConfig) => {
    window.ipcRenderer?.send("rotation:sync", config)
  },
  onSelect: (listener: (data: { rotationId: string | null; sessionId?: string | null }) => void) => {
    const wrapper = window.ipcRenderer.on("companion:rotation-select", (data) =>
      listener(data as { rotationId: string | null; sessionId?: string | null }),
    )
    return () => window.ipcRenderer.off("companion:rotation-select", wrapper)
  },
  onSet: (listener: (data: { rotations: ModelRotation[] }) => void) => {
    const wrapper = window.ipcRenderer.on("companion:rotation-set", (data) =>
      listener(data as { rotations: ModelRotation[] }),
    )
    return () => window.ipcRenderer.off("companion:rotation-set", wrapper)
  },
}

/** Thinking per model: same path as sessionModelsApi. The renderer pushes the
 *  reasoning-prefs map and listens to the toggles made in the companions
 *  (WS 'reasoning:select'). */
export const reasoningApi = {
  sync: (prefs: ReasoningPrefsMap) => {
    window.ipcRenderer?.send("companion:reasoning-prefs", prefs)
  },
  onSelect: (
    listener: (data: { providerId: string; modelId: string; pref: ModelReasoningPref }) => void,
  ) => {
    const wrapper = window.ipcRenderer.on("companion:reasoning-select", (data) =>
      listener(data as { providerId: string; modelId: string; pref: ModelReasoningPref }),
    )
    return () => window.ipcRenderer.off("companion:reasoning-select", wrapper)
  },
}

/** Message queue shared with the companions: the renderer pushes the
 *  whole queue and applies the operations done on the phone (WS 'queue:op'). */
export const messageQueueApi = {
  sync: (queues: MessageQueueSnapshot) => {
    window.ipcRenderer?.send("companion:message-queue", queues)
  },
  onOp: (listener: (op: MessageQueueOp) => void) => {
    const wrapper = window.ipcRenderer.on("companion:queue-op", (data) => listener(data as MessageQueueOp))
    return () => window.ipcRenderer.off("companion:queue-op", wrapper)
  },
}

/** Modes per chat: same path as sessionModelsApi. The renderer pushes the whole
 *  map (mode-overrides + simple + brain) and listens to the toggles made in the
 *  companions (WS 'modes:select'). */
export const sessionModesApi = {
  sync: (overrides: SessionModeOverrides) => {
    window.ipcRenderer?.send("companion:session-modes", overrides)
  },
  onSelect: (
    listener: (data: { mode: ChatModeKey; value: boolean; sessionId?: string | null }) => void,
  ) => {
    const wrapper = window.ipcRenderer.on("companion:mode-select", (data) =>
      listener(data as { mode: ChatModeKey; value: boolean; sessionId?: string | null }),
    )
    return () => window.ipcRenderer.off("companion:mode-select", wrapper)
  },
}

/** Thinking and permission PER CHAT: same path as sessionModelsApi. The renderer
 *  pushes the snapshot (reasoning + permission per session) and listens to what was
 *  chosen in a companion (WS 'session:prefs-select'). */
export const sessionPrefsApi = {
  sync: (prefs: SessionPrefsSnapshot) => {
    window.ipcRenderer?.send("companion:session-prefs", prefs)
  },
  onSelect: (
    listener: (data: {
      sessionId?: string | null
      reasoning?: ModelReasoningPref
      permission?: "ask" | "approve" | "full"
    }) => void,
  ) => {
    const wrapper = window.ipcRenderer.on("companion:session-prefs-select", (data) =>
      listener(data as { sessionId?: string | null; reasoning?: ModelReasoningPref; permission?: "ask" | "approve" | "full" }),
    )
    return () => window.ipcRenderer.off("companion:session-prefs-select", wrapper)
  },
}

/** Config of the delegated modes (workers' model/thinking and vision model):
 *  global, pushed to main like the others and applied back when the
 *  phone changes. */
export const workerConfigApi = {
  sync: (config: WorkerConfigSnapshot) => {
    window.ipcRenderer?.send("companion:worker-config", config)
  },
  onSet: (listener: (config: WorkerConfigSnapshot) => void) => {
    const wrapper = window.ipcRenderer.on("companion:worker-config-set", (data) =>
      listener(data as WorkerConfigSnapshot),
    )
    return () => window.ipcRenderer.off("companion:worker-config-set", wrapper)
  },
}

/** App preferences (mode defaults per chat type, permission mode and
 *  automatic folders): same path as workerConfigApi. The renderer is the source of
 *  truth and the phone mirrors. */
export const appPreferencesApi = {
  sync: (prefs: AppPreferences) => {
    window.ipcRenderer?.send("companion:preferences", prefs)
  },
  onSet: (listener: (prefs: AppPreferences) => void) => {
    const wrapper = window.ipcRenderer.on("companion:preferences-set", (data) =>
      listener(data as AppPreferences),
    )
    return () => window.ipcRenderer.off("companion:preferences-set", wrapper)
  },
}

/**
 * Permission rules (Preferences → Rules). `trusted` is what the user allowed for
 * good ("Always"); `learned` is what only kept being approved and has not been
 * settled yet — the two sides of the same screen.
 */
export interface TrustedRule {
  ruleId: string
  createdAt: number
  /** Missing in rules trusted before the screen existed. */
  label?: string
}

export interface LearnedRule {
  ruleId: string
  label: string
  approvals: number
  firstAt: number
  lastAt: number
}

export const permissionsApi = {
  rules: () =>
    window.ipcRenderer.invoke("permissions:rules") as Promise<{
      trusted: TrustedRule[]
      learned: LearnedRule[]
    }>,
  allowAlways: (ruleId: string, label?: string) =>
    window.ipcRenderer.invoke("permissions:rules:add", ruleId, label) as Promise<void>,
  revoke: (ruleId: string) =>
    window.ipcRenderer.invoke("permissions:rules:remove", ruleId) as Promise<void>,
}

export const hooksApi = {
  list: () => window.ipcRenderer.invoke("hooks:list") as Promise<HookWithRun[]>,
  add: (input: HookInput) => window.ipcRenderer.invoke("hooks:add", input) as Promise<Hook>,
  update: (id: string, input: HookInput) => window.ipcRenderer.invoke("hooks:update", id, input) as Promise<Hook | null>,
  toggle: (id: string, enabled: boolean) => window.ipcRenderer.invoke("hooks:toggle", id, enabled) as Promise<void>,
  remove: (id: string) => window.ipcRenderer.invoke("hooks:remove", id) as Promise<void>,
  /** The model writes a hook from a description (nothing is saved until the user confirms the form). */
  generate: (description: string, model: { providerId: string; modelId: string }, folders: string[], language?: string) =>
    window.ipcRenderer.invoke("hooks:generate", description, model, folders, language) as Promise<HookGenerationResult>,
}

export const skillsApi = {
  list: (directory?: string) =>
    window.ipcRenderer.invoke("skills:list", directory) as Promise<Skill[]>,
  create: (data: { name: string; description?: string; content: string; slug?: string; oldSlug?: string }) =>
    window.ipcRenderer.invoke("skills:create", data) as Promise<{ filePath: string }>,
  remove: (slug: string) => window.ipcRenderer.invoke("skills:remove", slug) as Promise<void>,
  /** The model drafts a skill from a description; nothing is saved. */
  generate: (description: string, model: { providerId: string; modelId: string }, folders: string[], language?: string) =>
    window.ipcRenderer.invoke("skills:generate", description, model, folders, language) as Promise<SkillGenerationResult>,
  /** Card state, preferences and usage per skill */
  meta: (directory?: string) => window.ipcRenderer.invoke("skills:meta", directory) as Promise<SkillMetaView[]>,
  /** Writes the card with the auxiliary model, in the user's language */
  optimize: (slug: string, directory?: string, language?: string) =>
    window.ipcRenderer.invoke("skills:optimize", slug, directory, language) as Promise<
      { card: SkillCard } | { error: "not-found" | "no-aux-model" | "failed"; message?: string }
    >,
  setPref: (slug: string, patch: { pin?: boolean; never?: boolean }) =>
    window.ipcRenderer.invoke("skills:set-pref", slug, patch) as Promise<void>,
  import: () =>
    window.ipcRenderer.invoke("skills:import") as Promise<{
      imported: boolean
      slug?: string
      error?: string
    }>,
  pending: () => window.ipcRenderer.invoke("skills:pending") as Promise<SkillProposal[]>,
  approve: (slug: string) => window.ipcRenderer.invoke("skills:approve", slug) as Promise<boolean>,
  discard: (slug: string) => window.ipcRenderer.invoke("skills:discard", slug) as Promise<void>,
  onChanged: (listener: () => void) => {
    const wrapper = window.ipcRenderer.on("skills:changed", () => listener())
    return () => window.ipcRenderer.off("skills:changed", wrapper)
  },
}

export const nodaraApi = {
  discover: () => window.ipcRenderer.invoke("nodara:discover") as Promise<NodaraStatus>,
  /** Registers/repairs the Nodara MCP server and returns the post-connection state */
  connect: () => window.ipcRenderer.invoke("nodara:connect") as Promise<NodaraStatus>,
  disconnect: () => window.ipcRenderer.invoke("nodara:disconnect") as Promise<NodaraStatus>,
}

export const fractaApi = {
  discover: () => window.ipcRenderer.invoke("fracta:discover") as Promise<FractaStatus>,
  /** Registers/repairs the Fracta MCP server and returns the post-connection state */
  connect: () => window.ipcRenderer.invoke("fracta:connect") as Promise<FractaStatus>,
  disconnect: () => window.ipcRenderer.invoke("fracta:disconnect") as Promise<FractaStatus>,
}

export const mcpApi = {
  /** The model configures a server from a description; nothing is saved or started. */
  generate: (description: string, model: { providerId: string; modelId: string }, folders: string[], language?: string) =>
    window.ipcRenderer.invoke("mcp:generate", description, model, folders, language) as Promise<McpGenerationResult>,
  config: () => window.ipcRenderer.invoke("mcp:config") as Promise<McpConfig>,
  status: () => window.ipcRenderer.invoke("mcp:status") as Promise<McpServerStatus[]>,
  save: (config: McpConfig) =>
    window.ipcRenderer.invoke("mcp:save", config) as Promise<McpServerStatus[]>,
  reconnect: (name?: string) =>
    window.ipcRenderer.invoke("mcp:reconnect", name) as Promise<McpServerStatus[]>,
  /** Starts the server's OAuth flow (opens the browser and completes the authorization) */
  auth: (name: string) =>
    window.ipcRenderer.invoke("mcp:auth", name) as Promise<McpServerStatus[]>,
  /** redirect_uri of the OAuth loopback, to register in the provider's app */
  oauthRedirect: () => window.ipcRenderer.invoke("mcp:oauth-redirect") as Promise<string>,
  /** State of the server's rewritten descriptions ("Optimize" button) */
  descriptions: (name: string) =>
    window.ipcRenderer.invoke("mcp:descriptions", name) as Promise<{
      optimized: boolean
      count: number
      tools: number
    }>,
  /** Rewrites the server's tool descriptions with the auxiliary model */
  optimize: (name: string) =>
    window.ipcRenderer.invoke("mcp:optimize", name) as Promise<{
      updated: number
      modelId: string
      fallback: boolean
      tools: number
    }>,
}

export const analyticsApi = {
  summary: (range: AnalyticsRange, mode?: "chat" | "code") =>
    window.ipcRenderer.invoke("analytics:summary", range, mode) as Promise<AnalyticsSummary>,
  /** The auxiliary model summarizes what was done in a project (or all), on a day or in the period. */
  summarize: (input: UsageSummaryRequest) =>
    window.ipcRenderer.invoke("analytics:summarize", input) as Promise<UsageSummaryResponse>,
}

export const panelApi = {
  /** Registers (or clears, with null) the webContents of the panel <webview> — per chat session */
  register: (sessionId: string | null, webContentsId: number | null) =>
    window.ipcRenderer.send("panel:register", sessionId, webContentsId),
  /** Releases the registration ONLY if it is the given webContents (the <webview> that
   *  just died). It does not drop the registration of another live webview. */
  unregister: (sessionId: string | null, webContentsId: number | null) =>
    window.ipcRenderer.send("panel:unregister", sessionId, webContentsId),
  onEvent: (listener: (event: PanelEvent) => void) => {
    const wrapper = window.ipcRenderer.on("panel:event", (event) => listener(event as PanelEvent))
    return () => window.ipcRenderer.off("panel:event", wrapper)
  },
}

/** Worktrees in the chats: the header selector and the sidebar. */
export const worktreeApi = {
  /** null when the folder is not in a git repository */
  list: (folder: string) => window.ipcRenderer.invoke("worktree:list", folder) as Promise<WorktreeList | null>,
  create: (folder: string, name: string, base?: string) =>
    window.ipcRenderer.invoke("worktree:create", folder, name, base) as Promise<CreateWorktreeResult>,
  /** `folder`: the chat's (live) one — the worktree to remove may be one whose folder is gone */
  remove: (folder: string, path: string, deleteBranch?: boolean) =>
    window.ipcRenderer.invoke("worktree:remove", folder, path, deleteBranch) as Promise<void>,
  /** Equivalent folder in the main repository (the folder itself when outside a worktree) */
  main: (folder: string) => window.ipcRenderer.invoke("worktree:main", folder) as Promise<string>,
  /** Checks the folder chosen in the Preferences to store the worktrees */
  validateFolder: (folder: string) =>
    window.ipcRenderer.invoke("worktree:validateFolder", folder) as Promise<ValidateWorktreesFolder>,
}

/** Pipeline mode — project/pipeline/task board (orbit-data/pipeline). */
export const pipelineApi = {
  load: () =>
    window.ipcRenderer.invoke("pipeline:load") as Promise<{
      projects: Project[]
      pipelines: Pipeline[]
      tasksPerPipeline: Record<string, Task[]>
    }>,
  templates: () => window.ipcRenderer.invoke("pipeline:templates") as Promise<PhaseTemplate[]>,
  saveTemplate: (template: PhaseTemplate) =>
    window.ipcRenderer.invoke("pipeline:saveTemplate", template) as Promise<PhaseTemplate[]>,
  removeTemplate: (id: string) =>
    window.ipcRenderer.invoke("pipeline:removeTemplate", id) as Promise<PhaseTemplate[]>,
  createProject: (name: string, folders: string[]) =>
    window.ipcRenderer.invoke("pipeline:createProject", name, folders) as Promise<Project>,
  updateProject: (id: string, patch: Partial<Pick<Project, "name" | "folders">>) =>
    window.ipcRenderer.invoke("pipeline:updateProject", id, patch) as Promise<Project | null>,
  removeProject: (id: string) => window.ipcRenderer.invoke("pipeline:removeProject", id) as Promise<void>,
  create: (input: NewPipelineInput) => window.ipcRenderer.invoke("pipeline:create", input) as Promise<Pipeline>,
  update: (id: string, patch: Partial<Pipeline>) =>
    window.ipcRenderer.invoke("pipeline:update", id, patch) as Promise<Pipeline | null>,
  remove: (id: string) => window.ipcRenderer.invoke("pipeline:remove", id) as Promise<void>,
  createTask: (input: NewTaskInput) => window.ipcRenderer.invoke("pipeline:createTask", input) as Promise<Task>,
  updateTask: (pipelineId: string, taskId: string, patch: Partial<Task>) =>
    window.ipcRenderer.invoke("pipeline:updateTask", pipelineId, taskId, patch) as Promise<Task | null>,
  removeTask: (pipelineId: string, taskId: string) =>
    window.ipcRenderer.invoke("pipeline:removeTask", pipelineId, taskId) as Promise<void>,
  startTask: (pipelineId: string, taskId: string, phase?: number) =>
    window.ipcRenderer.invoke("pipeline:startTask", pipelineId, taskId, phase) as Promise<void>,
  pauseTask: (pipelineId: string, taskId: string) =>
    window.ipcRenderer.invoke("pipeline:pauseTask", pipelineId, taskId) as Promise<void>,
  /** `instruction`: what the phase should do differently on resume (paused task) */
  resumeTask: (pipelineId: string, taskId: string, instruction?: string) =>
    window.ipcRenderer.invoke("pipeline:resumeTask", pipelineId, taskId, instruction) as Promise<void>,
  /** Returns a completed task with the review comment (opens a new round) */
  returnTask: (pipelineId: string, taskId: string, text: string, phase?: number) =>
    window.ipcRenderer.invoke("pipeline:returnTask", pipelineId, taskId, text, phase) as Promise<void>,
  toggleQueue: (pipelineId: string, enabled: boolean) =>
    window.ipcRenderer.invoke("pipeline:toggleQueue", pipelineId, enabled) as Promise<boolean>,
  report: (pipelineId: string) =>
    window.ipcRenderer.invoke("pipeline:report", pipelineId) as Promise<PipelineReport>,
  /** Whether the folder is in a git repository (worktrees need one). */
  hasGit: (folder: string) => window.ipcRenderer.invoke("pipeline:hasGit", folder) as Promise<boolean>,
  planTasks: (pipelineId: string, request: string) =>
    window.ipcRenderer.invoke("pipeline:planTasks", pipelineId, request) as Promise<PlannedTask[]>,
  createPlanned: (pipelineId: string, tasks: PlannedTask[]) =>
    window.ipcRenderer.invoke("pipeline:createPlanned", pipelineId, tasks) as Promise<Task[]>,
  deliveries: (pipelineId: string) =>
    window.ipcRenderer.invoke("pipeline:deliveries", pipelineId) as Promise<Delivery[]>,
  integration: (pipelineId: string) =>
    window.ipcRenderer.invoke("pipeline:integration", pipelineId) as Promise<PipelineIntegrationStatus | null>,
  destinations: (pipelineId: string) =>
    window.ipcRenderer.invoke("pipeline:destinations", pipelineId) as Promise<{ branches: string[]; default?: string }>,
  merge: (pipelineId: string, destination?: string) =>
    window.ipcRenderer.invoke("pipeline:merge", pipelineId, destination) as Promise<MergeOutcome>,
  commitIntegration: (pipelineId: string) =>
    window.ipcRenderer.invoke("pipeline:commitIntegration", pipelineId) as Promise<{
      ok: boolean
      hash?: string
      error?: string
    }>,
  retryIntegration: (pipelineId: string, taskId: string) =>
    window.ipcRenderer.invoke("pipeline:retryIntegration", pipelineId, taskId) as Promise<void>,
  archiveCompleted: (pipelineId: string) =>
    window.ipcRenderer.invoke("pipeline:archiveCompleted", pipelineId) as Promise<Delivery | null>,
  deleteDelivery: (pipelineId: string, deliveryId: string) =>
    window.ipcRenderer.invoke("pipeline:deleteDelivery", pipelineId, deliveryId) as Promise<void>,
  reopenTask: (pipelineId: string, taskId: string) =>
    window.ipcRenderer.invoke("pipeline:reopenTask", pipelineId, taskId) as Promise<Task>,
  /** Diff of a delivered task, read from git. */
  taskDiff: (pipelineId: string, taskId: string) =>
    window.ipcRenderer.invoke("pipeline:taskDiff", pipelineId, taskId) as Promise<{ files: string[]; patch: string } | null>,
  removeTaskImage: (pipelineId: string, taskId: string, url: string) =>
    window.ipcRenderer.invoke("pipeline:removeTaskImage", pipelineId, taskId, url) as Promise<Task | null>,
  onEvent: (listener: (event: PipelineEvent) => void) => {
    const wrapper = window.ipcRenderer.on("pipeline:event", (event) => listener(event as PipelineEvent))
    return () => window.ipcRenderer.off("pipeline:event", wrapper)
  },
}

/** The integration branch at a glance (mirrors IntegrationStatus in the main process). */
export interface PipelineIntegrationStatus {
  branch: string
  base: string
  ahead: number
  dirty: string[]
  queued: number
}

/** Pipeline creation input (mirrors NewPipelineInput in the main process). */
export interface NewPipelineInput {
  projectId: string
  name: string
  /** Resolved phases (may have been edited just for this pipeline) */
  phases?: PhaseChoice[]
  /** Simpler alternative: template ids in the desired order */
  templateIds?: string[]
  providerId: string
  modelId: string
  thinkingLevel?: number
  /** Default reasoning of the phases (each phase may bring its own) */
  reasoning?: ReasoningConfig | null
  branch?: string
  worktree?: string
  /** Each task in its own git worktree (default true; needs git) */
  worktreePerTask?: boolean
  /** Automatic tasks running at once, 1–4 */
  parallelTasks?: number
  /** Engine's final commit when the last phase completes (default true) */
  commitAtEnd?: boolean
  /** Final commit message prompt (absent = PIPELINE_COMMIT_PROMPT_DEFAULT) */
  commitPrompt?: string
  operationMode?: "manual" | "automatic"
}

/** Routines — scheduled chats of the chat and code modes (orbit-data/routines). */
export const routinesApi = {
  load: () =>
    window.ipcRenderer.invoke("routines:load") as Promise<{ routines: Routine[]; runs: RoutineRun[]; activities: ScriptActivity[] }>,
  /** Runs a script once for the screen; nothing is kept or fired. */
  testScript: (routineId: string, scriptId: string) =>
    window.ipcRenderer.invoke("routines:testScript", routineId, scriptId) as Promise<ScriptTestResult>,
  removeScript: (routineId: string, scriptId: string) =>
    window.ipcRenderer.invoke("routines:removeScript", routineId, scriptId) as Promise<Routine | null>,
  /** The person approves the current version of a routine script. */
  approveScript: (routineId: string, scriptId: string) =>
    window.ipcRenderer.invoke("routines:approveScript", routineId, scriptId) as Promise<Routine | null>,
  create: (input: NewRoutineInput) => window.ipcRenderer.invoke("routines:create", input) as Promise<Routine>,
  update: (id: string, patch: Partial<Routine>) =>
    window.ipcRenderer.invoke("routines:update", id, patch) as Promise<Routine | null>,
  remove: (id: string) => window.ipcRenderer.invoke("routines:remove", id) as Promise<void>,
  runNow: (id: string) =>
    window.ipcRenderer.invoke("routines:runNow", id) as Promise<string | null>,
  /** Discards metrics of executions whose chat has already been deleted. */
  pruneRuns: (sessionIds: string[]) =>
    window.ipcRenderer.invoke("routines:pruneRuns", sessionIds) as Promise<number>,
  /** Agent proposals (tool routines_manage) waiting for the card. */
  pending: () => window.ipcRenderer.invoke("routines:pending") as Promise<PendingRoutine[]>,
  approvePending: (id: string) =>
    window.ipcRenderer.invoke("routines:approvePending", id) as Promise<Routine | null>,
  discardPending: (id: string) =>
    window.ipcRenderer.invoke("routines:discardPending", id) as Promise<void>,
  onEvent: (listener: (event: RoutineEvent) => void) => {
    const wrapper = window.ipcRenderer.on("routines:event", (event) => listener(event as RoutineEvent))
    return () => window.ipcRenderer.off("routines:event", wrapper)
  },
}

/**
 * HTML artifacts (orbit-data/artifacts). The content does NOT go through here to
 * render — the iframe loads straight from orbit-artifact://. These calls
 * exist only to get the artifact out of Orbit (export/copy).
 */
/** Mermaid diagrams of the chat: main draws them (SVG/PNG, as in documents) and saves them. */
export const diagramApi = {
  export: (source: string, format: "svg" | "png" | "mmd") =>
    window.ipcRenderer.invoke("diagram:export", source, format) as Promise<
      { ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }
    >,
}

export const artifactApi = {
  read: (id: string) => window.ipcRenderer.invoke("artifact:read", id) as Promise<string | null>,
  /** update_artifact rewrote the file: whoever is already rendering that
   *  id has to reload (the URL does not change, so nothing fires on its own). */
  onUpdated: (listener: (payload: { artifactId: string; revision: number }) => void) => {
    const wrapper = window.ipcRenderer.on("artifact:updated", (payload) =>
      listener(payload as { artifactId: string; revision: number }),
    )
    return () => window.ipcRenderer.off("artifact:updated", wrapper)
  },
  export: (id: string) =>
    window.ipcRenderer.invoke("artifact:export", id) as Promise<
      { ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }
    >,
}

/**
 * Fragments (orbit-fragment://). The iframe loads straight from the scheme; what goes
 * through here is the list, the user's decisions (allow AI, delete) and the courier
 * service for the page: `call` hands a `window.orbit` request to the main process, which
 * is the one that decides.
 */
export const fragmentApi = {
  list: () => window.ipcRenderer.invoke("fragment:list") as Promise<FragmentManifest[]>,
  get: (id: string) => window.ipcRenderer.invoke("fragment:get", id) as Promise<FragmentManifest | null>,
  provenance: (id: string) => window.ipcRenderer.invoke("fragment:provenance", id) as Promise<FragmentProvenance | null>,
  details: (id: string) => window.ipcRenderer.invoke("fragment:details", id) as Promise<FragmentDetails | null>,
  data: (id: string) => window.ipcRenderer.invoke("fragment:data", id) as Promise<FragmentDataEntry[] | null>,
  history: (id: string) => window.ipcRenderer.invoke("fragment:history", id) as Promise<FragmentRevisionInfo[]>,
  /** Puts the files back as they were before `revision`. Only the history dialog calls it. */
  revert: (id: string, revision: number) =>
    window.ipcRenderer.invoke("fragment:revert", id, revision) as Promise<FragmentManifest | null>,
  call: (input: FragmentCallInput) =>
    window.ipcRenderer.invoke("fragment:call", input) as Promise<FragmentCallResult>,
  /** Only the user, through the tab toolbar, allows a capability. */
  grant: (id: string, capability: FragmentCapability, on: boolean) =>
    window.ipcRenderer.invoke("fragment:grant", id, capability, on) as Promise<FragmentManifest | null>,
  /** Name, pins, model, editing chat — the person's choices (never the agent's). */
  update: (id: string, patch: FragmentMetaPatch) =>
    window.ipcRenderer.invoke("fragment:update", id, patch) as Promise<FragmentManifest | null>,
  remove: (id: string) => window.ipcRenderer.invoke("fragment:remove", id) as Promise<boolean>,
  log: (id: string, entry: FragmentLogEntry) => window.ipcRenderer.send("fragment:log", id, entry),
  /** The fragment was rewritten (or its grants changed): reload / re-read the manifest. */
  onUpdated: (listener: (payload: FragmentUpdatedEvent) => void) => {
    const wrapper = window.ipcRenderer.on("fragment:updated", (payload) => listener(payload as FragmentUpdatedEvent))
    return () => window.ipcRenderer.off("fragment:updated", wrapper)
  },
  onRemoved: (listener: (payload: { fragmentId: string }) => void) => {
    const wrapper = window.ipcRenderer.on("fragment:removed", (payload) => listener(payload as { fragmentId: string }))
    return () => window.ipcRenderer.off("fragment:removed", wrapper)
  },
}

export type AgentSaveResult = { ok: true; agent: AgentDefinition } | { ok: false; reason: "name" | "limit" | "missing" }

/** The Specialists page: the person's agents and what the built-in profiles inject. */
export const agentsApi = {
  snapshot: () => window.ipcRenderer.invoke(AGENT_CHANNELS.snapshot) as Promise<AgentsSnapshot>,
  /** Without `id` creates an agent; with it, replaces the editable part. */
  save: (input: AgentInput, id?: string) => window.ipcRenderer.invoke(AGENT_CHANNELS.save, input, id) as Promise<AgentSaveResult>,
  duplicate: (id: string, copyLabel: string) => window.ipcRenderer.invoke(AGENT_CHANNELS.duplicate, id, copyLabel) as Promise<AgentSaveResult>,
  generate: (description: string, model: { providerId: string; modelId: string }, folders: string[], language?: string) =>
    window.ipcRenderer.invoke(AGENT_CHANNELS.generate, description, model, folders, language) as Promise<AgentGenerationResult>,
  toolNames: () => window.ipcRenderer.invoke(AGENT_CHANNELS.toolNames) as Promise<string[]>,
  saveBuiltin: (id: string, override: BuiltinOverride) => window.ipcRenderer.invoke(AGENT_CHANNELS.saveBuiltin, id, override) as Promise<boolean>,
  resetBuiltin: (id: string) => window.ipcRenderer.invoke(AGENT_CHANNELS.resetBuiltin, id) as Promise<boolean>,
  remove: (id: string) => window.ipcRenderer.invoke(AGENT_CHANNELS.remove, id) as Promise<boolean>,
  onChanged: (listener: () => void) => {
    const wrapper = window.ipcRenderer.on(AGENT_CHANNELS.changed, () => listener())
    return () => window.ipcRenderer.off(AGENT_CHANNELS.changed, wrapper)
  },
}

/** Which chats worked on an artifact (fragment, motion, design) — one API for every kind. */
export const artifactChatsApi = {
  chats: (ref: ArtifactRef) => window.ipcRenderer.invoke(ARTIFACT_CHATS_CHANNELS.list, ref) as Promise<ArtifactChats>,
  associate: (ref: ArtifactRef, sessionId: string, makeCurrent?: boolean) =>
    window.ipcRenderer.invoke(ARTIFACT_CHATS_CHANNELS.associate, ref, sessionId, makeCurrent) as Promise<ArtifactChats>,
  setCurrent: (ref: ArtifactRef, sessionId: string) =>
    window.ipcRenderer.invoke(ARTIFACT_CHATS_CHANNELS.setCurrent, ref, sessionId) as Promise<ArtifactChats>,
  onChats: (listener: (event: ArtifactChatsEvent) => void) => {
    const wrapper = window.ipcRenderer.on(ARTIFACT_CHATS_CHANNELS.changed, (payload) => listener(payload as ArtifactChatsEvent))
    return () => window.ipcRenderer.off(ARTIFACT_CHATS_CHANNELS.changed, wrapper)
  },
}

/**
 * Motion composition of the preview (orbit-motion://). The agent's tool is
 * what registers the folder; here is only what the panel tab needs: ask for the render,
 * follow the progress and reload when the file changes on disk (main's fs.watch).
 * The render returns the path of the generated file.
 */
export const motionApi = {
  /** Render contract: `format` already says whether the file comes out with alpha (mov/webm),
   *  so the renderer never sends `transparent` — the user's choice in the modal
   *  is the format, and only it, for transparency. `quality`, `fps` and
   *  `separateAudio` are the other decisions of the same modal. */
  render: (id: string, options: MotionRenderOptions = {}) =>
    window.ipcRenderer.invoke("motion:render", { id, ...options }) as Promise<
      MotionRenderResult | MotionRenderCanceled
    >,
  /**
   * Reopens an already registered piece. The gallery card sends the `id` (its
   * link is the motionId); the chat card sends what the tool left in the `input` — the
   * `path` the agent used in the preview (code mode) or the composition `name`
   * with the `sessionId` (chat mode, where there is no path) —, and main translates it
   * through the registry. `false` when the piece left the registry: the project may have
   * been deleted, or the conversation's composition, removed.
   */
  open: (ref: { id?: string; path?: string; sessionId?: string; name?: string }) =>
    window.ipcRenderer.invoke("motion:open", ref) as Promise<boolean>,
  /** One event per rendered frame: the header's thin line. */
  onProgress: (listener: (payload: { id: string; frame: number; total: number }) => void) => {
    const wrapper = window.ipcRenderer.on("motion:render:progress", (payload) =>
      listener(payload as { id: string; frame: number; total: number }),
    )
    return () => window.ipcRenderer.off("motion:render:progress", wrapper)
  },
  /** The props the composition declares (props.json), to build the form; { exists: false } when it has none. */
  props: (id: string) => window.ipcRenderer.invoke("motion:props", id) as Promise<MotionPropsInfo>,
  /** Who enters and leaves the scene, and when (measured in main, offscreen). */
  layers: (id: string) => window.ipcRenderer.invoke("motion:layers", id) as Promise<MotionLayersResult>,
  /** The composition's folder changed on disk: remounts the iframe. */
  onChanged: (listener: (payload: { id: string }) => void) => {
    const wrapper = window.ipcRenderer.on("motion:changed", (payload) => listener(payload as { id: string }))
    return () => window.ipcRenderer.off("motion:changed", wrapper)
  },
  /** The FILES of the conversation's compositions — what the piece card in the chat
   *  lists. It comes from the piece's folder; `used` is derived from what the composition cites. */
  bundles: (sessionId: string) =>
    window.ipcRenderer.invoke("motion:bundles", sessionId) as Promise<MotionBundle[]>,
  /** "Save project": the piece's whole folder in a .zip with a manifest. */
  exportProject: (id: string) =>
    window.ipcRenderer.invoke("motion:export", id) as Promise<
      { ok: true; path: string; files: number } | { ok: false; canceled?: boolean; error?: string }
    >,
}

/**
 * Design canvas of the preview (orbit-design://). Mirrors motionApi, much
 * leaner: there is no render or layers — the artboard is static HTML, and the tab only
 * needs to reopen and reload live.
 */
/** A family installed in Orbit's library (see electron/lib/fonts/store). */
export interface OrbitFontInfo {
  id: string
  family: string
  category?: string
  variable: boolean
  weights: string[]
  license?: string
}

export interface FontChoices {
  /** Downloaded by the font_use tool — they count in design, motion and artifacts. */
  orbit: OrbitFontInfo[]
  /** Installed on the computer: Chromium already loads them, the name is enough. */
  system: string[]
  /** @font-face of Orbit's fonts — the app window needs it for the preview. */
  css: string
}

export const fontsApi = {
  list: () => window.ipcRenderer.invoke("fonts:list") as Promise<FontChoices>,
}

export const designApi = {
  /** Reopens an already registered canvas. The gallery card sends the `id`; the chat
   *  card sends what the tool left in the `input` — the folder `path` (code
   *  mode, design_preview) or the canvas `name` with the `sessionId` (chat
   *  mode, design_write/design_edit) — and main resolves it through the registry. `false`
   *  when the canvas has left the registry. */
  open: (ref: { id?: string; path?: string; sessionId?: string; name?: string }) =>
    window.ipcRenderer.invoke("design:open", ref) as Promise<boolean>,
  /** The canvas folder changed on disk: reloads only the artboards that changed.
   *  `files` are the names relative to the folder (as in canvas.json); empty or
   *  absent = could not tell, reload everything. */
  onChanged: (listener: (payload: { id: string; files?: string[] }) => void) => {
    const wrapper = window.ipcRenderer.on("design:changed", (payload) => listener(payload as { id: string; files?: string[] }))
    return () => window.ipcRenderer.off("design:changed", wrapper)
  },
  /** The source of an artboard, as it is on disk (without the editor's bridge). */
  readBoard: (id: string, file: string) => window.ipcRenderer.invoke("design:readBoard", { id, file }) as Promise<string>,
  /** Rewrites the source of an artboard — an edit made by the person in the canvas. */
  writeBoard: (id: string, file: string, html: string) =>
    window.ipcRenderer.invoke("design:writeBoard", { id, file, html }) as Promise<void>,
  /** Moves, resizes or renames an artboard in canvas.json. */
  updateBoard: (id: string, file: string, patch: { title?: string; x?: number; y?: number; w?: number; h?: number }) =>
    window.ipcRenderer.invoke("design:updateBoard", { id, file, patch }) as Promise<void>,
  /** Exports the canvas (or only the artboard `files`): PDF (one page per artboard) or PNG (one image per artboard).
   *  `canceled` is the user giving up in the dialog, not a failure. */
  export: (id: string, format: "pdf" | "png", suggestedName?: string, files?: string[]) =>
    window.ipcRenderer.invoke("design:export", id, format, suggestedName, files) as Promise<
      { ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }
    >,
}

/**
 * Slide decks of the stage (`orbit-slides://`). Mirrors designApi, even leaner:
 * the deck is ONE file and there is no editing through the tab — whoever writes is the
 * agent, and the tab presents.
 */
export const slidesApi = {
  /** Reopens an already registered deck. The card sends the `id`, or the file `path`
   *  (code mode) / the deck `name` with the `sessionId` (chat mode) — main
   *  resolves it through the registry. `false` when the deck has left the registry. */
  open: (ref: { id?: string; path?: string; sessionId?: string; name?: string }) =>
    window.ipcRenderer.invoke("slides:open", ref) as Promise<boolean>,
  /** The deck's id and entry WITHOUT opening a tab — it is with this that the chat card
   *  mounts the stage inline (`orbit-slides://<id>/<entry>`). `null` when the
   *  deck left the registry. */
  resolve: (ref: { id?: string; path?: string; sessionId?: string; name?: string }) =>
    window.ipcRenderer.invoke("slides:resolve", ref) as Promise<{ id: string; entry: string } | null>,
  /** The deck's file changed on disk: remounts the stage. */
  onChanged: (listener: (payload: { id: string }) => void) => {
    const wrapper = window.ipcRenderer.on("slides:changed", (payload) => listener(payload as { id: string }))
    return () => window.ipcRenderer.off("slides:changed", wrapper)
  },
  /** Downloads the deck as PDF. The printing is main's, over the index.html itself;
   *  `canceled` is the user giving up in the dialog, not a failure. */
  exportPdf: (id: string, suggestedName?: string) =>
    window.ipcRenderer.invoke("slides:export", id, suggestedName) as Promise<
      { ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }
    >,
}

/**
 * Output formats of the motion render. `-alpha` is the file with transparency:
 * mov (ProRes 4444) for editing, webm (VP9) for web/overlay. Same union as
 * main's `MotionRenderRequest.format` — changing it here without changing it there breaks the IPC.
 */
export type MotionRenderFormat = "mp4" | "mov-alpha" | "webm-alpha"

/** Mirror of main's MotionLayers (electron/lib/video/motion-layers.ts). */
export interface MotionLayersResult {
  width: number
  height: number
  fps: number
  durationInFrames: number
  /**
   * Document order (back to front). Ranges in frames, inclusive.
   * `index` is the element's position in the page walk: the label does NOT
   * identify an element (two may be called ".caption"), so it is through it that
   * the preview finds the element again to outline it when the layer is
   * selected in the tab. `kind` is what it is, measured in the DOM.
   */
  layers: {
    name: string
    named: boolean
    spans: [number, number][]
    index: number
    kind: "text" | "image" | "video" | "audio" | "other"
  }[]
  failedFonts: string[]
  /**
   * The piece's tracks, when it has any (the folder's `audio.json` manifest, the
   * conventional file, or the path the tool passed). `url` is the file
   * served by the scheme — the tab plays it along with the preview — and comes null when the
   * audio is OUTSIDE the composition's folder: the render muxes it, the preview does not
   * reach it. `start`/`end` are the piece's seconds at which the track enters and leaves
   * (`end` null = until the end of the file); `error` is the manifest that could not be
   * read, and in that case the piece plays muted and the tab says why. `offset` is the
   * second OF THE FILE at which the sound starts (the initial cut of a page video).
   */
  audio: {
    tracks: {
      name: string
      url: string | null
      start: number
      end: number | null
      offset?: number
      gainDb?: number
      fadeIn?: number
      fadeOut?: number
      automation?: { at: number; db: number }[]
    }[]
    error: string | null
  } | null
}

/**
 * The tab's render starts with a SYSTEM save dialog, so the file is
 * born wherever the person wants. Cancelling is not an error: it is them giving up, and the tab
 * goes back to rest instead of showing a failure that did not happen.
 */
export interface MotionRenderCanceled {
  canceled: true
}

/** Mirror of main's MotionRenderResult (electron/lib/video/motion-store.ts). */
export interface MotionRenderResult {
  id: string
  /** Absolute path of the rendered file. */
  path: string
  width: number
  height: number
  fps: number
  duration: number
  frames: number
  /** WAV of the track, when the render asked for separate audio and the piece has sound. */
  audioPath?: string
}

/** The file's weight (encoder CRF/preset) — mirror of main. */
export type MotionRenderQuality = "high" | "balanced" | "small"

/**
 * What the render modal chooses. The path and the file name remain
 * main's (system dialog); only what is the decision of whoever renders goes here:
 * format, weight, fps and whether the audio also comes out on its own.
 */
export interface MotionRenderOptions {
  format?: MotionRenderFormat
  quality?: MotionRenderQuality
  /** fps of the file; absent = the composition's. */
  fps?: number
  /** Also write the track on its own, in WAV, next to the video. */
  separateAudio?: boolean
  /** The values of the props form that differ from the defaults (main checks them again). */
  props?: Record<string, string | number | boolean>
}

/** Agent documents (orbit-data/documents). The source is Markdown: the panel's
 *  canvas reads and writes through here, and the export renders the file on the spot. */
export const documentApi = {
  /** Downloads the document. "md" copies the source; "pdf"/"docx" render on the spot
   *  when they do not exist on disk yet. */
  export: (id: string, format: DocumentDownload) =>
    window.ipcRenderer.invoke("document:export", id, format) as Promise<
      { ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }
    >,
  /** The Markdown and the revision it is based on — the revision comes back on save. */
  source: (id: string) =>
    window.ipcRenderer.invoke("document:source", id) as Promise<{
      markdown: string
      revision: number
    } | null>,
  /** Saves the user's edit over the revision it was based on. It refuses
   *  when the agent wrote in the meantime, instead of erasing what it
   *  produced; the returned revision tells the notice apart from the echo of our save. */
  saveSource: (id: string, markdown: string, baseRevision?: number) =>
    window.ipcRenderer.invoke("document:saveSource", id, markdown, baseRevision) as Promise<
      | { ok: true; revision: number }
      | { ok: false; reason: "notFound" }
      | { ok: false; reason: "stale"; revision: number }
    >,
  info: (id: string) =>
    window.ipcRenderer.invoke("document:info", id) as Promise<DocumentInfo | null>,
  /** The document this source came from, when it came from a promotion. */
  forSource: (sourceId: string) =>
    window.ipcRenderer.invoke("document:forSource", sourceId) as Promise<
      { documentId: string; title: string } | null
    >,
  /** Promotes the document to a conversation source. Idempotent: if it has already become
   *  a source and it is still there, it returns the same one with `already`. */
  useAsSource: (sessionId: string, id: string) =>
    window.ipcRenderer.invoke("document:useAsSource", sessionId, id) as Promise<
      { ok: true; sourceId: string; already: boolean } | { ok: false; error: string }
    >,
  /** Is it a source of this conversation NOW — the user may have removed it afterwards. */
  isSource: (sessionId: string, id: string) =>
    window.ipcRenderer.invoke("document:isSource", sessionId, id) as Promise<boolean>,
}

/** Enough to decide which tab the document opens in and how to title it. */
export type DocumentInfo = Pick<
  MediaEntry,
  "id" | "name" | "delivery" | "derived" | "formats" | "revision"
>

/** Media gallery — assets produced by the agent (images, artifacts and documents). */
export const mediaApi = {
  list: (filter?: MediaFilter) => window.ipcRenderer.invoke("media:list", filter) as Promise<MediaEntry[]>,
  usage: () => window.ipcRenderer.invoke("media:usage") as Promise<MediaUsage>,
  remove: (ids: string[]) => window.ipcRenderer.invoke("media:delete", ids) as Promise<number>,
  cleanupScripts: () => window.ipcRenderer.invoke("media:cleanupScripts") as Promise<number>,
  /** Links assets (image/artifact/document) to an additional session — used
   *  by the fork, so that "In this chat" in the gallery sees what was inherited. */
  linkSessions: (ids: string[], sessionId: string) =>
    window.ipcRenderer.invoke("media:linkSessions", ids, sessionId) as Promise<void>,
  /** Indexes images from before the registry — idempotent, runs on the 1st open. */
  backfill: () => window.ipcRenderer.invoke("media:backfill") as Promise<number>,
  /** The collection changed (image saved or deleted by any path). The open
   *  gallery does not find out on its own: it reads the index once. */
  onChanged: (listener: () => void) => {
    const wrapper = window.ipcRenderer.on("media:changed", () => listener())
    return () => window.ipcRenderer.off("media:changed", wrapper)
  },
  /** Saves an audio from the chat (orbit-audio:// or the id) through the system dialog. */
  exportAudio: (ref: string, suggestedName?: string) =>
    window.ipcRenderer.invoke("audio:export", ref, suggestedName) as Promise<
      { ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }
    >,
  /** Saves the image to disk through the system dialog. Accepts orbit-media://,
   *  the raw id or a data URL (an attachment that has not gone to the gallery yet). */
  exportImage: (ref: string, suggestedName?: string) =>
    window.ipcRenderer.invoke("media:export", ref, suggestedName) as Promise<
      { ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }
    >,
  /** Copies the image to the clipboard as a native bitmap — it is what
   *  makes Ctrl+V paste the IMAGE into another app, and not a file path. */
  copyImage: (ref: string) =>
    window.ipcRenderer.invoke("media:copy", ref) as Promise<
      { ok: true } | { ok: false; error?: string }
    >,
}

/** A document the conversation reads: its attachment (`docN`) or a folder source (`srcN`). */
export interface SourceDocument {
  id: string
  sessionId: string
  filename: string
  kind: "pdf" | "docx" | "spreadsheet" | "text" | "web"
  totalPages: number
  totalChars: number
  truncated: boolean
  sizeBytes?: number
  createdAt: number
  shared?: boolean
  sourceUrl?: string
}

import type { PdfTextItem } from "@/src/lib/pdf-text"

/** Table of contents entry of the PDF, already flattened with the indentation level. */
export interface OutlineItem {
  title: string
  page: number | null
  level: number
}

/** A PDF page drawn by us, with where to mark the cited stretch. */
export interface RenderedPage {
  page: number
  dataUrl: string
  width: number
  height: number
  /** Text positioned as a FRACTION of the page (0 to 1): it works at any zoom, and
   *  the highlight and the selection layer come out of it, with no new rendering. */
  items: PdfTextItem[]
}

/** The whole document as text, for the panel to scroll and highlight the stretch. */
export interface SourceText {
  /** Where the request ended up. It may differ from the requested id when the file
   *  moved to another area after the citation. */
  id: string
  /** The old id, when there was a redirect — the panel shows both. */
  movedFrom?: string
  filename: string
  kind: SourceDocument["kind"]
  totalPages: number
  pages: { num: number; label?: string; lines: string[] }[]
  sourceUrl?: string
  /** true when a serviceable original file exists (PDF/DOCX) — the panel's
   *  "original" mode only shows up in that case. */
  hasOriginal: boolean
  /** How the original is drawn: pages (PDF) or the document in HTML (.docx). */
  originalKind?: "pdf" | "docx"
}

/**
 * Conversation sources — the documents you converse with, not what the agent
 * produced (that is the media gallery).
 *
 * Two scopes: `own` are this conversation's attachments and `shared` are the
 * folder's sources, declared on purpose and valid for all its conversations. Nothing
 * goes from one to the other on its own — the user is the one who moves it, in the tab.
 */
/** Photo, GIF, audio and video of the Sources tab (the file is a gallery item). */
export const materialsApi = {
  list: (scope: string) =>
    window.ipcRenderer.invoke("materials:list", scope) as Promise<{
      shared: MaterialView[]
      own: MaterialView[]
      bytes: number
    }>,
  /** A file video goes by `path` (main copies it); the rest, in base64 `data`. */
  add: (
    scope: string,
    files: { filename: string; mime: string; data?: string; path?: string }[],
    shared: boolean,
  ) =>
    window.ipcRenderer.invoke("materials:add", scope, files, shared) as Promise<{
      added: number
      errors: string[]
    }>,
  /** Moves between the conversation and the folder. The reference does not change. */
  setShared: (scope: string, id: string, shared: boolean) =>
    window.ipcRenderer.invoke("materials:setShared", scope, id, shared) as Promise<
      { ok: true } | { ok: false; error: string }
    >,
}

export const docsApi = {
  list: (sessionId: string) =>
    window.ipcRenderer.invoke("docs:list", sessionId) as Promise<{
      shared: SourceDocument[]
      own: SourceDocument[]
      folderId: string | null
      usage: number
    }>,
  add: (sessionId: string, files: { filename: string; data: string }[], shared: boolean) =>
    window.ipcRenderer.invoke("docs:add", sessionId, files, shared) as Promise<{
      added: number
      errors: string[]
    }>,
  /** Stretch pasted as a source — not every source is a file. */
  addText: (sessionId: string, title: string, text: string, shared: boolean) =>
    window.ipcRenderer.invoke("docs:addText", sessionId, title, text, shared) as Promise<
      { ok: true } | { ok: false; error: string }
    >,
  /** Web page as a source: it downloads and stores the text (a snapshot of
   *  the moment, not a live link — the citation has to keep being valid). */
  addUrl: (sessionId: string, url: string, shared: boolean) =>
    window.ipcRenderer.invoke("docs:addUrl", sessionId, url, shared) as Promise<
      { ok: true } | { ok: false; error: string }
    >,
  /** The folder the new chat will inherit. The draft has no session to
   *  read it from, and without it the tab's shared area comes out empty in a chat
   *  opened from a folder's "+". */
  setDraftFolder: (folderId: string | null) =>
    window.ipcRenderer.invoke("docs:setDraftFolder", folderId) as Promise<void>,
  /** Thumbnail of the first page (webp data URL), or null when it cannot be
   *  generated — the row falls back to the type icon. Requested per row, on demand. */
  thumb: (sessionId: string, docId: string) =>
    window.ipcRenderer.invoke("docs:thumb", sessionId, docId) as Promise<string | null>,
  /** The whole document as text, for the panel to scroll. */
  text: (sessionId: string, docId: string) =>
    window.ipcRenderer.invoke("docs:text", sessionId, docId) as Promise<SourceText | null>,
  /** Rendered PDF pages, with the rectangles of the stretch to highlight. */
  /** The attached .docx converted into HTML, for the Original mode. */
  html: (sessionId: string, docId: string) =>
    window.ipcRenderer.invoke("docs:html", sessionId, docId) as Promise<{ html: string } | null>,
  render: (
    sessionId: string,
    docId: string,
    from: number,
    count: number,
    options?: { scale?: number; includeText?: boolean; includeOutline?: boolean },
  ) =>
    window.ipcRenderer.invoke("docs:render", sessionId, docId, from, count, options) as Promise<{
      total: number
      outline: OutlineItem[]
      pages: RenderedPage[]
    } | null>,
  /** Sends it to the printer, through the system dialog. */
  print: (sessionId: string, docId: string) =>
    window.ipcRenderer.invoke("docs:print", sessionId, docId) as Promise<{
      ok: boolean
      error?: string
    }>,
  /** Saves the source to disk (a copy of the original, when there is one). */
  export: (sessionId: string, docId: string) =>
    window.ipcRenderer.invoke("docs:export", sessionId, docId) as Promise<
      { ok: true; path: string } | { ok: false; canceled?: true; error?: string }
    >,
  /** Moves between the scopes (the id changes along: docN ↔ srcN). */
  setShared: (sessionId: string, docId: string, shared: boolean) =>
    window.ipcRenderer.invoke("docs:setShared", sessionId, docId, shared) as Promise<
      { ok: true; id: string } | { ok: false; error: string }
    >,
  remove: (sessionId: string, docId: string) =>
    window.ipcRenderer.invoke("docs:remove", sessionId, docId) as Promise<boolean>,
  /** New chat became a session: the draft's sources become its own. */
  adoptDraft: (sessionId: string) =>
    window.ipcRenderer.invoke("docs:adoptDraft", sessionId) as Promise<number>,
  /** Deleted chat: deletes only its own scope (never the folder's). */
  clearSession: (sessionId: string) =>
    window.ipcRenderer.invoke("docs:clearSession", sessionId) as Promise<void>,
  clearFolder: (folderId: string) =>
    window.ipcRenderer.invoke("docs:clearFolder", folderId) as Promise<void>,
  /** The attachment may arrive through the conversation while the tab is open next to it. */
  onChanged: (listener: () => void) => {
    const wrapper = window.ipcRenderer.on("documents:changed", () => listener())
    return () => window.ipcRenderer.off("documents:changed", wrapper)
  },
}

/** Publishes the effective language to the main process — whoever fires without
 *  the renderer in the loop (routine scheduler) needs to read it somewhere. */
export const appApi = {
  setLanguage: (language: string) => window.ipcRenderer.invoke("app:setLanguage", language),
}

export const initApi = {
  run: (input: {
    directory: string
    providerId: string
    modelId: string
    workerProviderId?: string
    workerModelId?: string
    force?: boolean
    language?: string
  }) => window.ipcRenderer.invoke("init:run", input),
  status: (directory: string) =>
    window.ipcRenderer.invoke("init:status", directory) as Promise<InitStatus>,
  /** Cancels the analysis in progress. Returns false if there was none. */
  stop: (directory: string) =>
    window.ipcRenderer.invoke("init:stop", directory) as Promise<boolean>,
  onEvent: (listener: (event: InitEvent) => void) => {
    const wrapper = window.ipcRenderer.on("init:event", (event) => listener(event as InitEvent))
    return () => window.ipcRenderer.off("init:event", wrapper)
  },
}

/** Refusal from `fs:writeFile`, with what the UI needs to offer the way out. */
export type WriteFileResult =
  | { ok: true; mtimeMs: number }
  | { ok: false; reason: "stale"; content?: string; mtimeMs?: number }
  | {
      ok: false
      reason: "outside-workspace" | "git-internal" | "not-a-file" | "binary" | "too-large" | "failed"
      error?: string
    }

/** A message from the project's eslint, as main delivers it. */
export interface LintMessage {
  line: number
  column: number
  endLine?: number
  endColumn?: number
  message: string
  ruleId: string | null
  /** 1 = warning, 2 = error (the same as eslint). */
  severity: number
}

export const lintApi = {
  /**
   * Runs the BUFFER through the project's eslint — not the file on disk, because the
   * value is in pointing out the error before saving. `unavailable` means
   * a project without a usable eslint: the caller stops asking.
   */
  file: (input: { root: string; filePath: string; content: string }) =>
    window.ipcRenderer.invoke("lint:file", input) as Promise<
      { ok: true; messages: LintMessage[] } | { ok: false; unavailable: true }
    >,
}

export const fsApi = {
  /**
   * Saves the file open in the panel. `roots` are the workspace folders and
   * `expectedMtimeMs` is the mtime from when the file was opened — without it the
   * save overwrites whatever the agent (or another editor) wrote in the meantime.
   */
  writeFile: (input: {
    filePath: string
    content: string
    roots: string[]
    expectedMtimeMs?: number
  }) => window.ipcRenderer.invoke("fs:writeFile", input) as Promise<WriteFileResult>,
  listFilesRecursive: (dirPath: string) =>
    window.ipcRenderer.invoke("fs:listFilesRecursive", dirPath) as Promise<{ ok: true; files: string[] } | { ok: false; error: string }>,
  readFileAsDataUrl: (filePath: string) =>
    window.ipcRenderer.invoke("fs:readFileAsDataUrl", filePath) as Promise<{ dataUrl: string } | { error: string }>,
  stat: (filePath: string) =>
    window.ipcRenderer.invoke("fs:stat", filePath) as Promise<
      { ok: true; isDirectory: boolean; isFile: boolean; size: number } | { ok: false; error: string }
    >,
  /** Which of these paths are still existing folders. It all goes in a single round trip:
   *  it is what the revalidation of folders that vanished from disk asks. */
  existingDirs: (dirs: string[]) =>
    window.ipcRenderer.invoke("fs:existDirs", dirs) as Promise<Record<string, boolean>>,
}

/** A file whose NAME matches the query. */
export interface WsNameHit {
  /** Path relative to the workspace root. */
  path: string
  name: string
  dir: string
}

/** A line where the query shows up. */
export interface WsLineHit {
  line: number
  column: number
  text: string
  length: number
}

/** Occurrences in a file — `count` is the total, `lines` only the first ones. */
export interface WsFileHits {
  path: string
  count: number
  lines: WsLineHit[]
}

export interface WsTextResult {
  occurrences: WsFileHits[]
  scanned: number
  matches: number
  truncated: boolean
  invalidPattern?: boolean
}

export interface WsMatchOptions {
  caseSensitive?: boolean
  regex?: boolean
  /** Only matches the whole word: `file` does not get into `walkFiles`. */
  wholeWord?: boolean
  /** In the replacement, it inherits the format of the text found (File → Document). */
  preserveCase?: boolean
}

export interface WsReplaceResult {
  files: number
  replacements: number
  written: string[]
  errors: { path: string; error: string }[]
}

/**
 * The workspace search — one for the panel, the modal and the `@` palette.
 *
 * `names` answers from memory (main's index); `text` reads the disk and therefore
 * has an id and cancellation: every new keystroke aborts the previous scan.
 */
export const workspaceApi = {
  names: (input: { root: string; query: string; refresh?: boolean }) =>
    window.ipcRenderer.invoke("ws:names", input) as Promise<
      | { ok: true; hits: WsNameHit[]; total: number; truncated: boolean }
      | { ok: false; error: string }
    >,
  text: (input: { id: string; root: string; query: string } & WsMatchOptions) =>
    window.ipcRenderer.invoke("ws:text", input) as Promise<
      ({ ok: true } & WsTextResult) | { ok: false; error: string }
    >,
  cancel: (id: string) =>
    window.ipcRenderer.invoke("ws:cancel", id) as Promise<boolean>,
  replace: (
    input: {
      root: string
      targets: string[]
      query: string
      replacement: string
    } & WsMatchOptions,
  ) =>
    window.ipcRenderer.invoke("ws:replace", input) as Promise<
      ({ ok: true } & WsReplaceResult) | { ok: false; error: string }
    >,
}

export const searchApi = {
  sessions: (query: string) =>
    window.ipcRenderer.invoke("search:sessions", query) as Promise<SearchHit[]>,
}

export const dataApi = {
  export: (includeAuth: boolean, localStorage: Record<string, string>) =>
    window.ipcRenderer.invoke("export:data", includeAuth, localStorage) as Promise<
      { cancelled: boolean; filePath?: string }
    >,
  import: () =>
    window.ipcRenderer.invoke("import:data") as Promise<
      { cancelled: boolean; error?: string; localStorage?: Record<string, string> }
    >,
}

export interface CompanionStatus {
  running: boolean
  port: number
  httpPort: number
  httpRunning: boolean
  ip: string
  pin: string | null
  /** Bind error of the WS server (e.g.: port taken by another instance). */
  bindError: string | null
  connectedClients: { deviceName: string; connectedAt: number }[]
}

export const companionApi = {
  status: () => window.ipcRenderer.invoke("companion:status") as Promise<CompanionStatus>,
  setPairingMode: (active: boolean) =>
    window.ipcRenderer.invoke("companion:setPairingMode", active) as Promise<void>,
  /** "Organize" fired by the mobile: the reorganization lives here (the automatic
   *  folder map is in localStorage), so the companion only notifies. */
  onOrganizeSidebar: (listener: () => void) => {
    const wrapper = window.ipcRenderer.on("companion:organize-sidebar", () => listener())
    return () => window.ipcRenderer.off("companion:organize-sidebar", wrapper)
  },
}

export const memoryApi = {
  list: () => window.ipcRenderer.invoke("memory:list") as Promise<Memory[]>,
  create: (input: {
    text: string
    kind: Memory["kind"]
    tags?: string[]
    document?: string
    directory?: string
    relatedId?: string
  }) =>
    window.ipcRenderer.invoke("memory:create", input) as Promise<{ id: string; merged: boolean; text: string }>,
  get: (id: string) =>
    window.ipcRenderer.invoke("memory:get", id) as Promise<{ memory: Memory; document: string | null } | null>,
  update: (id: string, patch: Partial<Pick<Memory, "text" | "tags" | "weight">>) =>
    window.ipcRenderer.invoke("memory:update", id, patch) as Promise<Memory | null>,
  delete: (id: string) => window.ipcRenderer.invoke("memory:delete", id) as Promise<void>,
  promote: (id: string) => window.ipcRenderer.invoke("memory:promote", id) as Promise<Memory | null>,
  link: (sourceId: string, targetId: string) =>
    window.ipcRenderer.invoke("memory:link", sourceId, targetId) as Promise<boolean>,
  onEvent: (listener: (event: MemoryEvent) => void) => {
    const wrapper = window.ipcRenderer.on("memory:event", (event) => listener(event as MemoryEvent))
    return () => window.ipcRenderer.off("memory:event", wrapper)
  },
}

/**
 * Other Orbit desktops on the network (electron/lib/peers). Session ids of a
 * peer are namespaced (`peer:<peerId>:<id>`); everything goes through the main
 * process, which holds the pinned connection — the renderer never sees a token.
 */
export const peersApi = {
  snapshot: () => window.ipcRenderer.invoke("peers:snapshot") as Promise<PeersSnapshot>,
  setDiscoverable: (value: boolean) => window.ipcRenderer.invoke("peers:setDiscoverable", value) as Promise<void>,
  /** Listen for beacons while the "Another computer" tab is open. Balanced on/off. */
  browse: (on: boolean) => window.ipcRenderer.invoke("peers:browse", on) as Promise<void>,
  pair: (host: string, port?: number) => window.ipcRenderer.invoke("peers:pair", host, port) as Promise<void>,
  cancelPair: () => window.ipcRenderer.invoke("peers:cancelPair") as Promise<void>,
  accept: (requestId: string, grants: PeerGrants) => window.ipcRenderer.invoke("peers:accept", requestId, grants) as Promise<boolean>,
  decline: (requestId: string) => window.ipcRenderer.invoke("peers:decline", requestId) as Promise<boolean>,
  forget: (peerId: string) => window.ipcRenderer.invoke("peers:forget", peerId) as Promise<void>,
  revokeDevice: (id: string) => window.ipcRenderer.invoke("peers:revokeDevice", id) as Promise<boolean>,
  reconnect: () => window.ipcRenderer.invoke("peers:reconnect") as Promise<void>,
  /** Re-sends the sessions and statuses of the connected peers (after a reload). */
  resend: (peerId?: string) => window.ipcRenderer.invoke("peers:resend", peerId) as Promise<void>,
  messages: (sessionId: string, opts?: { limit?: number; offset?: number }) =>
    window.ipcRenderer.invoke("peers:messages", sessionId, opts) as Promise<ChatMessage[]>,
  sessionState: (sessionId: string) =>
    window.ipcRenderer.invoke("peers:sessionState", sessionId) as Promise<{ pendingAsks?: unknown[] } | null>,
  send: (sessionId: string, text: string) => window.ipcRenderer.invoke("peers:send", sessionId, text) as Promise<void>,
  abort: (sessionId: string) => window.ipcRenderer.invoke("peers:abort", sessionId) as Promise<void>,
  fsTree: (sessionId: string, root?: number, path?: string) =>
    window.ipcRenderer.invoke("peers:fsTree", sessionId, root, path) as Promise<RemoteFileTree>,
  fsRead: (sessionId: string, root: number, path: string) =>
    window.ipcRenderer.invoke("peers:fsRead", sessionId, root, path) as Promise<RemoteFileContent>,
  onEvent: (listener: (event: PeersEvent) => void) => {
    if (!window.ipcRenderer) return () => {}
    const wrapper = window.ipcRenderer.on("peers:event", (event) => listener(event as PeersEvent))
    return () => window.ipcRenderer.off("peers:event", wrapper)
  },
}
