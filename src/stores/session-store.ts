import { nanoid } from "nanoid"
import { create } from "zustand"
import type {
  ChatEvent,
  ChatMessage,
  ChatStatus,
  FolderInfo,
  SendMessageOptions,
  SessionInfo,
  SessionMode,
} from "@/shared/chat"
import { StorageKeys } from "@/shared/chat"
import { chatApi, storage } from "@/src/lib/ipc"
import { useProviderStore } from "@/src/stores/provider-store"

/**
 * Store de sessões/mensagens no padrão do opencode: sessões persistidas
 * localmente (via storage do main process), mensagens compostas por parts e
 * status de streaming por sessão dirigindo a UI (persona em "thinking" etc).
 */

export interface SendConfig {
  options: SendMessageOptions
  directory?: string
  extraDirectories?: string[]
}

interface SessionState {
  initialized: boolean
  sessions: SessionInfo[]
  folders: FolderInfo[]
  messages: Record<string, ChatMessage[]>
  status: Record<string, ChatStatus>
  errors: Record<string, string | undefined>
  activeIds: Record<SessionMode, string | null>

  initialize: () => Promise<void>
  createSession: (mode: SessionMode, partial?: Partial<SessionInfo>) => Promise<SessionInfo>
  selectSession: (mode: SessionMode, id: string | null) => Promise<void>
  renameSession: (id: string, title: string) => void
  togglePin: (id: string) => void
  toggleArchive: (id: string) => void
  deleteSession: (id: string) => Promise<void>
  moveToFolder: (id: string, folderId: string | null) => void

  createFolder: (mode: SessionMode, name: string) => FolderInfo
  renameFolder: (id: string, name: string) => void
  toggleFolderPin: (id: string) => void
  deleteFolder: (id: string) => void

  sendMessage: (mode: SessionMode, text: string, config: SendConfig) => Promise<void>
  stopStreaming: (sessionId: string) => void
}

function persistSession(session: SessionInfo) {
  void storage.write(StorageKeys.session(session.id), session)
}

function persistFolders(folders: FolderInfo[]) {
  void storage.write(StorageKeys.folders, folders)
}

function updateSessionIn(state: SessionState, id: string, patch: Partial<SessionInfo>) {
  const sessions = state.sessions.map((s) => {
    if (s.id !== id) return s
    const next = { ...s, ...patch, updatedAt: Date.now() }
    persistSession(next)
    return next
  })
  return { sessions }
}

export const useSessionStore = create<SessionState>((set, get) => ({
  initialized: false,
  sessions: [],
  folders: [],
  messages: {},
  status: {},
  errors: {},
  activeIds: { chat: null, code: null },

  initialize: async () => {
    if (get().initialized) return
    set({ initialized: true })

    const keys = await storage.list(StorageKeys.sessionPrefix)
    const sessions = (
      await Promise.all(keys.map((key) => storage.read<SessionInfo>(key)))
    ).filter((s): s is SessionInfo => s !== null)
    sessions.sort((a, b) => b.updatedAt - a.updatedAt)

    const folders = (await storage.read<FolderInfo[]>(StorageKeys.folders)) ?? []
    set({ sessions, folders })

    chatApi.onEvent((event) => applyChatEvent(event, set, get))
  },

  createSession: async (mode, partial) => {
    const now = Date.now()
    const session: SessionInfo = {
      id: nanoid(),
      title: mode === "chat" ? "Nova conversa" : "Nova sessão de código",
      mode,
      pinned: false,
      archived: false,
      folderId: null,
      createdAt: now,
      updatedAt: now,
      ...partial,
    }
    await storage.write(StorageKeys.session(session.id), session)
    set((state) => ({
      sessions: [session, ...state.sessions],
      activeIds: { ...state.activeIds, [mode]: session.id },
      messages: { ...state.messages, [session.id]: [] },
    }))
    return session
  },

  selectSession: async (mode, id) => {
    set((state) => ({ activeIds: { ...state.activeIds, [mode]: id } }))
    if (id && get().messages[id] === undefined) {
      const messages = (await storage.read<ChatMessage[]>(StorageKeys.messages(id))) ?? []
      set((state) => ({ messages: { ...state.messages, [id]: messages } }))
    }
  },

  renameSession: (id, title) => set((state) => updateSessionIn(state, id, { title })),

  togglePin: (id) =>
    set((state) => {
      const session = state.sessions.find((s) => s.id === id)
      return session ? updateSessionIn(state, id, { pinned: !session.pinned }) : state
    }),

  toggleArchive: (id) =>
    set((state) => {
      const session = state.sessions.find((s) => s.id === id)
      return session ? updateSessionIn(state, id, { archived: !session.archived }) : state
    }),

  deleteSession: async (id) => {
    await storage.remove(StorageKeys.session(id))
    await storage.remove(StorageKeys.messages(id))
    void chatApi.closeBrowser(id)
    set((state) => {
      const messages = { ...state.messages }
      delete messages[id]
      const activeIds = { ...state.activeIds }
      for (const mode of ["chat", "code"] as SessionMode[]) {
        if (activeIds[mode] === id) activeIds[mode] = null
      }
      return { sessions: state.sessions.filter((s) => s.id !== id), messages, activeIds }
    })
  },

  moveToFolder: (id, folderId) => set((state) => updateSessionIn(state, id, { folderId })),

  createFolder: (mode, name) => {
    const folder: FolderInfo = { id: nanoid(), name, mode, pinned: false, createdAt: Date.now() }
    set((state) => {
      const folders = [...state.folders, folder]
      persistFolders(folders)
      return { folders }
    })
    return folder
  },

  renameFolder: (id, name) =>
    set((state) => {
      const folders = state.folders.map((f) => (f.id === id ? { ...f, name } : f))
      persistFolders(folders)
      return { folders }
    }),

  toggleFolderPin: (id) =>
    set((state) => {
      const folders = state.folders.map((f) => (f.id === id ? { ...f, pinned: !f.pinned } : f))
      persistFolders(folders)
      return { folders }
    }),

  deleteFolder: (id) =>
    set((state) => {
      const folders = state.folders.filter((f) => f.id !== id)
      persistFolders(folders)
      // Sessões da pasta voltam para a raiz
      const sessions = state.sessions.map((s) => {
        if (s.folderId !== id) return s
        const next = { ...s, folderId: null }
        persistSession(next)
        return next
      })
      return { folders, sessions }
    }),

  sendMessage: async (mode, text, config) => {
    const provider = useProviderStore.getState()
    const selected = provider.selectedModel
    if (!selected) {
      throw new Error("Nenhum modelo selecionado. Configure um provedor em Configurações.")
    }

    let sessionId = get().activeIds[mode]
    let session = get().sessions.find((s) => s.id === sessionId)
    if (!session) {
      session = await get().createSession(mode, {
        directory: config.directory,
        extraDirectories: config.extraDirectories,
      })
      sessionId = session.id
    } else if (mode === "code" && config.directory && session.directory !== config.directory) {
      set((state) =>
        updateSessionIn(state, session!.id, {
          directory: config.directory,
          extraDirectories: config.extraDirectories,
        }),
      )
    }

    set((state) => ({
      status: { ...state.status, [sessionId!]: "submitted" },
      errors: { ...state.errors, [sessionId!]: undefined },
    }))

    await chatApi.send({
      sessionId: sessionId!,
      text,
      providerId: selected.providerId,
      modelId: selected.modelId,
      mode,
      options: config.options,
      directory: config.directory ?? session.directory,
      extraDirectories: config.extraDirectories ?? session.extraDirectories,
    })
  },

  stopStreaming: (sessionId) => {
    void chatApi.abort(sessionId)
  },
}))

type Setter = (fn: (state: SessionState) => Partial<SessionState>) => void

function applyChatEvent(event: ChatEvent, set: Setter, get: () => SessionState) {
  const { sessionId } = event
  switch (event.type) {
    case "status":
      set((state) => ({
        status: { ...state.status, [sessionId]: event.status },
        errors: { ...state.errors, [sessionId]: event.error },
      }))
      break

    case "message":
      set((state) => {
        const list = state.messages[sessionId] ?? []
        const idx = list.findIndex((m) => m.id === event.message.id)
        const next = idx >= 0 ? list.map((m, i) => (i === idx ? event.message : m)) : [...list, event.message]
        return { messages: { ...state.messages, [sessionId]: next } }
      })
      break

    case "part":
      set((state) => {
        const list = state.messages[sessionId] ?? []
        const next = list.map((message) => {
          if (message.id !== event.messageId) return message
          const idx = message.parts.findIndex((p) => p.id === event.part.id)
          const parts =
            idx >= 0
              ? message.parts.map((p, i) => (i === idx ? event.part : p))
              : [...message.parts, event.part]
          return { ...message, parts }
        })
        return { messages: { ...state.messages, [sessionId]: next } }
      })
      break

    case "part-delta":
      set((state) => {
        const list = state.messages[sessionId] ?? []
        const next = list.map((message) => {
          if (message.id !== event.messageId) return message
          const parts = message.parts.map((part) => {
            if (part.id !== event.partId) return part
            if (part.type === "text" || part.type === "reasoning") {
              return { ...part, text: part.text + event.delta }
            }
            return part
          })
          return { ...message, parts }
        })
        return { messages: { ...state.messages, [sessionId]: next } }
      })
      break

    case "title":
      set((state) => {
        const sessions = state.sessions.map((s) => (s.id === sessionId ? { ...s, title: event.title } : s))
        return { sessions }
      })
      break
  }

  // Reordena sessões por atividade quando uma resposta termina
  if (event.type === "status" && event.status === "idle") {
    const state = get()
    const sessions = [...state.sessions].sort((a, b) => b.updatedAt - a.updatedAt)
    set(() => ({ sessions }))
  }
}

/** Sessão ativa do modo atual */
export function useActiveSession(mode: SessionMode) {
  return useSessionStore((state) => {
    const id = state.activeIds[mode]
    return id ? state.sessions.find((s) => s.id === id) : undefined
  })
}

export function useSessionStatus(sessionId: string | null | undefined): ChatStatus {
  return useSessionStore((state) => (sessionId ? state.status[sessionId] ?? "idle" : "idle"))
}
