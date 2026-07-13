import type {
  Catalog,
  CatalogProvider,
  ChatEvent,
  SendMessageInput,
  SessionRevert,
} from "@/shared/chat"
import type { McpConfig, McpServerStatus } from "@/shared/mcp"
import type { ModelsSnapshot } from "@/shared/models"
import type { InitEvent, InitStatus, Memory, MemoryEvent } from "@/shared/memory"
import type { Skill, SkillProposal } from "@/shared/skills"
import type { AnalyticsSummary, AnalyticsRange } from "@/shared/analytics"
import type { PanelEvent } from "@/src/stores/panel-store"

/** Wrapper tipado sobre a bridge IPC exposta pelo preload. */

export const windowApi = {
  platform: window.platform,
  minimize: () => window.ipcRenderer?.invoke("window:minimize"),
  maximize: () => window.ipcRenderer?.invoke("window:maximize"),
  close: () => window.ipcRenderer?.invoke("window:close"),
  isMaximized: () => (window.ipcRenderer?.invoke("window:isMaximized") ?? Promise.resolve(false)) as Promise<boolean>,
  toggleFullscreen: () => window.ipcRenderer?.invoke("window:toggleFullscreen"),
  onMaximizedChange: (listener: (maximized: boolean) => void) => {
    if (!window.ipcRenderer) return () => {}
    const wrapper = window.ipcRenderer.on("window:maximized-change", (maximized) => listener(maximized as boolean))
    return () => window.ipcRenderer.off("window:maximized-change", wrapper)
  },
}

export const storage = {
  read: <T>(key: string) => window.ipcRenderer.invoke("storage:read", key) as Promise<T | null>,
  write: (key: string, value: unknown) => window.ipcRenderer.invoke("storage:write", key, value),
  remove: (key: string) => window.ipcRenderer.invoke("storage:remove", key),
  list: (prefix: string) => window.ipcRenderer.invoke("storage:list", prefix) as Promise<string[]>,
}

export const catalogApi = {
  get: () => window.ipcRenderer.invoke("catalog:get") as Promise<Catalog>,
}

export const modelsApi = {
  list: () => window.ipcRenderer.invoke("models:list") as Promise<ModelsSnapshot>,
  refresh: () => window.ipcRenderer.invoke("models:refresh") as Promise<ModelsSnapshot>,
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
  add: (id: string, name: string, baseURL: string, apiKey?: string) =>
    window.ipcRenderer.invoke("custom-providers:add", id, name, baseURL, apiKey) as Promise<CatalogProvider>,
  remove: (id: string) => window.ipcRenderer.invoke("custom-providers:remove", id) as Promise<void>,
  update: (id: string, patch: { name?: string; baseURL?: string; apiKey?: string }) =>
    window.ipcRenderer.invoke("custom-providers:update", id, patch) as Promise<CatalogProvider>,
  detect: () => window.ipcRenderer.invoke("custom-providers:detect") as Promise<DetectResult[]>,
}

export const sessionApi = {
  revert: (sessionId: string, messageId: string) =>
    window.ipcRenderer.invoke("session:revert", sessionId, messageId) as Promise<SessionRevert | null>,
  unrevert: (sessionId: string) =>
    window.ipcRenderer.invoke("session:unrevert", sessionId) as Promise<boolean>,
}

export const chatApi = {
  send: (input: SendMessageInput) => window.ipcRenderer.invoke("chat:send", input),
  abort: (sessionId: string) => window.ipcRenderer.invoke("chat:abort", sessionId),
  approvePlan: (sessionId: string, planId: string, taskIds?: string[]) =>
    window.ipcRenderer.invoke("chat:approvePlan", sessionId, planId, taskIds),
  rejectPlan: (sessionId: string) => window.ipcRenderer.invoke("chat:rejectPlan", sessionId),
  closeBrowser: (sessionId: string) => window.ipcRenderer.invoke("chat:closeBrowser", sessionId),
  askReply: (requestId: string, value: unknown) =>
    window.ipcRenderer.invoke("chat:askReply", requestId, value) as Promise<boolean>,
  onEvent: (listener: (event: ChatEvent) => void) => {
    const wrapper = window.ipcRenderer.on("chat:event", (event) => listener(event as ChatEvent))
    return () => window.ipcRenderer.off("chat:event", wrapper)
  },
}

export const skillsApi = {
  list: (directory?: string) =>
    window.ipcRenderer.invoke("skills:list", directory) as Promise<Skill[]>,
  create: (data: { name: string; description?: string; content: string; slug?: string; oldSlug?: string }) =>
    window.ipcRenderer.invoke("skills:create", data) as Promise<{ filePath: string }>,
  remove: (slug: string) => window.ipcRenderer.invoke("skills:remove", slug) as Promise<void>,
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

export const mcpApi = {
  config: () => window.ipcRenderer.invoke("mcp:config") as Promise<McpConfig>,
  status: () => window.ipcRenderer.invoke("mcp:status") as Promise<McpServerStatus[]>,
  save: (config: McpConfig) =>
    window.ipcRenderer.invoke("mcp:save", config) as Promise<McpServerStatus[]>,
  reconnect: (name?: string) =>
    window.ipcRenderer.invoke("mcp:reconnect", name) as Promise<McpServerStatus[]>,
}

export const analyticsApi = {
  summary: (range: AnalyticsRange) =>
    window.ipcRenderer.invoke("analytics:summary", range) as Promise<AnalyticsSummary>,
}

export const panelApi = {
  /** Registra (ou limpa, com null) o webContents do <webview> do painel */
  register: (webContentsId: number | null) =>
    window.ipcRenderer.send("panel:register", webContentsId),
  onEvent: (listener: (event: PanelEvent) => void) => {
    const wrapper = window.ipcRenderer.on("panel:event", (event) => listener(event as PanelEvent))
    return () => window.ipcRenderer.off("panel:event", wrapper)
  },
}

export const initApi = {
  run: (input: {
    directory: string
    providerId: string
    modelId: string
    workerProviderId?: string
    workerModelId?: string
    force?: boolean
  }) => window.ipcRenderer.invoke("init:run", input),
  status: (directory: string) =>
    window.ipcRenderer.invoke("init:status", directory) as Promise<InitStatus>,
  onEvent: (listener: (event: InitEvent) => void) => {
    const wrapper = window.ipcRenderer.on("init:event", (event) => listener(event as InitEvent))
    return () => window.ipcRenderer.off("init:event", wrapper)
  },
}

export const fsApi = {
  listFilesRecursive: (dirPath: string) =>
    window.ipcRenderer.invoke("fs:listFilesRecursive", dirPath) as Promise<{ ok: true; files: string[] } | { ok: false; error: string }>,
  readFileAsDataUrl: (filePath: string) =>
    window.ipcRenderer.invoke("fs:readFileAsDataUrl", filePath) as Promise<{ dataUrl: string } | { error: string }>,
}

export interface SearchHit {
  sessionId: string
  sessionTitle: string
  mode: string
  updatedAt: number
  snippet: string
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
