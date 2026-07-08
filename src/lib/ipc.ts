import type {
  Catalog,
  ChatEvent,
  SendMessageInput,
} from "@/shared/chat"

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
  closeBrowser: (sessionId: string) => window.ipcRenderer.invoke("chat:closeBrowser", sessionId),
  onEvent: (listener: (event: ChatEvent) => void) => {
    const wrapper = window.ipcRenderer.on("chat:event", (event) => listener(event as ChatEvent))
    return () => window.ipcRenderer.off("chat:event", wrapper)
  },
}
