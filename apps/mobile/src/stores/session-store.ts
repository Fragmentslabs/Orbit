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
  SearchHit,
  PlanReview,
  OrchestrationPlan,
  PermissionMode,
} from '@orbit/shared'
import { Storage } from '~/lib/storage'
import { visibleMessageText } from '~/lib/message-utils'
import i18n from '~/i18n'
import { useConnectionStore } from './connection-store'
import { useDraftInput } from './draft-input-store'
import { useMessageQueueStore, __setSessionDeps } from './message-queue-store'
import { useSettingsStore } from './settings-store'
import { useChatStore, loadCachedAsks, CACHE_ASKS_PREFIX } from './chat-store'

// Cache keys
const CACHE_SESSIONS_KEY = 'orbit_cache_sessions'
const CACHE_MESSAGES_PREFIX = 'orbit_cache_msgs_'
const CACHE_ORCHESTRATION_PREFIX = 'orbit_cache_orch_'
const MAX_CACHED_SESSIONS = 20
const MAX_CACHED_MESSAGES = 200

async function cacheSessions(sessions: SessionInfo[]) {
  const recent = sessions.slice(0, MAX_CACHED_SESSIONS)
  await Storage.setItem(CACHE_SESSIONS_KEY, JSON.stringify(recent))
}

async function loadCachedSessions(): Promise<SessionInfo[]> {
  try {
    const raw = await Storage.getItem(CACHE_SESSIONS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

async function cacheMessages(sessionId: string, messages: ChatMessage[]) {
  const recent = messages.slice(-MAX_CACHED_MESSAGES)
  await Storage.setItem(CACHE_MESSAGES_PREFIX + sessionId, JSON.stringify(recent))
}

async function loadCachedMessages(sessionId: string): Promise<ChatMessage[] | null> {
  try {
    const raw = await Storage.getItem(CACHE_MESSAGES_PREFIX + sessionId)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

async function cacheOrchestration(sessionId: string, plan: OrchestrationPlan) {
  await Storage.setItem(CACHE_ORCHESTRATION_PREFIX + sessionId, JSON.stringify(plan))
}

async function loadCachedOrchestration(sessionId: string): Promise<OrchestrationPlan | null> {
  try {
    const raw = await Storage.getItem(CACHE_ORCHESTRATION_PREFIX + sessionId)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

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
  /** Plan reviews (modo plano) por sessão. */
  planReviews: Record<string, PlanReview>
  /** Sessões que aguardam criação de PlanReview ao fim do streaming. */
  _planReviewOutbox: Record<string, boolean>
  /** Planos de orquestração por sessão. */
  orchestration: Record<string, OrchestrationPlan>
  /** Contagem de mensagens não lidas por sessão. */
  unreadCounts: Record<string, number>
  /** Busca lista de sessões via WS. */
  fetchSessions: () => Promise<void>
  /** Busca textual em títulos e mensagens (mesma lógica do desktop). */
  searchSessions: (query: string) => Promise<SearchHit[]>
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
  /** Aceita plano de implementação (modo plano). */
  acceptPlanReview: (sessionId: string, permissionMode: PermissionMode, orchestrate?: boolean) => Promise<void>
  /** Rejeita plano de implementação (modo plano). */
  rejectPlanReview: (sessionId: string) => Promise<void>
  /** Envia feedback para revisar o plano (modo plano). */
  reviewPlanReview: (sessionId: string, feedback: string) => Promise<void>
  /** Aprova plano de orquestração. */
  approvePlan: (sessionId: string, planId: string, taskIds?: string[]) => Promise<void>
  /** Rejeita plano de orquestração. */
  rejectPlan: (sessionId: string) => Promise<void>
  /** Aplica evento de chat recebido via WS. */
  applyChatEvent: (event: ChatEvent) => void
}

// ─── Delta batching ─────────────────────────────────────────────────────────
// Agrupa part-deltas num frame (~33ms) para o stream parecer fluido sem
// re-render por token. Atualiza só a mensagem afetada (cópia do array).

interface PendingDelta {
  sessionId: string
  messageId: string
  partId: string
  text: string
}

const DELTA_FLUSH_MS = 33

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
    // Agrupa por sessão para copiar cada lista uma vez
    const bySession = new Map<string, PendingDelta[]>()
    for (const d of pending) {
      const list = bySession.get(d.sessionId)
      if (list) list.push(d)
      else bySession.set(d.sessionId, [d])
    }
    for (const [sessionId, deltas] of bySession) {
      const list = messages[sessionId]
      if (!list) continue
      const next = list.slice()
      for (const delta of deltas) {
        // Mensagem ativa costuma ser a última — busca do fim
        let msgIdx = -1
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i].id === delta.messageId) {
            msgIdx = i
            break
          }
        }
        if (msgIdx < 0) continue
        const message = next[msgIdx]
        const parts = message.parts.slice()
        const partIdx = parts.findIndex((p) => p.id === delta.partId)
        if (partIdx < 0) continue
        const part = parts[partIdx]
        if (part.type === 'text' || part.type === 'reasoning' || part.type === 'agent') {
          parts[partIdx] = { ...part, text: part.text + delta.text }
          next[msgIdx] = { ...message, parts }
        }
      }
      messages[sessionId] = next
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
  planReviews: {},
  _planReviewOutbox: {},
  orchestration: {},
  unreadCounts: {},

  fetchSessions: async () => {
    const { wsClient, connection } = useConnectionStore.getState()
    try {
      const res = await wsClient.send({ type: 'sessions:list' })
      if (res.ok && Array.isArray(res.data)) {
        const sessions = res.data as SessionInfo[]
        // Ordena por updatedAt desc (mais recente primeiro)
        sessions.sort((a, b) => b.updatedAt - a.updatedAt)
        set({ sessions })
        void cacheSessions(sessions)
      }
    } catch {
      // Fallback para cache quando offline
      const cached = await loadCachedSessions()
      if (cached.length > 0) set({ sessions: cached })
    }
  },

  searchSessions: async (query) => {
    const q = query.trim()
    if (!q) return []
    const { wsClient } = useConnectionStore.getState()
    try {
      const res = await wsClient.send({ type: 'sessions:search', query: q })
      if (res.ok && Array.isArray(res.data)) {
        return res.data as SearchHit[]
      }
      return []
    } catch {
      return []
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
    set((state) => ({
      activeSessionId: id,
      unreadCounts: id ? { ...state.unreadCounts, [id]: 0 } : state.unreadCounts,
    }))
    if (id) {
      // Carrega do cache primeiro (instantâneo), depois busca da rede
      const cached = await loadCachedMessages(id)
      if (cached) {
        set((state) => ({
          messages: { ...state.messages, [id]: cached },
        }))
      }
      // Carrega pedidos pendentes do cache
      const asks = await loadCachedAsks(id)
      if (asks && asks.length > 0) {
        useChatStore.getState().setPendingAsks(id, asks)
      }
      // Carrega plano de orquestração do cache
      const plan = await loadCachedOrchestration(id)
      if (plan) {
        set((state) => ({
          orchestration: { ...state.orchestration, [id]: plan },
        }))
      }
      // Fetch da rede em background (atualiza quando chegar)
      void get().fetchMessages(id)
    }
  },

  fetchMessages: async (sessionId) => {
    const { wsClient, connection } = useConnectionStore.getState()
    try {
      const res = await wsClient.send({
        type: 'messages:get',
        sessionId,
        limit: 200,
      })
      if (res.ok && Array.isArray(res.data)) {
        const msgs = res.data as ChatMessage[]
        set((state) => ({
          messages: { ...state.messages, [sessionId]: msgs },
        }))
        void cacheMessages(sessionId, msgs)
      }
    } catch {
      // Fallback para cache quando offline
      const cached = await loadCachedMessages(sessionId)
      if (cached) {
        set((state) => ({
          messages: { ...state.messages, [sessionId]: cached },
        }))
      }
    }
  },

  sendMessage: async (text, config) => {
    const sessionId = config?.sessionId ?? get().activeSessionId
    if (!sessionId) return

    const { wsClient, connection } = useConnectionStore.getState()
    const isOnline = connection.status === 'connected'

    if (!isOnline) {
      // Offline: enfileira para enviar quando reconectar
      const session = get().sessions.find((s) => s.id === sessionId)
      const mode = session?.mode ?? 'chat'
      useMessageQueueStore.getState().enqueueForSend(sessionId, text, config?.options ?? {}, mode, {
        directory: config?.directory,
        extraDirectories: config?.extraDirectories,
        files: config?.files,
      })
      // Mostra status de erro amigável
      set((state) => ({
        status: { ...state.status, [sessionId]: 'error' as ChatStatus },
        errors: { ...state.errors, [sessionId]: i18n.t('sessionStore.queuedOffline') },
      }))
      return
    }

    set((state) => ({
      status: { ...state.status, [sessionId]: 'submitted' },
      errors: { ...state.errors, [sessionId]: undefined },
    }))

    if (config?.options?.plan) {
      set((state) => ({ _planReviewOutbox: { ...state._planReviewOutbox, [sessionId]: true } }))
    }

    // Modelo: explícito no config, senão o selecionado no desktop
    const settings = useSettingsStore.getState()
    const selected = settings.selectedModel
    const usesWorkers = config?.options?.subagents || config?.options?.orchestrate
    const workerModel = usesWorkers && settings.workerModel
      ? { ...settings.workerModel, reasoning: settings.workerReasoning ?? undefined }
      : undefined
    const loopConfig = config?.options?.loop ? settings.loopConfig : undefined
    try {
      await wsClient.send({
        type: 'messages:send',
        sessionId,
        text,
        providerId: config?.providerId ?? selected?.providerId,
        modelId: config?.modelId ?? selected?.modelId,
        options: config?.options,
        files: config?.files,
        workerModel,
        loopConfig,
        directory: config?.directory,
        extraDirectories: config?.extraDirectories,
      } as any)
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
        const planReviews = { ...state.planReviews }
        delete planReviews[sessionId]
        const orchestration = { ...state.orchestration }
        delete orchestration[sessionId]
        const _planReviewOutbox = { ...(state._planReviewOutbox ?? {}) }
        delete _planReviewOutbox[sessionId]
        const unreadCounts = { ...state.unreadCounts }
        delete unreadCounts[sessionId]
        // Limpa pendingAsks da memória e do cache
        const pendingAsks = { ...useChatStore.getState().pendingAsks }
        delete pendingAsks[sessionId]
        useChatStore.setState({ pendingAsks, activeAskSessionId: useChatStore.getState().activeAskSessionId === sessionId ? null : useChatStore.getState().activeAskSessionId })
        return { sessions, activeSessionId, planReviews, orchestration, _planReviewOutbox, unreadCounts }
      })
      // Cleanup de arquivos de cache
      void Storage.removeItem(CACHE_ASKS_PREFIX + sessionId)
      void Storage.removeItem(CACHE_ORCHESTRATION_PREFIX + sessionId)
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

  acceptPlanReview: async (sessionId, permissionMode, orchestrate) => {
    const review = get().planReviews[sessionId]
    if (!review || review.status !== 'proposed') return
    const updated: PlanReview = { ...review, status: 'implementing', permissionMode }
    set((state) => ({ planReviews: { ...state.planReviews, [sessionId]: updated } }))

    const session = get().sessions.find((s) => s.id === sessionId)
    const settings = useSettingsStore.getState()
    const { wsClient } = useConnectionStore.getState()
    try {
      await wsClient.send({
        type: 'plan:review-accept',
        sessionId,
        messageId: review.messageId,
        permissionMode,
        providerId: settings.selectedModel?.providerId,
        modelId: settings.selectedModel?.modelId,
        orchestrate,
      })
    } catch {
      // Silently fail — the desktop will handle it
    }
  },

  rejectPlanReview: async (sessionId) => {
    const review = get().planReviews[sessionId]
    if (!review || review.status !== 'proposed') return
    const updated: PlanReview = { ...review, status: 'rejected' }
    set((state) => ({ planReviews: { ...state.planReviews, [sessionId]: updated } }))

    const { wsClient } = useConnectionStore.getState()
    try {
      await wsClient.send({ type: 'plan:review-reject', sessionId })
    } catch {
      // Silently fail
    }
  },

  reviewPlanReview: async (sessionId, feedback) => {
    const review = get().planReviews[sessionId]
    if (!review || review.status !== 'proposed') return
    const updated: PlanReview = { ...review, status: 'revising' }
    set((state) => ({ planReviews: { ...state.planReviews, [sessionId]: updated } }))

    const settings = useSettingsStore.getState()
    const { wsClient } = useConnectionStore.getState()
    try {
      await wsClient.send({
        type: 'plan:review-revise',
        sessionId,
        messageId: review.messageId,
        feedback,
        permissionMode: review.permissionMode ?? 'ask',
        providerId: settings.selectedModel?.providerId,
        modelId: settings.selectedModel?.modelId,
      })
    } catch {
      // Silently fail
    }
  },

  approvePlan: async (sessionId, planId, taskIds) => {
    const plan = get().orchestration[sessionId]
    if (!plan || plan.id !== planId) return

    const { wsClient } = useConnectionStore.getState()
    try {
      await wsClient.send({ type: 'orchestration:approve', sessionId, planId, taskIds })
    } catch {
      // Silently fail
    }
  },

  rejectPlan: async (sessionId) => {
    const { wsClient } = useConnectionStore.getState()
    try {
      await wsClient.send({ type: 'orchestration:reject', sessionId })
    } catch {
      // Silently fail
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
        // A mensagem revertida volta para o input, como se estivesse sendo
        // editada. O texto sai de `discardedMessages` em vez de vir num campo
        // próprio do SessionRevert: anexos são data URLs e duplicá-los dobraria
        // o tamanho da sessão em disco.
        const prompt = revert?.discardedMessages?.find((m) => m.role === 'user')
        if (prompt) {
          const files = prompt.parts.filter((p): p is FilePart => p.type === 'file')
          useDraftInput.getState().setDraft(sessionId, visibleMessageText(prompt), files)
        }
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
        set((state) => {
          const patch: Record<string, any> = {
            status: { ...state.status, [sessionId]: event.status },
            errors: { ...state.errors, [sessionId]: event.error },
          }
          // Cria PlanReview ao fim do streaming se estava em modo plano
          if (event.status === 'idle' && state._planReviewOutbox?.[sessionId] && !state.planReviews[sessionId]) {
            const msgs = state.messages[sessionId] ?? []
            const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant')
            if (lastAssistant) {
              patch.planReviews = { ...state.planReviews, [sessionId]: { status: 'proposed', messageId: lastAssistant.id } }
            }
            const cleanOutbox = { ...state._planReviewOutbox }
            delete cleanOutbox[sessionId]
            patch._planReviewOutbox = cleanOutbox
          }
          return patch
        })
        break

      case 'message':
        set((state) => {
          const list = state.messages[sessionId] ?? []
          const idx = list.findIndex((m) => m.id === event.message.id)
          const next =
            idx >= 0
              ? list.map((m, i) => (i === idx ? event.message : m))
              : [...list, event.message]

          // Cache após receber mensagem completa
          void cacheMessages(sessionId, next)

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

          // Incrementa contador de não lidas se a sessão não está ativa
          const isInbound = m.role === 'assistant'
          const activeId = state.activeSessionId
          const unreadCounts =
            isInbound && sessionId !== activeId
              ? { ...state.unreadCounts, [sessionId]: (state.unreadCounts[sessionId] ?? 0) + 1 }
              : state.unreadCounts

          return { messages: { ...state.messages, [sessionId]: next }, status, unreadCounts }
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
          deltaFlushTimer = setTimeout(() => flushDeltas(set), DELTA_FLUSH_MS)
        }
        break
      }

      case 'messages':
        // Substituição completa (compactação, etc.)
        set((state) => ({
          messages: { ...state.messages, [sessionId]: event.messages },
        }))
        void cacheMessages(sessionId, event.messages)
        break

      case 'title':
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId ? { ...s, title: event.title } : s,
          ),
        }))
        break

      case 'orchestration:plan':
        set((state) => ({
          orchestration: { ...state.orchestration, [sessionId]: event.plan },
        }))
        void cacheOrchestration(sessionId, event.plan)
        break

      case 'plan:review':
        set((state) => ({
          planReviews: { ...state.planReviews, [sessionId]: event.review },
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
          void cacheSessions(sessions)
          return { sessions, messages }
        })
        break

      case 'session:deleted':
        set((state) => {
          const sessions = state.sessions.filter((s) => s.id !== event.sessionId)
          const unreadCounts = { ...state.unreadCounts }
          delete unreadCounts[event.sessionId]
          void cacheSessions(sessions)
          return {
            sessions,
            unreadCounts,
            activeSessionId: state.activeSessionId === event.sessionId ? null : state.activeSessionId,
          }
        })
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

      case 'ask:batch': {
        const { addPendingAsk } = useChatStore.getState()
        const items = (event.items ?? []) as Array<{ requestId: string; kind: string; claim?: unknown; questions?: unknown; origin?: unknown }>
        for (const item of items) {
          addPendingAsk(sessionId, {
            requestId: item.requestId,
            kind: item.kind as 'permission' | 'question',
            claim: item.claim as any,
            questions: item.questions as any,
            origin: item.origin as any,
            batchId: event.batchId,
          })
        }
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

__setSessionDeps({
  getStatus: (sessionId) => useSessionStore.getState().status[sessionId],
  sendMessage: (text, config) => useSessionStore.getState().sendMessage(text, config),
})
