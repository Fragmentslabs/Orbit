import { create } from 'zustand'
import { Alert } from 'react-native'
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
  SearchHit,
  PlanReview,
  OrchestrationPlan,
  PermissionMode,
  SessionStateResponse,
  UnrevertResult,
} from '@orbit/shared'
import { normalizeOrchestrationPlan, parseMessageReply, SESSION_BUSY_ERROR } from '@orbit/shared'
import { useReply } from '~/stores/reply-store'
import { Storage } from '~/lib/storage'
import { visibleMessageText } from '~/lib/message-utils'
import i18n from '~/i18n'
import { useConnectionStore } from './connection-store'
import { useDraftInput } from './draft-input-store'
import { newQueueId, useMessageQueueStore } from './message-queue-store'
import { useSettingsStore } from './settings-store'
import { useChatStore, loadCachedAsks, CACHE_ASKS_PREFIX } from './chat-store'
import { useModeOverrides, modeActiveFor } from './mode-overrides'
import { useModelModePrefs } from './model-mode-prefs'
import { useSimplePrefs } from './simple-prefs'
import { useBrainPrefs } from './brain-prefs'
import { DRAFT_KEY, useSessionModelPrefs, type SelectedModel } from './session-model-prefs'
import { useModelRotationStore } from './model-rotation-store'
import { sessionReasoningFor, useSessionReasoning } from './session-reasoning'
import { usePermissionPrefs } from './permission-prefs'
import { saveLastSessionId } from './last-chat-store'

export interface RevertResponse {
  revert: SessionRevert
  messages: ChatMessage[]
}

export interface MessagesResponse {
  messages: ChatMessage[]
  /** Summary of the unrevert: what came back and what stayed intact due to a conflict. */
  result?: UnrevertResult
}

// ─── Effective model of the session ──────────────────────────────────────────
// Mixes three rules (per-chat override > draft > last chat > global
// default). It lives in session-store — and not in session-model-prefs — because
// it depends on the session list; that avoids the require cycle between the two
// stores (session-model-prefs only holds the overrides).

/** Most recent session that is not archived and not a worker — its model is the default
 *  of the next new chat. */
function latestSession(sessions: SessionInfo[]): SessionInfo | undefined {
  return sessions.filter((s) => !s.archived && !s.parentId).sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

/** Effective model of the session: per-chat override > global default. A new chat
 *  (draft) without an explicit choice inherits the model of the last chat used before
 *  falling back to the global default. */
export function sessionModelFor(sessionId?: string | null): SelectedModel | null {
  const prefs = useSessionModelPrefs.getState()
  const override = prefs.overrides[sessionId ?? DRAFT_KEY]
  if (override) return override
  if (!sessionId) {
    const latest = latestSession(useSessionStore.getState().sessions)
    const latestOverride = latest ? prefs.overrides[latest.id] : undefined
    if (latestOverride) return latestOverride
  }
  return useSettingsStore.getState().selectedModel
}

/** Reactive hook of the effective model of the session (reacts to the override, to the default and to the
 *  most recent session — so the new chat follows the last model used). */
export function useSessionModel(sessionId?: string | null): SelectedModel | null {
  const overrides = useSessionModelPrefs((s) => s.overrides)
  const globalModel = useSettingsStore((s) => s.selectedModel)
  const sessions = useSessionStore((s) => s.sessions)
  const override = sessionId ? overrides[sessionId] : overrides[DRAFT_KEY]
  if (override) return override
  if (sessionId) return globalModel
  const latest = latestSession(sessions)
  return (latest && overrides[latest.id]) ?? globalModel
}

// Cache keys
const CACHE_SESSIONS_KEY = 'orbit_cache_sessions'
const CACHE_MESSAGES_PREFIX = 'orbit_cache_msgs_'
const CACHE_ORCHESTRATION_PREFIX = 'orbit_cache_orch_'
const MAX_CACHED_SESSIONS = 20
const INITIAL_MESSAGES_LIMIT = 40
const MAX_CACHED_MESSAGES = 200
const MAX_INITIAL_CACHED_MESSAGES = INITIAL_MESSAGES_LIMIT

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
    // Legacy plans (Portuguese keys/phase values) are translated at the read edge.
    return raw ? normalizeOrchestrationPlan(JSON.parse(raw)) ?? null : null
  } catch { return null }
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface SessionState {
  /** Session list of the desktop. */
  sessions: SessionInfo[]
  /** Folders of the desktop. */
  folders: FolderInfo[]
  /** Active session (open). */
  activeSessionId: string | null
  /** Messages per session. */
  messages: Record<string, ChatMessage[]>
  /** Streaming status per session. */
  status: Record<string, ChatStatus>
  /** Errors per session. */
  errors: Record<string, string | undefined>
  /** Plan reviews (plan mode) per session. */
  planReviews: Record<string, PlanReview>
  /** Sessions waiting for the creation of a PlanReview at the end of the streaming. */
  _planReviewOutbox: Record<string, boolean>
  /** Sessions whose PlanReview was created here (sending in plan mode from the phone)
   *  and therefore does not exist yet on the desktop disk — it cannot be cleared by
   *  session:state, otherwise the card would vanish when reopening the conversation. */
  _localPlanReviews: Record<string, boolean>
  /** Orchestration plans per session. */
  orchestration: Record<string, OrchestrationPlan>
  /** Count of unread messages per session. */
  unreadCounts: Record<string, number>
  /** Fetches the session list via WS. */
  fetchSessions: () => Promise<void>
  /** Text search in titles and messages (same logic as the desktop). */
  searchSessions: (query: string) => Promise<SearchHit[]>
  /** Fetches the folder list via WS. */
  fetchFolders: () => Promise<void>
  /** Synchronizes who is running on the desktop (the engine lives there). */
  fetchRunningSessions: () => Promise<void>
  /** Selects a session and loads the messages. */
  selectSession: (id: string | null) => Promise<void>
  /** Fetches the most recent messages of a session via WS. */
  fetchMessages: (sessionId: string) => Promise<void>
  /** Loads a page of older messages, attaching it at the beginning. */
  loadOlderMessages: (sessionId: string) => Promise<void>

  sendMessage: (
    text: string,
    config?: {
      providerId?: string
      modelId?: string
      options?: SendMessageOptions
      sessionId?: string
      files?: FilePart[]
      /** Folders of code mode (main + additional ones). */
      directory?: string
      extraDirectories?: string[]
    },
  ) => Promise<void>
  /** Creates a new session on the desktop and returns it. */
  createSession: (mode: SessionMode, title?: string) => Promise<SessionInfo | null>
  /** Aborts the streaming of a session. */
  abortChat: (sessionId: string) => void
  /** Renames a session. */
  renameSession: (sessionId: string, title: string) => Promise<void>
  /** Pins/unpins a session. */
  setPinned: (sessionId: string, pinned: boolean) => Promise<void>
  /** Archives/unarchives a session. */
  setArchived: (sessionId: string, archived: boolean) => Promise<void>
  /** Deletes a session (and child workers, in cascade). */
  deleteSession: (sessionId: string) => Promise<void>
  /** Creates a copy (fork) of a session, optionally up to a message. */
  forkSession: (sessionId: string, messageId?: string) => Promise<SessionInfo | null>
  /** Moves a session to a folder (or to the root, with null). */
  moveToFolder: (sessionId: string, folderId: string | null) => Promise<void>
  /** Creates a new folder. */
  createFolder: (mode: SessionMode, name: string) => Promise<FolderInfo | null>
  /** Renames a folder. */
  renameFolder: (folderId: string, name: string) => Promise<void>
  /** Pins/unpins a folder. */
  setFolderPinned: (folderId: string, pinned: boolean) => Promise<void>
  /** Archives/unarchives a folder — its chats follow along. */
  setFolderArchived: (folderId: string, archived: boolean) => Promise<void>
  /** Removes a folder (sessions go back to the root). */
  deleteFolder: (folderId: string) => Promise<void>
  /** Reorganizes the sidebar (merges duplicate folders and pulls loose chats
   *  into the project folder). Runs on the desktop; the result comes back through
   *  the session/folder events. false = the desktop could not run it (on macOS the
   *  app stays alive without an open window, and it is the window that reorganizes). */
  organizeSidebar: () => Promise<boolean>
  /** Reverts the session up to a specific message (truncates later msgs). */
  revertToMessage: (sessionId: string, messageId: string) => Promise<void>
  /** Undoes the active revert, restoring the discarded messages. */
  unrevert: (sessionId: string) => Promise<void>
  /** Reverts the files of uncertain authorship of the active revert as well. */
  revertUncertain: (sessionId: string) => Promise<void>
  /** Accepts the implementation plan (plan mode). */
  acceptPlanReview: (sessionId: string, permissionMode: PermissionMode, orchestrate?: boolean) => Promise<void>
  /** Rejects the implementation plan (plan mode). */
  rejectPlanReview: (sessionId: string) => Promise<void>
  /** Sends feedback to revise the plan (plan mode). */
  reviewPlanReview: (sessionId: string, feedback: string) => Promise<void>
  /** Approves an orchestration plan. */
  approvePlan: (sessionId: string, planId: string, taskIds?: string[]) => Promise<void>
  /** Rejects an orchestration plan. */
  rejectPlan: (sessionId: string) => Promise<void>
  /** Applies a chat event received via WS. */
  applyChatEvent: (event: ChatEvent) => void
}

// ─── Delta batching ─────────────────────────────────────────────────────────
// Groups part-deltas into one frame (~33ms) so the stream looks fluid without
// a re-render per token. It updates only the affected message (copy of the array).

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
    // Groups by session so each list is copied once
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
        // The active message is usually the last one — search from the end
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
  _localPlanReviews: {},
  orchestration: {},
  unreadCounts: {},

  fetchSessions: async () => {
    const { wsClient } = useConnectionStore.getState()
    try {
      const res = await wsClient.send({ type: 'sessions:list' })
      if (res.ok && Array.isArray(res.data)) {
        const sessions = res.data as SessionInfo[]
        // Sorts by updatedAt desc (most recent first)
        sessions.sort((a, b) => b.updatedAt - a.updatedAt)
        set({ sessions })
        void cacheSessions(sessions)
      }
    } catch {
      // Fallback to the cache when offline
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

  fetchRunningSessions: async () => {
    const { wsClient } = useConnectionStore.getState()
    try {
      const res = await wsClient.send({ type: 'sessions:running' })
      if (!res.ok || !Array.isArray(res.data)) return
      const running = new Set(res.data as string[])
      set((state) => {
        const status = { ...state.status }
        for (const id of running) {
          if (status[id] !== 'streaming') status[id] = 'streaming'
        }
        // Finished while the phone was away: the 'status: idle' went by with no one
        // listening and the spinner would stay stuck forever.
        for (const id of Object.keys(status)) {
          if (status[id] === 'streaming' && !running.has(id)) status[id] = 'idle'
        }
        return { status }
      })
    } catch {
      // Silently fail — will retry on reconnect
    }
  },

  selectSession: async (id) => {
    // Remembers the last open chat: reopening the app comes back here (and the
    // input draft comes along). A new chat (null) clears the memory.
    void saveLastSessionId(id)
    set((state) => ({
      activeSessionId: id,
      unreadCounts: id ? { ...state.unreadCounts, [id]: 0 } : state.unreadCounts,
    }))
    if (id) {
      // Loads from the cache first (instant), then fetches from the network
      const cached = await loadCachedMessages(id)
      if (cached) {
        // The cache may hold up to 200 items for future use, but the opening
        // must mount only the light initial window.
        set((state) => ({
          messages: { ...state.messages, [id]: cached.slice(-MAX_INITIAL_CACHED_MESSAGES) },
        }))
      }

      const asks = await loadCachedAsks(id)
      if (asks && asks.length > 0) {
        useChatStore.getState().setPendingAsks(id, asks)
      }
      // Loads the orchestration plan from the cache
      const plan = await loadCachedOrchestration(id)
      if (plan) {
        set((state) => ({
          orchestration: { ...state.orchestration, [id]: plan },
        }))
      }
      // Network fetch in the background (updates when it arrives)
      void get().fetchMessages(id)
    }
  },

  fetchMessages: async (sessionId) => {
    const { wsClient } = useConnectionStore.getState()
    // Plan, review and pending requests do not come in the messages: without this fetch,
    // reopening the conversation (or pairing the phone after the card was emitted)
    // lost the cards even with the request still pending on the desktop — mobile
    // only knew them from the live events, which had already gone by.
    const askIdsBefore = new Set(
      (useChatStore.getState().pendingAsks[sessionId] ?? []).map((a) => a.requestId),
    )
    const planReviewBefore = get().planReviews[sessionId]
    const planBefore = get().orchestration[sessionId]
    void wsClient
      .send({ type: 'session:state', sessionId })
      .then((res) => {
        if (!res.ok || !res.data) return
        const state = res.data as SessionStateResponse
        set((prev) => {
          const planReviews = { ...prev.planReviews }
          if (state.planReview) planReviews[sessionId] = state.planReview
          // No review on the desktop, nothing changed here since the fetch and the card is not
          // optimistic from this app: it was accepted/rejected while the phone was
          // away — it leaves the screen instead of becoming a dead card.
          else if (
            prev.planReviews[sessionId] === planReviewBefore &&
            !prev._localPlanReviews[sessionId]
          ) {
            delete planReviews[sessionId]
          }

          const orchestration = { ...prev.orchestration }
          if (state.plan) orchestration[sessionId] = state.plan
          else if (prev.orchestration[sessionId] === planBefore) {
            delete orchestration[sessionId]
            void Storage.removeItem(CACHE_ORCHESTRATION_PREFIX + sessionId)
          }
          return { planReviews, orchestration }
        })
        // Authoritative list of the question/permission cards of the desktop.
        useChatStore.getState().syncPendingAsks(sessionId, state.pendingAsks ?? [], askIdsBefore)
      })
      .catch(() => {})
    try {
      const res = await wsClient.send({
        type: 'messages:get',
        sessionId,
        limit: INITIAL_MESSAGES_LIMIT,
      })
      if (res.ok && Array.isArray(res.data)) {
        const msgs = res.data as ChatMessage[]
        set((state) => {
          const current = state.messages[sessionId] ?? []
          // The network is authoritative: the desktop response already comes with the media
          // URLs rewritten (http://host:3848/...t=token). Before, the cache/local
          // won the conflict and the history kept orbit-media:// — a scheme
          // React Native does not resolve — forever. Messages that only
          // exist locally stay in the map (the base is the current one).
          const byId = new Map(current.map((message) => [message.id, message]))
          for (const message of msgs) byId.set(message.id, message)
          const merged = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt)

          // Status reconciliation after reconnection: if the last assistant message
          // already has tokens/error (end of the stream) and the status stayed
          // stuck in streaming/submitted (status: idle event lost during
          // the connection gap), it releases the UI.
          const status = state.status
          const lastAssistant = [...merged].reverse().find((m) => m.role === 'assistant')
          const finished =
            lastAssistant !== undefined &&
            (lastAssistant.tokens !== undefined || lastAssistant.error !== undefined)
          const stuck = status[sessionId] === 'streaming' || status[sessionId] === 'submitted'
          return {
            messages: { ...state.messages, [sessionId]: merged },
            ...(finished && stuck ? { status: { ...status, [sessionId]: 'idle' as ChatStatus } } : {}),
          }
        })
        void cacheMessages(sessionId, get().messages[sessionId] ?? msgs)
      }
    } catch {
      // The cache has already been displayed by selectSession.
    }
  },

  loadOlderMessages: async (sessionId) => {
    const current = get().messages[sessionId] ?? []
    if (current.length === 0) return
    const { wsClient } = useConnectionStore.getState()
    try {
      const res = await wsClient.send({
        type: 'messages:get',
        sessionId,
        limit: INITIAL_MESSAGES_LIMIT,
        offset: current.length,
      })
      if (res.ok && Array.isArray(res.data)) {
        const older = res.data as ChatMessage[]
        if (older.length === 0) return
        set((state) => {
          const existing = state.messages[sessionId] ?? []
          const ids = new Set(existing.map((message) => message.id))
          const merged = [...older.filter((message) => !ids.has(message.id)), ...existing]
          return { messages: { ...state.messages, [sessionId]: merged } }
        })
        void cacheMessages(sessionId, get().messages[sessionId] ?? current)
      }
    } catch {
      // Pagination is opportunistic; it keeps the messages already visible.
    }
  },

  sendMessage: async (text, config) => {
    const sessionId = config?.sessionId ?? get().activeSessionId
    if (!sessionId) return

    const { wsClient, connection } = useConnectionStore.getState()
    const isOnline = connection.status === 'connected'

    if (!isOnline) {
      // Offline: queues it to send when reconnecting
      const session = get().sessions.find((s) => s.id === sessionId)
      const mode = session?.mode ?? 'chat'
      useMessageQueueStore.getState().enqueueForSend(sessionId, text, config?.options ?? {}, mode, {
        directory: config?.directory,
        extraDirectories: config?.extraDirectories,
        files: config?.files,
      })
      // Shows a friendly error status
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

    // Model: explicit in the config, otherwise the one of the SESSION (per-chat override >
    // draft > last chat > global default of the desktop) — same pattern as the
    // desktop, where the model follows the session, not the whole app.
    const settings = useSettingsStore.getState()
    const selected = sessionModelFor(sessionId) ?? settings.selectedModel
    const usesWorkers = config?.options?.subagents || config?.options?.orchestrate
    const workerModel = usesWorkers && settings.workerModel
      ? { ...settings.workerModel, reasoning: settings.workerReasoning ?? undefined }
      : undefined
    // Vision mode: sends the configured vision model when active for THIS
    // session (per-chat toggle with a default in the preferences). The desktop engine
    // uses it to describe images (preprocess) — same path as the
    // desktop, where the visionModel arrives via SendMessageInput.
    const session = get().sessions.find((s) => s.id === sessionId)
    const sessionMode = session?.mode ?? 'chat'
    const visionPrefs =
      sessionMode === 'code'
        ? useModelModePrefs.getState().codeActiveModes
        : useModelModePrefs.getState().chatActiveModes
    const visionModel = settings.visionModel && modeActiveFor('vision', sessionId, visionPrefs.vision)
      ? { ...settings.visionModel }
      : undefined
    // Only maxIterations travels: it is what the engine reads (autoReview is a local
    // adjustment of the modal). Before, the whole object went with `as any` — and the desktop
    // discarded it, because the field did not even exist in the protocol.
    const loopConfig = config?.options?.loop
      ? { maxIterations: settings.loopConfig.maxIterations }
      : undefined
    try {
      const res = await wsClient.send({
        type: 'messages:send',
        sessionId,
        text,
        providerId: config?.providerId ?? selected?.providerId,
        modelId: config?.modelId ?? selected?.modelId,
        options: config?.options,
        files: config?.files,
        workerModel,
        visionModel,
        loopConfig,
        directory: config?.directory,
        extraDirectories: config?.extraDirectories,
      })
      if (res.ok) return
      if (res.error === SESSION_BUSY_ERROR) {
        // The desktop is still in the previous turn (the status here was stale:
        // idle between loop iterations, reconnection...). Sending now would abort
        // that turn halfway — the message goes to the FRONT of the shared
        // queue, and the desktop sends it when the session becomes free.
        useMessageQueueStore.getState().enqueueFront(sessionId, {
          id: newQueueId(),
          text,
          files: config?.files?.length ? config.files : undefined,
          options: config?.options ?? {},
          mode: sessionMode,
          sessionId,
          directory: config?.directory,
          extraDirectories: config?.extraDirectories,
          createdAt: Date.now(),
        })
        set((state) => ({ status: { ...state.status, [sessionId]: 'streaming' as ChatStatus } }))
        return
      }
      failSend(res.error ?? i18n.t('sessionStore.sendFailed'))
    } catch (err) {
      failSend(String(err))
    }

    /** The desktop did not receive (or refused) the message: instead of vanishing, the
     *  text and the attachments go back to the input of this conversation to be resent. */
    function failSend(error: string) {
      set((state) => ({
        status: { ...state.status, [sessionId!]: 'error' },
        errors: { ...state.errors, [sessionId!]: error },
      }))
      useDraftInput.getState().setDraft(sessionId, text, config?.files)
    }
  },

  createSession: async (mode, title) => {
    const { wsClient, connection } = useConnectionStore.getState()
    // Without a connection there is nowhere to create it: it fails right away (whoever
    // called gives the text back to the input) instead of waiting for the socket to return.
    if (connection.status !== 'connected') return null
    try {
      const res = await wsClient.send({ type: 'sessions:create', mode, title })
      if (res.ok && res.data) {
        const session = res.data as SessionInfo
        set((state) => {
          // The desktop also broadcasts a `session` event with the same id — avoids
          // inserting a 2nd copy (which caused "two children with the same key").
          const exists = state.sessions.some((s) => s.id === session.id)
          return {
            sessions: exists ? state.sessions : [session, ...state.sessions],
            messages:
              state.messages[session.id] === undefined
                ? { ...state.messages, [session.id]: [] }
                : state.messages,
          }
        })
        // The draft (new chat) now applies to this session: overrides of the
        // active modes (research/browser/plan/subagents/orchestra/vision),
        // simple and brain.
        useModeOverrides.getState().adopt(session.id)
        useSimplePrefs.getState().adopt(session.id)
        useBrainPrefs.getState().adopt(session.id)
        // The model chosen in the new chat (draft) becomes the one of the session;
        // without an explicit choice, it fixes the model actually used (inherited from the
        // last chat) so the picker and the send stay consistent.
        useSessionModelPrefs.getState().adopt(session.id, sessionModelFor(undefined) ?? undefined)
        // Same for the rotation chosen in the new chat — without this it would stay
        // stuck in the draft and the first turn of the session would run without a rotation.
        useModelRotationStore.getState().adoptRotation(session.id)
        // Thinking and autonomy of the new chat also become the ones of the session:
        // without a choice in the draft, it fixes the level in force (the one of the model / the
        // default), so the chat does not change when the default is touched later.
        const sessionModel = sessionModelFor(undefined)
        useSessionReasoning.getState().adopt(
          session.id,
          sessionReasoningFor(undefined, sessionModel?.providerId, sessionModel?.modelId),
        )
        usePermissionPrefs.getState().adopt(session.id)
        return session
      }
    } catch {
      // the server may be an older version without sessions:create
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
    // Optimistic: when the generation has already finished on the desktop, chat:abort is a no-op and
    // no status comes back — without this the status would stay stuck in streaming/
    // submitted and the stop button would seem not to work.
    set((state) => ({ status: { ...state.status, [sessionId]: 'idle' as ChatStatus } }))
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
        const _localPlanReviews = { ...(state._localPlanReviews ?? {}) }
        delete _localPlanReviews[sessionId]
        const unreadCounts = { ...state.unreadCounts }
        delete unreadCounts[sessionId]
        // Clears pendingAsks from memory and from the cache
        const pendingAsks = { ...useChatStore.getState().pendingAsks }
        delete pendingAsks[sessionId]
        useChatStore.setState({ pendingAsks, activeAskSessionId: useChatStore.getState().activeAskSessionId === sessionId ? null : useChatStore.getState().activeAskSessionId })
        return { sessions, activeSessionId, planReviews, orchestration, _planReviewOutbox, _localPlanReviews, unreadCounts }
      })
      // Thinking and autonomy of the chat go along — no orphan override.
      useSessionReasoning.getState().clear(sessionId)
      usePermissionPrefs.getState().clear(sessionId)
      // Cache file cleanup
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

  setFolderArchived: async (folderId, archived) => {
    const { wsClient } = useConnectionStore.getState()
    const res = await wsClient.send({ type: 'folders:archive', folderId, archived })
    if (res.ok && Array.isArray(res.data)) {
      // The chats of the folder arrive through the 'session' events of the broadcast, but the
      // cascade is applied here as well so the list does not blink in between.
      set((state) => ({
        folders: res.data as FolderInfo[],
        sessions: state.sessions.map((s) => (s.folderId === folderId ? { ...s, archived } : s)),
      }))
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

  organizeSidebar: async () => {
    const { wsClient } = useConnectionStore.getState()
    // The desktop reorganizes and emits the resulting session/folder events —
    // there is no state to apply here.
    const res = await wsClient.send({ type: 'sidebar:organize' })
    return res.ok
  },

  acceptPlanReview: async (sessionId, permissionMode, orchestrate) => {
    const review = get().planReviews[sessionId]
    if (!review || review.status !== 'proposed') return
    const updated: PlanReview = { ...review, status: 'implementing', permissionMode }
    set((state) => ({ planReviews: { ...state.planReviews, [sessionId]: updated } }))

    // Same resolution as sendMessage: per-chat override > global default. Without
    // it the implementation runs on the global model, and with an empty selectedModel the
    // desktop falls back to openai/gpt-4o — a provider that may not even exist.
    const settings = useSettingsStore.getState()
    const model = sessionModelFor(sessionId) ?? settings.selectedModel
    const { wsClient } = useConnectionStore.getState()
    try {
      await wsClient.send({
        type: 'plan:review-accept',
        sessionId,
        messageId: review.messageId,
        permissionMode,
        providerId: model?.providerId,
        modelId: model?.modelId,
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
    const model = sessionModelFor(sessionId) ?? settings.selectedModel
    const { wsClient } = useConnectionStore.getState()
    try {
      await wsClient.send({
        type: 'plan:review-revise',
        sessionId,
        messageId: review.messageId,
        feedback,
        permissionMode: review.permissionMode ?? 'ask',
        providerId: model?.providerId,
        modelId: model?.modelId,
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
        // The reverted message goes back to the input, as if it were being
        // edited. The text comes out of `discardedMessages` instead of arriving in a field
        // of its own in SessionRevert: attachments are data URLs and duplicating them would double
        // the size of the session on disk.
        const prompt = revert?.discardedMessages?.find((m) => m.role === 'user')
        if (prompt) {
          const files = prompt.parts.filter((p): p is FilePart => p.type === 'file')
          // The quote comes back as an ARMED reply (bar in the composer), and not
          // as `> [assistant] …` inside the text field — see the desktop.
          const { reply, body } = parseMessageReply(visibleMessageText(prompt))
          if (reply) useReply.getState().setReply(sessionId, reply)
          useDraftInput.getState().setDraft(sessionId, body, files)
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
        const { messages, result } = res.data as MessagesResponse
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId ? { ...s, revert: undefined } : s,
          ),
          messages: { ...state.messages, [sessionId]: messages },
        }))
        // What did not come back (changed between the revert and now) cannot pass in
        // silence on the phone.
        const kept =
          (result?.files?.conflicts.length ?? 0) + (result?.media?.conflicts ?? 0)
        if (result?.files?.error) {
          Alert.alert(i18n.t('revertBar.undo'), i18n.t('revertBar.unrevertFilesError'))
        } else if (kept > 0) {
          Alert.alert(i18n.t('revertBar.undo'), i18n.t('revertBar.unrevertKept', { count: kept }))
        }
      }
    } catch {
      // Silently fail
    }
  },

  revertUncertain: async (sessionId) => {
    const { wsClient } = useConnectionStore.getState()
    try {
      const res = await wsClient.send({ type: 'sessions:revertUncertain', sessionId })
      if (res.ok && res.data) {
        const { revert } = res.data as { revert: SessionInfo['revert'] }
        set((state) => ({
          sessions: state.sessions.map((s) => (s.id === sessionId ? { ...s, revert } : s)),
        }))
      }
    } catch {
      // Silently fail
    }
  },

  applyChatEvent: (event) => {
    const sessionId = 'sessionId' in event ? event.sessionId : ''

    // Events that touch the messages directly need to see the text already
    // accumulated — it flushes the pending deltas before applying them.
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
          // Creates a PlanReview at the end of the streaming if it was in plan mode
          if (event.status === 'idle' && state._planReviewOutbox?.[sessionId] && !state.planReviews[sessionId]) {
            const msgs = state.messages[sessionId] ?? []
            const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant')
            if (lastAssistant) {
              patch.planReviews = { ...state.planReviews, [sessionId]: { status: 'proposed', messageId: lastAssistant.id } }
              patch._localPlanReviews = { ...state._localPlanReviews, [sessionId]: true }
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

          // Cache after receiving a complete message
          void cacheMessages(sessionId, next)

          // Status reconciliation: an assistant message with `tokens`
          // (only defined at the 'finish' of the stream) or with an error means that the
          // generation finished. If the `status: idle` event gets lost, this
          // releases the input/stop and clears the "Thinking".
          const m = event.message
          const finished =
            m.role === 'assistant' && (m.tokens !== undefined || m.error !== undefined)
          // With an error, the state is `error`, not `idle`.
          const status = finished
            ? { ...state.status, [sessionId]: (m.error !== undefined ? 'error' : 'idle') as ChatStatus }
            : state.status

          // Increments the unread counter if the session is not active.
          // Empty placeholder emitted by the engine before the stream (and re-emitted
          // when switching attachments after preprocess) does not count — the first part or the
          // final message count.
          const isInbound = m.role === 'assistant'
          const placeholder =
            isInbound && m.parts.length === 0 && m.tokens === undefined && m.error === undefined
          const activeId = state.activeSessionId
          const unreadCounts =
            isInbound && !placeholder && sessionId !== activeId
              ? { ...state.unreadCounts, [sessionId]: (state.unreadCounts[sessionId] ?? 0) + 1 }
              : state.unreadCounts

          return { messages: { ...state.messages, [sessionId]: next }, status, unreadCounts }
        })
        // A model only enters the "recents" when it was really used: the final
        // answer of the agent (completedAt) arrived complete, with real
        // content and without an error — same criterion as the desktop. markUsed is
        // idempotent (dedup in the recents).
        const done = event.message
        if (
          done.role === 'assistant' &&
          done.completedAt &&
          !done.error &&
          done.parts.some(
            (p) => p.type === 'text' || p.type === 'tool' || p.type === 'image' || p.type === 'agent',
          )
        ) {
          useSessionModelPrefs.getState().markUsed(done.providerId, done.modelId)
        }
        break

      case 'part':
        // The event brings the COMPLETE state of the part (the desktop keeps the text
        // accumulated), so any delta still in the buffer is already contained in
        // it — applying both would duplicate the stretch. Discarding the buffer here
        // is also what allows the engine to correct a text already transmitted
        // (e.g. the sanitizing of the internal markers at 'text-end').
        deltaBuffer.delete(`${sessionId}:${event.messageId}:${event.part.id}`)
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
        // Complete replacement (compaction, etc.)
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
        set((state) => {
          const _localPlanReviews = { ...state._localPlanReviews }
          delete _localPlanReviews[sessionId]
          return {
            planReviews: { ...state.planReviews, [sessionId]: event.review },
            _localPlanReviews,
          }
        })
        break

      case 'session':
        // Session created/updated by the desktop (orchestration workers)
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
        // The thinking and the autonomy it held go away with the chat as well.
        useSessionReasoning.getState().clear(event.sessionId)
        usePermissionPrefs.getState().clear(event.sessionId)
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

      // ─── Permissions ─────────────────────────────────────────────

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
        // event.items is already AskItem[] — the batchId groups the batch (single card).
        for (const item of event.items ?? []) {
          addPendingAsk(sessionId, { ...item, batchId: event.batchId })
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

