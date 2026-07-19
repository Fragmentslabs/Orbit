import { create } from 'zustand'
export interface RevertResponse {
  revert: SessionRevert
  messages: ChatMessage[]
}

export interface MessagesResponse {
  messages: ChatMessage[]
}

import type {
  SessionInfo,
  SessionMode,
  SessionRevert,
  FolderInfo,
  ChatMessage,
  ChatStatus,
  ChatEvent,
  SendMessageOptions,
  FilePart,
  AskItem,
} from '@orbit/shared'
import { useConnectionStore } from './connection-store'
import { useSettingsStore } from './settings-store'
import { useChatStore } from './chat-store'

// ─── Types ──────────────────────────────────────────────────────────────────

interface SessionState {
  /** Lista de sessões do desktop. */
  sessions: SessionInfo[]
  /** Pastas do desktop. */
  folders: FolderInfo[]
  /** Sessão ativa (aberta). */
  activeSessionId: string | null
  /** Mensagens por sessão. */
  messages: Record<string, ChatMessage[]>
  /** Status de streaming por sessão. */
  status: Record<string, ChatStatus>
  /** Erros por sessão. */
  errors: Record<string, string | undefined>
  /** Busca lista de sessões via WS. */
  fetchSessions: () => Promise<void>
  /** Busca lista de pastas via WS. */
  fetchFolders: () => Promise<void>
  /** Seleciona sessão e carrega mensagens. */
  selectSession: (id: string | null) => Promise<void>
  /** Busca mensagens de uma sessão via WS. */
  fetchMessages: (sessionId: string) => Promise<void>
  /** Envia mensagem via WS (usa o modelo selecionado no settings-store por padrão). */
  sendMessage: (
    text: string,
    config?: {
      providerId?: string
      modelId?: string
      options?: SendMessageOptions
      sessionId?: string
      files?: FilePart[]
      /** Pastas do modo código (principal + adicionais). */
      directory?: string
      extraDirectories?: string[]
    },
  ) => Promise<void>
  /** Cria uma sessão nova no desktop e retorna-a. */
  createSession: (mode: SessionMode, title?: string) => Promise<SessionInfo | null>
  /** Aborta streaming de uma sessão. */
  abortChat: (sessionId: string) => void
  /** Renomeia uma sessão. */
  renameSession: (sessionId: string, title: string) => Promise<void>
  /** Fixa/desafixa uma sessão. */
  setPinned: (sessionId: string, pinned: boolean) => Promise<void>
  /** Arquiva/desarquiva uma sessão. */
  setArchived: (sessionId: string, archived: boolean) => Promise<void>
  /** Exclui uma sessão (e workers filhos, em cascata). */
  deleteSession: (sessionId: string) => Promise<void>
  /** Cria uma cópia (fork) de uma sessão, opcionalmente até uma mensagem. */
  forkSession: (sessionId: string, messageId?: string) => Promise<SessionInfo | null>
  /** Move uma sessão para uma pasta (ou para a raiz, com null). */
  moveToFolder: (sessionId: string, folderId: string | null) => Promise<void>
  /** Cria uma pasta nova. */
  createFolder: (mode: SessionMode, name: string) => Promise<FolderInfo | null>
  /** Renomeia uma pasta. */
  renameFolder: (folderId: string, name: string) => Promise<void>
  /** Fixa/desafixa uma pasta. */
  setFolderPinned: (folderId: string, pinned: boolean) => Promise<void>
  /** Remove uma pasta (sessões voltam pra raiz). */
  deleteFolder: (folderId: string) => Promise<void>
  /** Reverte sessão até uma mensagem específica (trunca msgs posteriores). */
  revertToMessage: (sessionId: string, messageId: string) => Promise<void>
  /** Desfaz o revert ativo, restaurando mensagens descartadas. */
  unrevert: (sessionId: string) => Promise<void>
  /** Aplica evento de chat recebido via WS. */
  applyChatEvent: (event: ChatEvent) => void
}

// ─── Delta batching ─────────────────────────────────────────────────────────
// Cada part-delta individual re-renderiza a lista de mensagens inteira
// (incluindo o parse de markdown do bubble) — em streaming rápido isso
// congestiona a thread JS e o texto aparece em blocos atrasados. Acumulamos
// os deltas e aplicamos em lote a cada ~60ms.

interface PendingDelta {
  sessionId: string
  messageId: string
  partId: string
  text: string
}

const deltaBuffer = new Map<string, PendingDelta>()
let deltaFlushTimer: ReturnType<typeof setTimeout> | null = null

function flushDeltas(set: (fn: (state: SessionState) => Partial<SessionState>) => void) {
  if (deltaFlushTimer) {
    clearTimeout(deltaFlushTimer)
    deltaFlushTimer = null
  }
  if (deltaBuffer.size === 0) return
  const pending = [...deltaBuffer.values()]
  deltaBuffer.clear()

  set((state) => {
    const messages = { ...state.messages }
    for (const delta of pending) {
      const list = messages[delta.sessionId]
      if (!list) continue
      messages[delta.sessionId] = list.map((message) => {
        if (message.id !== delta.messageId) return message
        const parts = message.parts.map((part) => {
          if (part.id !== delta.partId) return part
          if (part.type === 'text' || part.type === 'reasoning' || part.type === 'agent') {
            return { ...part, text: part.text + delta.text }
          }
          return part
        })
        return { ...message, parts }
      })
    }
    return { messages }
  })
}

// ─── Store ──────────────────────────────────────────────────────────────────

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  folders: [],
  activeSessionId: null,
  messages: {},
  status: {},
  errors: {},

  fetchSessions: async () => {
    const { wsClient } = useConnectionStore.getState()
    try {
      const res = await wsClient.send({ type: 'sessions:list' })
      if (res.ok && Array.isArray(res.data)) {
        const sessions = res.data as SessionInfo[]
        // Ordena por updatedAt desc (mais recente primeiro)
        sessions.sort((a, b) => b.updatedAt - a.updatedAt)
        set({ sessions })
      }
    } catch {
      // Silently fail — will retry on reconnect
    }
  },

  fetchFolders: async () => {
    const { wsClient } = useConnectionStore.getState()
    try {
      const res = await wsClient.send({ type: 'folders:list' })
      if (res.ok && Array.isArray(res.data)) {
        set({ folders: res.data as FolderInfo[] })
      }
    } catch {
      // Silently fail — will retry on reconnect
    }
  },

  selectSession: async (id) => {
    set({ activeSessionId: id })
    if (id) {
      await get().fetchMessages(id)
    }
  },

  fetchMessages: async (sessionId) => {
    const { wsClient } = useConnectionStore.getState()
    try {
      const res = await wsClient.send({
        type: 'messages:get',
        sessionId,
        limit: 200,
      })
      if (res.ok && Array.isArray(res.data)) {
        set((state) => ({
          messages: { ...state.messages, [sessionId]: res.data as ChatMessage[] },
        }))
      }
    } catch {
      // Silently fail
    }
  },

  sendMessage: async (text, config) => {
    const sessionId = config?.sessionId ?? get().activeSessionId
    if (!sessionId) return

    set((state) => ({
      status: { ...state.status, [sessionId]: 'submitted' },
      errors: { ...state.errors, [sessionId]: undefined },
    }))

    const { wsClient } = useConnectionStore.getState()
    // Modelo: explícito no config, senão o selecionado no desktop
    const settings = useSettingsStore.getState()
    const selected = settings.selectedModel
    const usesWorkers = config?.options?.subagents || config?.options?.orchestrate
    try {
      await wsClient.send({
        type: 'messages:send',
        sessionId,
        text,
        providerId: config?.providerId ?? selected?.providerId,
        modelId: config?.modelId ?? selected?.modelId,
        options: config?.options,
        files: config?.files,
        workerModel: usesWorkers ? settings.workerModel ?? undefined : undefined,
        directory: config?.directory,
        extraDirectories: config?.extraDirectories,
      })
    } catch (err) {
      set((state) => ({
        status: { ...state.status, [sessionId]: 'error' },
        errors: { ...state.errors, [sessionId]: String(err) },
      }))
    }
  },

  createSession: async (mode, title) => {
    const { wsClient } = useConnectionStore.getState()
    try {
      const res = await wsClient.send({ type: 'sessions:create', mode, title })
      if (res.ok && res.data) {
        const session = res.data as SessionInfo
        set((state) => {
          // O desktop também transmite um evento `session` do mesmo id — evita
          // inserir uma 2ª cópia (que causava "two children with the same key").
          const exists = state.sessions.some((s) => s.id === session.id)
          return {
            sessions: exists ? state.sessions : [session, ...state.sessions],
            messages:
              state.messages[session.id] === undefined
                ? { ...state.messages, [session.id]: [] }
                : state.messages,
          }
        })
        return session
      }
    } catch {
      // servidor pode ser de uma versão antiga sem sessions:create
    }
    return null
  },

  abortChat: (sessionId) => {
    const { wsClient } = useConnectionStore.getState()
    try {
      wsClient.send({ type: 'chat:abort', sessionId })
    } catch {
      // Silently fail
    }
  },

  renameSession: async (sessionId, title) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'sessions:rename', sessionId, title })
    if (res.ok && res.data) {
      const updated = res.data as SessionInfo
      set((state) => ({ sessions: state.sessions.map((s) => (s.id === updated.id ? updated : s)) }))
    }
  },

  setPinned: async (sessionId, pinned) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'sessions:pin', sessionId, pinned })
    if (res.ok && res.data) {
      const updated = res.data as SessionInfo
      set((state) => ({ sessions: state.sessions.map((s) => (s.id === updated.id ? updated : s)) }))
    }
  },

  setArchived: async (sessionId, archived) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'sessions:archive', sessionId, archived })
    if (res.ok && res.data) {
      const updated = res.data as SessionInfo
      set((state) => ({ sessions: state.sessions.map((s) => (s.id === updated.id ? updated : s)) }))
    }
  },

  deleteSession: async (sessionId) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'sessions:delete', sessionId })
    if (res.ok) {
      set((state) => {
        const sessions = state.sessions.filter((s) => s.id !== sessionId && s.parentId !== sessionId)
        const activeSessionId = state.activeSessionId === sessionId ? null : state.activeSessionId
        return { sessions, activeSessionId }
      })
    }
  },

  forkSession: async (sessionId, messageId) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'sessions:fork', sessionId, messageId })
    if (res.ok && res.data) {
      const fork = res.data as SessionInfo
      set((state) => ({ sessions: [fork, ...state.sessions] }))
      return fork
    }
    return null
  },

  moveToFolder: async (sessionId, folderId) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'sessions:move-folder', sessionId, folderId })
    if (res.ok && res.data) {
      const updated = res.data as SessionInfo
      set((state) => ({ sessions: state.sessions.map((s) => (s.id === updated.id ? updated : s)) }))
    }
  },

  createFolder: async (mode, name) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'folders:create', mode, name })
    if (res.ok && res.data) {
      const folder = res.data as FolderInfo
      set((state) => ({ folders: [...state.folders, folder] }))
      return folder
    }
    return null
  },

  renameFolder: async (folderId, name) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'folders:rename', folderId, name })
    if (res.ok && Array.isArray(res.data)) {
      set({ folders: res.data as FolderInfo[] })
    }
  },

  setFolderPinned: async (folderId, pinned) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'folders:pin', folderId, pinned })
    if (res.ok && Array.isArray(res.data)) {
      set({ folders: res.data as FolderInfo[] })
    }
  },

  deleteFolder: async (folderId) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'folders:delete', folderId })
    if (res.ok && Array.isArray(res.data)) {
      set((state) => ({
        folders: res.data as FolderInfo[],
        sessions: state.sessions.map((s) => (s.folderId === folderId ? { ...s, folderId: null } : s)),
      }))
    }
  },

  revertToMessage: async (sessionId, messageId) => {
    const { wsClient } = useConnectionStore.getState()
    try {
      const res = await wsClient.send({ type: 'sessions:revert', sessionId, messageId })
      if (res.ok && res.data) {
        const { revert, messages } = res.data as RevertResponse
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId ? { ...s, revert } : s,
          ),
          messages: { ...state.messages, [sessionId]: messages },
        }))
      }
    } catch {
      // Silently fail
    }
  },

  unrevert: async (sessionId) => {
    const { wsClient } = useConnectionStore.getState()
    try {
      const res = await wsClient.send({ type: 'sessions:unrevert', sessionId })
      if (res.ok && res.data) {
        const { messages } = res.data as MessagesResponse
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId ? { ...s, revert: undefined } : s,
          ),
          messages: { ...state.messages, [sessionId]: messages },
        }))
      }
    } catch {
      // Silently fail
    }
  },

  applyChatEvent: (event) => {
    const sessionId = 'sessionId' in event ? event.sessionId : ''

    // Eventos que tocam as mensagens diretamente precisam ver o texto já
    // acumulado — descarrega os deltas pendentes antes de aplicá-los.
    if (event.type === 'message' || event.type === 'part' || event.type === 'messages' || event.type === 'status') {
      flushDeltas(set)
    }

    switch (event.type) {
      case 'status':
        set((state) => ({
          status: { ...state.status, [sessionId]: event.status },
          errors: { ...state.errors, [sessionId]: event.error },
        }))
        break

      case 'message':
        set((state) => {
          const list = state.messages[sessionId] ?? []
          const idx = list.findIndex((m) => m.id === event.message.id)
          const next =
            idx >= 0
              ? list.map((m, i) => (i === idx ? event.message : m))
              : [...list, event.message]

          // Reconciliação de status: uma mensagem do assistente com `tokens`
          // (só definidos no 'finish' do stream) ou com erro significa que a
          // geração terminou. Se o evento `status: idle` se perder, isto
          // destrava o input/stop e some com o "Pensando".
          const m = event.message
          const finished =
            m.role === 'assistant' && (m.tokens !== undefined || m.error !== undefined)
          const status = finished
            ? { ...state.status, [sessionId]: 'idle' as ChatStatus }
            : state.status

          return { messages: { ...state.messages, [sessionId]: next }, status }
        })
        break

      case 'part':
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

      case 'part-delta': {
        // Acumula no buffer — o flush em lote (60ms) evita um re-render da
        // lista inteira por delta, que atrasava o streaming visivelmente.
        const key = `${sessionId}:${event.messageId}:${event.partId}`
        const pending = deltaBuffer.get(key)
        if (pending) {
          pending.text += event.delta
        } else {
          deltaBuffer.set(key, {
            sessionId,
            messageId: event.messageId,
            partId: event.partId,
            text: event.delta,
          })
        }
        if (!deltaFlushTimer) {
          deltaFlushTimer = setTimeout(() => flushDeltas(set), 100)
        }
        break
      }

      case 'messages':
        // Substituição completa (compactação, etc.)
        set((state) => ({
          messages: { ...state.messages, [sessionId]: event.messages },
        }))
        break

      case 'title':
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId ? { ...s, title: event.title } : s,
          ),
        }))
        break

      case 'session':
        // Sessão criada/atualizada pelo desktop (workers da orquestração)
        set((state) => {
          const exists = state.sessions.some((s) => s.id === event.session.id)
          const sessions = exists
            ? state.sessions.map((s) =>
                s.id === event.session.id ? event.session : s,
              )
            : [event.session, ...state.sessions]
          const messages =
            state.messages[event.session.id] === undefined
              ? { ...state.messages, [event.session.id]: [] }
              : state.messages
          return { sessions, messages }
        })
        break

      case 'session:deleted':
        set((state) => ({
          sessions: state.sessions.filter((s) => s.id !== event.sessionId),
          activeSessionId: state.activeSessionId === event.sessionId ? null : state.activeSessionId,
        }))
        break

      case 'folders':
        set({ folders: event.folders })
        break

      // ─── Permissões ──────────────────────────────────────────────

      case 'permission': {
        const { addPendingAsk } = useChatStore.getState()
        addPendingAsk(sessionId, {
          requestId: event.requestId,
          kind: 'permission',
          claim: event.claim,
          origin: event.origin,
        })
        break
      }

      case 'question': {
        const { addPendingAsk } = useChatStore.getState()
        addPendingAsk(sessionId, {
          requestId: event.requestId,
          kind: 'question',
          questions: event.questions,
          origin: event.origin,
        })
        break
      }

      case 'ask:done': {
        const { removePendingAsk } = useChatStore.getState()
        removePendingAsk(sessionId, event.requestId)
        break
      }
    }
  },
}))
