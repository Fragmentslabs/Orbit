import type {
  Catalog,
  ChatEvent,
  SendMessageInput,
} from "@/shared/chat"
import type { McpConfig, McpServerStatus } from "@/shared/mcp"
import type { Memory, MemoryEvent } from "@/shared/memory"
import type { Skill, SkillProposal } from "@/shared/skills"
import type { AnalyticsSummary, AnalyticsRange } from "@/shared/analytics"

/** Wrapper tipado sobre a bridge IPC exposta pelo preload. */

export const storage = {
  read: <T>(key: string) => window.ipcRenderer.invoke("storage:read", key) as Promise<T | null>,
  write: (key: string, value: unknown) => window.ipcRenderer.invoke("storage:write", key, value),
  remove: (key: string) => window.ipcRenderer.invoke("storage:remove", key),
  list: (prefix: string) => window.ipcRenderer.invoke("storage:list", prefix) as Promise<string[]>,
}

export const catalogApi = {
  get: () => window.ipcRenderer.invoke("catalog:get") as Promise<Catalog>,
}

export const authApi = {
  set: (providerId: string, key: string) => window.ipcRenderer.invoke("auth:set", providerId, key),
  remove: (providerId: string) => window.ipcRenderer.invoke("auth:remove", providerId),
  list: () => window.ipcRenderer.invoke("auth:list") as Promise<string[]>,
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

export const memoryApi = {
  list: () => window.ipcRenderer.invoke("memory:list") as Promise<Memory[]>,
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
