import { create } from 'zustand'
import type {
  SessionInfo,
  ChatMessage,
  ChatStatus,
  ChatEvent,
} from '@orbit/shared'
import { useConnectionStore } from './connection-store'

// ─── Types ──────────────────────────────────────────────────────────────────

interface SessionState {
  /** Lista de sessões do desktop. */
  sessions: SessionInfo[]
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
  /** Seleciona sessão e carrega mensagens. */
  selectSession: (id: string | null) => Promise<void>
  /** Busca mensagens de uma sessão via WS. */
  fetchMessages: (sessionId: string) => Promise<void>
  /** Envia mensagem via WS. */
  sendMessage: (text: string, options?: { providerId?: string; modelId?: string }) => Promise<void>
  /** Aborta streaming de uma sessão. */
  abortChat: (sessionId: string) => void
  /** Aplica evento de chat recebido via WS. */
  applyChatEvent: (event: ChatEvent) => void
}

// ─── Store ──────────────────────────────────────────────────────────────────

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
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

  sendMessage: async (text, options) => {
    const { activeSessionId } = get()
    if (!activeSessionId) return

    set((state) => ({
      status: { ...state.status, [activeSessionId]: 'submitted' },
      errors: { ...state.errors, [activeSessionId]: undefined },
    }))

    const { wsClient } = useConnectionStore.getState()
    try {
      await wsClient.send({
        type: 'messages:send',
        sessionId: activeSessionId,
        text,
        providerId: options?.providerId,
        modelId: options?.modelId,
      })
    } catch (err) {
      set((state) => ({
        status: { ...state.status, [activeSessionId]: 'error' },
        errors: { ...state.errors, [activeSessionId]: String(err) },
      }))
    }
  },

  abortChat: (sessionId) => {
    const { wsClient } = useConnectionStore.getState()
    try {
      wsClient.send({ type: 'chat:abort', sessionId })
    } catch {
      // Silently fail
    }
  },

  applyChatEvent: (event) => {
    const { sessionId } = event

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
          return { messages: { ...state.messages, [sessionId]: next } }
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

      case 'part-delta':
        set((state) => {
          const list = state.messages[sessionId] ?? []
          const next = list.map((message) => {
            if (message.id !== event.messageId) return message
            const parts = message.parts.map((part) => {
              if (part.id !== event.partId) return part
              if (part.type === 'text' || part.type === 'reasoning' || part.type === 'agent') {
                return { ...part, text: part.text + event.delta }
              }
              return part
            })
            return { ...message, parts }
          })
          return { messages: { ...state.messages, [sessionId]: next } }
        })
        break

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
    }
  },
}))
