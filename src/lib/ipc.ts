import type {
  Catalog,
  ChatEvent,
  SendMessageInput,
} from "@/shared/chat"
import type { Memory, MemoryEvent } from "@/shared/memory"

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
