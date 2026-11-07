import i18n from "@/src/i18n"
import { nanoid } from "nanoid"
import { create } from "zustand"
import type {
  AskItem,
  ChatEvent,
  ChatMessage,
  ChatStatus,
  FilePart,
  FolderInfo,
  OrchestrationPlan,
  PlanReview,
  RotationFallbackInfo,
  SendMessageOptions,
  SessionInfo,
  SessionMediaRevert,
  SessionMode,
  ProfileId,
  TextPart,
} from "@shared/chat"
// normalizeFolderName/folderKey live in shared: mobile groups chats by
// project the same way and needs the SAME name rule.
import { folderKey, normalizeFolderName, normalizeOrchestrationPlan, parseMessageReply, StorageKeys } from "@shared/chat"
import { planArchivedCleanup, setArchivedState } from "@shared/archive"
import { planAutoFolder } from "@/src/lib/auto-folder"
import { firstSessionOfFolder, workspaceOfFolder } from "@/src/lib/folder-workspace"
import {
  relocateAutoFolderEntry,
  relocateFolderWorkspace,
  relocateSessionFolders,
  relocatedFolderName,
} from "@/src/lib/relocate"
import { chatApi, companionApi, docsApi, mediaApi, sessionApi, storage } from "@/src/lib/ipc"
import { MEDIA_SCHEME } from "@shared/media"
import { visibleMessageText } from "@/src/lib/message-utils"
import { useBrainPrefs } from "@/src/stores/brain-prefs"
import { useSimplePrefs } from "@/src/stores/simple-prefs"
import { modeActiveFor, useModeOverrides } from "@/src/stores/mode-overrides"
import { useSessionTools } from "@/src/stores/session-tools"
import { useDraftInput } from "@/src/stores/draft-input"
import { useMessageReply } from "@/src/stores/message-reply"
import { useMessageQueueStore } from "@/src/stores/message-queue-store"
import { useModelModePrefs } from "@/src/stores/model-mode-prefs"
import { useProviderStore } from "@/src/stores/provider-store"
import { sessionModelFor, useSessionModelPrefs } from "@/src/stores/session-model-prefs"
import { inheritSessionConfig } from "@/src/stores/inherit-session-config"
import { useSessionReasoning } from "@/src/stores/session-reasoning"
import { permissionFor, usePermissionPrefs } from "@/src/stores/permission-prefs"
import { useLoopConfigStore } from "@/src/stores/loop-config-store"
import { LOCALE_PROMPT_NAME, useLocaleStore } from "@/src/stores/locale-store"
import { useModelRotationStore } from "@/src/stores/model-rotation-store"
import { usePanelStore } from "@/src/stores/panel-store"
import { useAppSettings } from "@/src/stores/app-settings"
import { knownMain } from "@/src/stores/worktree-store"

/**
 * Session/message store in the opencode pattern: sessions persisted
 * locally (via the main process storage), messages made of parts and
 * per-session streaming status driving the UI (persona in "thinking" etc).
 */

/** Pending request (permission or question) shown as a card above the input.
 * batchId groups worker requests emitted in a batch (single card, single submit). */
export type PendingAskUI = AskItem & { batchId?: string }

export interface SendConfig {
  options: SendMessageOptions
  directory?: string
  extraDirectories?: string[]
  /** Sends to a specific session (e.g.: worker in the right panel) instead of the active one */
  sessionId?: string
  /** Files attached to the message (data URLs) */
  files?: FilePart[]
  /** Id of the answer that failed: the turn is REDONE over the same user
   *  message, instead of sending a new one (see SendMessageInput.retryOf). */
  retryOf?: string
}

/** Size of the context of the turn in progress (see `liveContext`). */
export interface LiveContext {
  input: number
  output: number
  /** Measured in the request before sending, not reported by the provider. */
  estimated: boolean
  /** From the last call's input: how much came from the cache and how much was written into it. */
  cacheRead?: number
  cacheWrite?: number
}

/** Offer to continue in a new chat, emitted by the engine at the end of the turn. */
export interface CompactionSuggestion {
  /** Summaries in the history at the moment of the offer (= compactions made). */
  summaries: number
  /** Dismissed for THIS count; a new compaction frees it again. */
  dismissed: boolean
}

/** Transient unrevert notice: what stayed intact for having changed afterwards. */
export interface RevertNotice {
  sessionId: string
  files: string[]
  /** The files could not be given back at all. */
  filesError?: 'no-after' | 'failed'
  media?: SessionMediaRevert
}

interface SessionState {
  initialized: boolean
  sessions: SessionInfo[]
  folders: FolderInfo[]
  messages: Record<string, ChatMessage[]>
  status: Record<string, ChatStatus>
  errors: Record<string, string | undefined>
  /** Fallback in progress (model rotation): current/total attempt per
   *  session — the UI shows "trying fallback X/Y" instead of "Thinking…" */
  fallback: Record<string, RotationFallbackInfo | undefined>
  /** Live context of the turn in progress (`context` event): the meter
   *  prefers it over the last answer's `tokens`, which only arrives at the end. It stays after a
   *  failure — it is the size of what the provider refused — and leaves when an answer
   *  ends with `tokens` (then the persisted number is already the same) or the history
   *  is replaced (compaction). Memory only: does not survive a restart. */
  liveContext: Record<string, LiveContext | undefined>
  /** Next message suggested per session (Settings → Prompt suggestions).
   *  It disappears when the person sends anything — it only counts for the last answer. */
  suggestions: Record<string, string | undefined>
  clearSuggestion: (sessionId: string) => void
  activeIds: Record<SessionMode, string | null>
  /** Folder to assign to the next session created by the new chat flow.
   *  The folder's "+" does not create a session on click — only on sending the 1st message. */
  pendingFolderId: string | null
  /** Specialist agent chosen for the next new chat (null = the general agent). Applied when the
   *  session is created by the first message, then cleared. */
  pendingProfile: ProfileId | null
  /** Count of unread messages per session. */
  unreadCounts: Record<string, number>
  /** Orchestration plans per orchestrator session */
  orchestration: Record<string, OrchestrationPlan>
  /** Plan review (plan mode): proposed or in implementation */
  planReviews: Record<string, PlanReview>
  /** Sessions that sent a message in plan mode and await the end of the streaming to create the review */
  _planReviewOutbox: Record<string, true>
  /** Permission/question requests awaiting an answer, per session */
  pendingAsks: Record<string, PendingAskUI[]>
  /** Offer to continue in a new chat (context near the limit), per session.
   *  `dismissed` counts for THIS summary count: a new compaction
   *  (which changes the count) frees the card again. */
  compactionSuggestion: Record<string, CompactionSuggestion>

  initialize: () => Promise<void>
  ensureMessages: (sessionId: string) => Promise<void>
  approvePlan: (sessionId: string, planId: string, taskIds?: string[]) => void
  /** "Continue" on the card of an interrupted plan: runs the tasks it did not accept. */
  resumeOrchestration: (sessionId: string) => Promise<void>
  rejectPlan: (sessionId: string) => void
  acceptPlanReview: (sessionId: string, permissionMode: "ask" | "approve" | "full", orchestrate?: boolean) => void
  rejectPlanReview: (sessionId: string) => void
  reviewPlanReview: (sessionId: string, feedback: string) => void
  dismissPlanReview: (sessionId: string) => void
  dismissOrchestration: (sessionId: string) => void
  /** Closes the offer to continue in a new chat (does not come back until the next
   *  compaction, which changes the summary count). */
  dismissCompactionSuggestion: (sessionId: string) => void
  /** Creates the NEW chat of the full context offer: same folder/mode/model as the
   *  parent, WITHOUT `parentId` (it is a top-level chat, not a subchat) and with the agent's
   *  brief as an opening summary. */
  createContinuationSession: (
    parentId: string,
    title: string,
    summaryText: string,
  ) => Promise<SessionInfo | null>
  createSession: (mode: SessionMode, partial?: Partial<SessionInfo> & { setActive?: boolean }) => Promise<SessionInfo>
  selectSession: (mode: SessionMode, id: string | null) => Promise<void>
  setPendingFolder: (folderId: string | null) => void
  setPendingProfile: (profile: ProfileId | null) => void
  renameSession: (id: string, title: string) => void
  togglePin: (id: string) => void
  toggleArchive: (id: string) => void
  deleteSession: (id: string) => Promise<void>
  deleteSessions: (ids: string[]) => Promise<void>
  moveToFolder: (id: string, folderId: string | null) => void
  /** Puts the session in a sidebar place at once (drag and drop): folder,
   *  pinned and archived change together, in a single synchronization event. */
  placeSession: (id: string, place: { folderId?: string | null; pinned?: boolean; archived?: boolean }) => void
  /** Updates the working folders of a code session */
  setSessionDirectories: (id: string, directory: string | undefined, extraDirectories?: string[]) => void
  /** Duplicates the session (up to messageId, if given) with new IDs */
  forkSession: (id: string, messageId?: string) => Promise<SessionInfo | null>
  /** Restores the filesystem to before the message (code mode) */
  revertToMessage: (sessionId: string, messageId: string) => Promise<void>
  /** Undoes an active revert */
  unrevert: (sessionId: string) => Promise<void>
  /** Also reverts the files of uncertain authorship of the active revert */
  revertUncertain: (sessionId: string) => Promise<void>
  /** Result of the last unrevert (preserved conflicts); memory only. */
  revertNotice: RevertNotice | null
  dismissRevertNotice: () => void

  createFolder: (mode: SessionMode, name: string, workspace?: string[]) => FolderInfo
  renameFolder: (id: string, name: string) => void
  toggleFolderPin: (id: string) => void
  /** Archives/unarchives the folder and, along with it, every chat that is in it */
  toggleFolderArchive: (id: string) => void
  /** Brings the folder back to the sidebar WITHOUT unarchiving the old chats — it is what
   *  the automatic folder does when one goes back to working on an archived
   *  project. The previous chats stay in "Archived", grouped by the
   *  live folder, which is a state the sidebar already knows how to show. */
  reviveFolder: (id: string) => void
  deleteFolder: (id: string) => void
  /** Reorganizes the sidebar: merges duplicate folders of the same project and moves the
   *  loose chats (code mode, with a directory) into the project's folder —
   *  fixes duplicate folders when the automatic map was lost. */
  organizeSidebar: () => void
  /** Working folders the new chat from a folder's "+" should be born with:
   *  those of its most recent chat or, with the folder empty, those of the project the
   *  automatic map still points to. `undefined` = folder with no known project
   *  (folder created by hand and never used), and then the workspace stays as it is. */
  folderWorkspace: (folderId: string) => string[] | undefined

  /** The folder moved on disk: it re-points everything that pointed to the
   *  old path. The workspace folders live in the WorkspaceProvider, so
   *  whoever updates them is whoever calls. */
  relocateFolder: (oldPath: string, newPath: string) => void
  /** Gives up on a folder that no longer exists: the sessions that used it are left
   *  without a working folder and the automatic map's clue dies along. */
  forgetFolder: (path: string) => void

  sendMessage: (mode: SessionMode, text: string, config: SendConfig) => Promise<void>
  stopStreaming: (sessionId: string) => void
}

const AUTO_FOLDER_MAP_KEY = "orbit-auto-folder-map"

function loadAutoFolderMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(AUTO_FOLDER_MAP_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function persistAutoFolderMap(map: Record<string, string>) {
  localStorage.setItem(AUTO_FOLDER_MAP_KEY, JSON.stringify(map))
}

/** Sessions whose messages have already been loaded from storage (or created
 *  locally). Independent of the `messages[]` buffer: the event handlers
 *  (message/part) may create the buffer before the load — e.g.: reload with the
 *  agent running — and that cannot prevent loading the persisted
 *  history (the "loaded" signal cannot be the key being defined). */
const loadedMessages = new Set<string>()

/**
 * How many conversations keep the history in memory. Without a cap, every conversation
 * opened since boot stayed whole in the renderer — with the tool outputs,
 * file reads and attachments — and the RAM only grew. Main is the one that writes the
 * history (chat-engine), so the renderer is only a mirror: dropping an
 * idle conversation loses nothing, and reopening it re-reads from disk (`ensureMessages`).
 */
const MAX_CACHED_SESSIONS = 6

/** Conversations in the order they were displayed (the most recent at the end). */
const recentSessions: string[] = []

/** Marks the conversation as seen and returns the ones that went over the cap. */
function touchRecent(sessionId: string): string[] {
  const at = recentSessions.indexOf(sessionId)
  if (at >= 0) recentSessions.splice(at, 1)
  recentSessions.push(sessionId)
  return recentSessions.length > MAX_CACHED_SESSIONS
    ? recentSessions.slice(0, recentSessions.length - MAX_CACHED_SESSIONS)
    : []
}

/** Merges the persisted history with the event buffer (the buffer is fresher
 *  per part — post-reload events — but may not have the parts emitted
 *  before the reload; the disk fills the gaps). */
function mergeMessages(persisted: ChatMessage[], buffered: ChatMessage[] | undefined): ChatMessage[] {
  if (!buffered || buffered.length === 0) return persisted
  const byId = new Map(persisted.map((m) => [m.id, m]))
  for (const m of buffered) {
    const existing = byId.get(m.id)
    if (!existing) {
      byId.set(m.id, m)
      continue
    }
    const parts = new Map(existing.parts.map((p) => [p.id, p]))
    for (const p of m.parts) parts.set(p.id, p)
    byId.set(m.id, { ...existing, ...m, parts: [...parts.values()] })
  }
  return [...byId.values()]
}

function persistSession(session: SessionInfo) {
  void storage.write(StorageKeys.session(session.id), session)
}

function persistFolders(folders: FolderInfo[]) {
  void storage.write(StorageKeys.folders, folders)
}

const ARCHIVED_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * Automatic deletion of archived conversations (Settings → General).
 *
 * It runs here, and not in main like the automatic archiving, because the deletion
 * cascade (abort, messages, prefs, panel browser, attached sources)
 * lives in `deleteSessions` — duplicating it in main would give two truths about the
 * same delete. References that survive the conversation are safe: the memory
 * keeps the origin sessionId only for the "open conversation" link, which disappears
 * when the session does not exist; orphan routine metrics are pruned.
 */
async function runArchivedCleanup(get: () => SessionState, set: (fn: (state: SessionState) => Partial<SessionState>) => void) {
  const days = useAppSettings.getState().settings.deleteArchivedDays
  if (!days) return
  const now = Date.now()
  const running = new Set(await chatApi.running().catch(() => [] as string[]))
  const { expired, undated } = planArchivedCleanup(get().sessions, days, now, running)

  if (undated.length > 0) {
    // Archived before archivedAt existed: the clock starts now. updatedAt
    // stays as it was — dating is not activity.
    const ids = new Set(undated.map((s) => s.id))
    set((state) => ({
      sessions: state.sessions.map((s) => {
        if (!ids.has(s.id)) return s
        const next = { ...s, archivedAt: now }
        persistSession(next)
        return next
      }),
    }))
  }
  if (expired.length > 0) {
    await get().deleteSessions(expired.map((s) => s.id))
    console.log(`[archived-cleanup] ${expired.length} archived conversation(s) deleted`)
  }
}

function setupArchivedCleanup(get: () => SessionState, set: (fn: (state: SessionState) => Partial<SessionState>) => void) {
  const run = () => void runArchivedCleanup(get, set).catch((err) => console.error("[archived-cleanup] failed:", err))
  setInterval(run, ARCHIVED_CLEANUP_INTERVAL_MS)
  // Turning the option on (or shortening the period) counts right away, not only on the next run.
  useAppSettings.subscribe((next, prev) => {
    const days = next.settings.deleteArchivedDays
    if (days && days !== prev.settings.deleteArchivedDays) run()
  })
  run()
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

/** Emits a ChatEvent to main → other windows + companions (mobile).
 *  The local store has already applied the change; the event is only synchronization. */
function emitChatEvent(event: ChatEvent) {
  chatApi.emit(event)
}

/** "session" event with the store's updated object (post-set). */
function emitSessionEvent(id: string) {
  const session = useSessionStore.getState().sessions.find((s) => s.id === id)
  if (session) emitChatEvent({ type: "session", sessionId: id, session })
}

export const useSessionStore = create<SessionState>((set, get) => ({
  initialized: false,
  sessions: [],
  folders: [],
  messages: {},
  status: {},
  errors: {},
  fallback: {},
  liveContext: {},
  suggestions: {},
  revertNotice: null,
  dismissRevertNotice: () => set({ revertNotice: null }),
  clearSuggestion: (sessionId) =>
    set((state) => (state.suggestions[sessionId] ? { suggestions: { ...state.suggestions, [sessionId]: undefined } } : state)),
  activeIds: { chat: null, code: null },
  pendingFolderId: null,
  pendingProfile: null,
  orchestration: {},
  planReviews: {},
  _planReviewOutbox: {},
  pendingAsks: {},
  compactionSuggestion: {},
  unreadCounts: {},

  initialize: async () => {
    if (get().initialized) return
    set({ initialized: true })

    const keys = await storage.list(StorageKeys.sessionPrefix)
    const sessions = (
      await Promise.all(keys.map((key) => storage.read<SessionInfo>(key)))
    ).filter((s): s is SessionInfo => s !== null)
    sessions.sort((a, b) => b.updatedAt - a.updatedAt)

    const folders = (await storage.read<FolderInfo[]>(StorageKeys.folders)) ?? []
    // Merge instead of replacement: a session/folder created while the load
    // was in progress (e.g.: opening via "Open with Orbit" at mount)
    // cannot be lost by the set below.
    set((state) => {
      const byId = new Map(state.sessions.map((s) => [s.id, s]))
      for (const s of sessions) byId.set(s.id, s)
      const mergedSessions = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt)
      const folderById = new Map(state.folders.map((f) => [f.id, f]))
      for (const f of folders) folderById.set(f.id, f)
      return { sessions: mergedSessions, folders: [...folderById.values()] }
    })

    // Folders from before the workspace memory (or whose first chat has already been
    // deleted) get theirs on this first load: from the OLDEST chat that
    // is left and, with none, from the automatic map — which still knows which project
    // the folder belongs to. It is what makes the "+" of an empty folder open correctly.
    const folderMap = loadAutoFolderMap()
    for (const folder of get().folders) {
      if (folder.mode !== "code" || folder.workspace?.length) continue
      const fromMap = Object.entries(folderMap).find(([, id]) => id === folder.id)?.[0]
      learnFolderWorkspace(
        folder.id,
        workspaceOfSession(firstSessionOfFolder(folder.id, get().sessions)) ?? (fromMap ? [fromMap] : undefined),
      )
    }

    chatApi.onEvent((event) => applyChatEvent(event, set, get))
    setupArchivedCleanup(get, set)

    // "Organize" coming from mobile: runs the same function as the desktop sidebar.
    companionApi.onOrganizeSidebar(() => get().organizeSidebar())

    // After a renderer reload, main knows which sessions are still running
    // (the engine lives in the main process) — it re-emits the status so the UI goes back to
    // showing the spinner and the stop button without waiting for the next turn event.
    // `if (!status[id])` preserves a status that arrived in the meantime (e.g.: idle
    // from the end of the turn between the invoke and the set).
    void chatApi.running().then((running) => {
      if (running.length === 0) return
      set((state) => {
        const status = { ...state.status }
        for (const id of running) {
          if (status[id] === undefined) status[id] = "streaming" as ChatStatus
        }
        return { status }
      })
    })
  },

  createSession: async (mode, partial) => {
    const now = Date.now()
    const { setActive = true, ...rest } = partial ?? {}
    const session: SessionInfo = {
      id: nanoid(),
      title: mode === "chat" ? i18n.t("chat.newChatTitle") : i18n.t("chat.newCodeSessionTitle"),
      mode,
      pinned: false,
      archived: false,
      folderId: null,
      createdAt: now,
      updatedAt: now,
      ...rest,
    }

    // A chat in a worktree goes into the main repository's sidebar folder:
    // it is the same project, only in another working copy.
    const directory = partial?.directory ? knownMain(partial.directory) : undefined
    if (mode === "code" && directory && useModelModePrefs.getState().autoCreateFolders) {
      const autoFolderMap = loadAutoFolderMap()
      const plano = planAutoFolder({
        directory,
        mode,
        folders: get().folders,
        mappedId: autoFolderMap[directory],
      })
      const folderId = plano.folderId ?? get().createFolder(mode, plano.create ?? normalizeFolderName(directory)).id

      // Going back to working on the project brings its folder back — only the folder.
      // The old chats stay archived, and the sidebar already shows them in
      // "Archived" grouped by the live folder. Without unarchiving, the new session
      // would enter an archived folder and vanish from the sidebar (the folder only lists the
      // chats in the SAME state as it): worse than being born loose.
      if (plano.revive) get().reviveFolder(folderId)

      if (autoFolderMap[directory] !== folderId) {
        autoFolderMap[directory] = folderId
        persistAutoFolderMap(autoFolderMap)
      }
      session.folderId = folderId
    }

    // The folder learns from THIS chat which workspace it belongs to. It is the memory
    // that survives when its chats are deleted: the "+" of an empty folder
    // goes back to the same repository instead of inheriting the screen's.
    learnFolderWorkspace(session.folderId, workspaceOfSession(session))

    await storage.write(StorageKeys.session(session.id), session)
    set((state) => ({
      sessions: [session, ...state.sessions],
      activeIds: setActive ? { ...state.activeIds, [mode]: session.id } : state.activeIds,
      messages: { ...state.messages, [session.id]: [] },
    }))
    loadedMessages.add(session.id)
    emitChatEvent({ type: "session", sessionId: session.id, session })
    return session
  },

  selectSession: async (mode, id) => {
    set((state) => ({
      activeIds: { ...state.activeIds, [mode]: id },
      unreadCounts: id ? { ...state.unreadCounts, [id]: 0 } : state.unreadCounts,
      // Navigating to another session or opening a new chat ends the pending folder intent
      pendingFolderId: null,
      pendingProfile: null,
    }))
    if (id) await get().ensureMessages(id)
  },

  setPendingFolder: (folderId) => set({ pendingFolderId: folderId }),
  setPendingProfile: (profile) => set({ pendingProfile: profile }),

  ensureMessages: async (sessionId) => {
    // History cap in memory: the conversations seen longest ago release
    // the messages — except the ones open in some mode, the ones with the agent running and
    // the ones with a plan to review (the end of the stream still reads the buffer).
    const stale = touchRecent(sessionId)
    if (stale.length > 0) {
      const state = get()
      const open = new Set(Object.values(state.activeIds).filter(Boolean))
      const drop: string[] = []
      for (const sid of stale) {
        const busy =
          open.has(sid) ||
          state.status[sid] === "streaming" ||
          state.status[sid] === "submitted" ||
          state._planReviewOutbox[sid] === true
        if (busy) continue
        recentSessions.splice(recentSessions.indexOf(sid), 1)
        if (state.messages[sid] !== undefined) drop.push(sid)
      }
      if (drop.length > 0) {
        for (const sid of drop) loadedMessages.delete(sid)
        set((current) => {
          const messages = { ...current.messages }
          for (const sid of drop) delete messages[sid]
          return { messages }
        })
      }
    }
    // Plan, review and pending requests load here, and not in selectSession:
    // chat-view calls ensureMessages whenever it displays a session (including
    // the one that was already active at boot, which never goes through selectSession). Tied
    // to selectSession, the plan card did not come back when reopening the app.
    // The four reads go out together: in sequence, the history (what the screen
    // waits for) only started being read after three round trips to main.
    const needsMessages = !loadedMessages.has(sessionId)
    const [plan, review, asks, persistedRaw] = await Promise.all([
      // Legacy plans (Portuguese keys/phase values) are translated at the read edge.
      get().orchestration[sessionId] === undefined
        ? storage.read<unknown>(StorageKeys.orchestration(sessionId)).then(normalizeOrchestrationPlan)
        : null,
      get().planReviews[sessionId] === undefined ? storage.read<PlanReview>(StorageKeys.planReview(sessionId)) : null,
      get().pendingAsks[sessionId] === undefined
        ? storage.read<PendingAskUI[]>(StorageKeys.pendingAsks(sessionId))
        : null,
      needsMessages ? storage.read<ChatMessage[]>(StorageKeys.messages(sessionId)) : null,
    ])
    // A dismissed one does not become a card again (the file stays: it is the
    // orchestrator's history), and a new plan overwrites it without the mark.
    // The undefined checks repeat because an event may have filled it while reading.
    if (plan && !plan.dismissed && get().orchestration[sessionId] === undefined) {
      set((state) => ({ orchestration: { ...state.orchestration, [sessionId]: plan } }))
    }
    if (review && get().planReviews[sessionId] === undefined) {
      set((state) => ({ planReviews: { ...state.planReviews, [sessionId]: review } }))
    }
    if (asks && get().pendingAsks[sessionId] === undefined) {
      set((state) => ({ pendingAsks: { ...state.pendingAsks, [sessionId]: asks } }))
    }
    if (!needsMessages || loadedMessages.has(sessionId)) return
    const persisted = persistedRaw ?? []
    set((state) => {
      // Events that arrived before the load (e.g.: reload with the agent running)
      // cannot prevent loading the history — merge with the disk instead
      // of skipping when the buffer already exists.
      const messages = mergeMessages(persisted, state.messages[sessionId])
      loadedMessages.add(sessionId)
      // Status reconciliation: if the last assistant message already has
      // tokens/error (end of the stream) and the status got stuck in
      // streaming/submitted (status: idle event lost during a reload),
      // it unlocks the UI.
      const status = state.status
      const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")
      const finished =
        lastAssistant !== undefined &&
        (lastAssistant.tokens !== undefined || lastAssistant.error !== undefined)
      const stuck = status[sessionId] === "streaming" || status[sessionId] === "submitted"
      return {
        messages: { ...state.messages, [sessionId]: messages },
        ...(finished && stuck ? { status: { ...status, [sessionId]: "idle" as ChatStatus } } : {}),
      }
    })
  },

  approvePlan: (sessionId, planId, taskIds) => {
    set((state) => {
      const plan = state.orchestration[sessionId]
      if (!plan || plan.id !== planId) return state
      return { orchestration: { ...state.orchestration, [sessionId]: { ...plan, status: "approved" } } }
    })
    void chatApi.approvePlan(sessionId, planId, taskIds)
  },

  /** Card of a plan that stopped halfway (the app was closed, or the run was cut):
   *  the main process runs the tasks that were not accepted, each in its own worker
   *  session. Nothing is set here optimistically — the plan and the status come back
   *  as events from main, and an early return there (nothing left to run) must not
   *  leave the screen saying "in progress". */
  resumeOrchestration: async (sessionId) => {
    const session = get().sessions.find((s) => s.id === sessionId)
    if (!session?.directory) return
    const provider = useProviderStore.getState()
    const selected = sessionModelFor(sessionId) ?? provider.selectedModel
    if (!selected) return
    const worker = provider.workerModel
    const conductor = provider.orchestratorModel
    await chatApi.resumePlan({
      sessionId,
      text: "",
      providerId: selected.providerId,
      modelId: selected.modelId,
      mode: "code",
      // The modes a resumed run inherits from the orchestrator's chat: the level of
      // autonomy follows the selector, exactly as a worker does (see runWorkerTurn).
      options: { permissionMode: permissionFor(sessionId), followGlobalPermission: true },
      directory: session.directory,
      extraDirectories: session.extraDirectories,
      workerModel: worker ? { ...worker, reasoning: provider.workerReasoning ?? undefined } : undefined,
      orchestratorModel: conductor
        ? { ...conductor, reasoning: provider.orchestratorReasoning ?? undefined }
        : undefined,
      visionModel: provider.visionModel ?? undefined,
      language: LOCALE_PROMPT_NAME[useLocaleStore.getState().activeLocale],
    })
  },

  rejectPlan: (sessionId) => {
    void chatApi.rejectPlan(sessionId)
  },

  /** Closes the finished plan's card — for good. The mark goes to the
   *  FILE (ensureMessages re-reads the plan when the session opens, so removing
   *  it from memory alone made the card come back on every reopen), but the plan
   *  is NOT deleted: tasks, prompts and accumulated usage are the orchestrator's
   *  history and context if the conversation goes on. A new plan overwrites it without the mark. */
  dismissOrchestration: (sessionId: string) => {
    set((state) => {
      const next = { ...state.orchestration }
      delete next[sessionId]
      return { orchestration: next }
    })
    // Read-mark-write: only the `dismissed` field changes, the rest of the plan
    // stays (and comes back in the current shape, legacy keys already translated).
    void (async () => {
      const plan = normalizeOrchestrationPlan(await storage.read<unknown>(StorageKeys.orchestration(sessionId)))
      if (!plan || plan.dismissed) return
      await storage.write(StorageKeys.orchestration(sessionId), { ...plan, dismissed: true })
    })()
  },

  dismissCompactionSuggestion: (sessionId) => {
    set((state) => {
      const current = state.compactionSuggestion[sessionId]
      if (!current || current.dismissed) return state
      return {
        compactionSuggestion: {
          ...state.compactionSuggestion,
          [sessionId]: { ...current, dismissed: true },
        },
      }
    })
  },

  createContinuationSession: async (parentId, title, summaryText) => {
    const parent = get().sessions.find((s) => s.id === parentId)
    if (!parent) return null
    const now = Date.now()
    const child: SessionInfo = {
      id: nanoid(),
      title,
      mode: parent.mode,
      pinned: false,
      archived: false,
      folderId: parent.folderId,
      // Same working folder: the new chat continues the SAME work, and without a
      // parent worktree, parent and child edit the same checkout (that is why the brief says the
      // scope of what is at stake).
      directory: parent.directory,
      extraDirectories: parent.extraDirectories,
      // WITHOUT parentId: the offer is born from the parent's full context and promises a
      // NEW chat. Attached, it showed up indented as a subchat and still vanished
      // along with the parent on archiving/deleting (cascade).
      createdAt: now,
      updatedAt: now,
    }
    // The brief is the AGENT's, not the user's: it comes in as a system summary
    // message (summary: true), which is the format the model already reads as
    // "summary of the conversation so far" and the UI shows as a collapsible card.
    const seed: ChatMessage = {
      id: nanoid(),
      role: "assistant",
      summary: true,
      // It is not a compaction of THIS conversation: it is the brief that opened the chat. The UI
      // labels it differently (SummaryCard) so it does not look like it already compacted.
      continuation: true,
      parts: [{ id: nanoid(), type: "text", text: summaryText, state: "done" }],
      createdAt: now,
    }
    await storage.write(StorageKeys.session(child.id), child)
    await storage.write(StorageKeys.messages(child.id), [seed])
    set((state) => {
      // The offer played its part: it disappears from the parent's conversation.
      const compactionSuggestion = { ...state.compactionSuggestion }
      delete compactionSuggestion[parentId]
      return {
        sessions: [child, ...state.sessions],
        messages: { ...state.messages, [child.id]: [seed] },
        compactionSuggestion,
      }
    })
    loadedMessages.add(child.id)
    emitChatEvent({ type: "session", sessionId: child.id, session: child })
    // Model, thinking and autonomy are the parent's: the fork swaps the context, not the
    // configuration the conversation was running with.
    inheritSessionConfig(parentId, child.id)
    return child
  },

  acceptPlanReview: (sessionId, permissionMode, orchestrate) => {
    const review = get().planReviews[sessionId]
    if (!review || review.status !== "proposed") return
    const updated: PlanReview = { ...review, status: "implementing", permissionMode }
    set((state) => ({ planReviews: { ...state.planReviews, [sessionId]: updated } }))
    void storage.write(StorageKeys.planReview(sessionId), updated)
    emitChatEvent({ type: "plan:review", sessionId, review: updated })
    // Plan accepted → turns the plan mode toggle off: the next message must not
    // generate another plan.
    useModeOverrides.getState().setMode("plan", sessionId, false)
    const session = get().sessions.find((s) => s.id === sessionId)
    const mode = session?.mode ?? "code"
    void get().sendMessage(mode, "Implemente o plano acima.", {
      options: {
        planReview: { status: "implementing", messageId: review.messageId, permissionMode },
        permissionMode,
        orchestrate: orchestrate ? {} : undefined,
      },
      sessionId,
    })
  },

  rejectPlanReview: (sessionId) => {
    const review = get().planReviews[sessionId]
    if (!review || review.status !== "proposed") return
    const updated: PlanReview = { ...review, status: "rejected" }
    set((state) => ({ planReviews: { ...state.planReviews, [sessionId]: updated } }))
    void storage.write(StorageKeys.planReview(sessionId), updated)
    emitChatEvent({ type: "plan:review", sessionId, review: updated })
  },

  dismissPlanReview: (sessionId: string) => {
    set((state) => {
      const next = { ...state.planReviews }
      delete next[sessionId]
      void storage.remove(StorageKeys.planReview(sessionId))
      return { planReviews: next }
    })
  },

  reviewPlanReview: (sessionId, feedback) => {
    const review = get().planReviews[sessionId]
    if (!review || review.status !== "proposed") return
    const updated: PlanReview = { ...review, status: "revising" }
    set((state) => ({ planReviews: { ...state.planReviews, [sessionId]: updated } }))
    void storage.write(StorageKeys.planReview(sessionId), updated)
    emitChatEvent({ type: "plan:review", sessionId, review: updated })
    const session = get().sessions.find((s) => s.id === sessionId)
    const mode = session?.mode ?? "code"
    void get().sendMessage(mode, feedback, {
      options: {
        planReview: { status: "revising", messageId: review.messageId, permissionMode: review.permissionMode ?? "ask" },
        permissionMode: review.permissionMode ?? "ask",
      },
      sessionId,
    })
  },

  renameSession: (id, title) => {
    set((state) => updateSessionIn(state, id, { title }))
    emitSessionEvent(id)
  },

  togglePin: (id) => {
    set((state) => {
      const session = state.sessions.find((s) => s.id === id)
      return session ? updateSessionIn(state, id, { pinned: !session.pinned }) : state
    })
    emitSessionEvent(id)
  },

  toggleArchive: (id) => {
    set((state) => {
      const session = state.sessions.find((s) => s.id === id)
      if (!session) return state
      const { archived, archivedAt } = setArchivedState(session, !session.archived)
      return updateSessionIn(state, id, { archived, archivedAt })
    })
    emitSessionEvent(id)
  },

  deleteSession: async (id) => {
    // Cascade: deleting an orchestrator aborts and removes its child workers.
    // Aborting the id itself is also necessary — deleting a streaming session
    // left the stream running orphaned in main.
    const ids = [id, ...get().sessions.filter((s) => s.parentId === id).map((s) => s.id)]
    for (const sid of ids) {
      void chatApi.abort(sid)
      await storage.remove(StorageKeys.session(sid))
      await storage.remove(StorageKeys.messages(sid))
      loadedMessages.delete(sid)
      void chatApi.closeBrowser(sid)
      useBrainPrefs.getState().setEnabled(sid, true) // clears the Brain override
      useSimplePrefs.getState().clear(sid)
      useSessionModelPrefs.getState().clear(sid)
      useSessionReasoning.getState().clear(sid)
      usePermissionPrefs.getState().clear(sid)
      useModelRotationStore.getState().selectRotation(sid, null)
      void storage.remove(StorageKeys.planReview(sid))
      void storage.remove(StorageKeys.pendingAsks(sid))
      // Attached sources: deletes the chat's own scope. When it was
      // in a folder, the scope belongs to the folder and main does not touch it here — the sources
      // keep counting for the other chats of it.
      void docsApi.clearSession(sid)
      emitChatEvent({ type: "session:deleted", sessionId: sid })
    }
    const idSet = new Set(ids)
    set((state) => {
      const messages = { ...state.messages }
      for (const sid of ids) delete messages[sid]
      const activeIds = { ...state.activeIds }
      for (const mode of ["chat", "code"] as SessionMode[]) {
        const active = activeIds[mode]
        if (active && idSet.has(active)) activeIds[mode] = null
      }
      const planReviews = { ...state.planReviews }
      for (const sid of ids) delete planReviews[sid]
      const pendingAsks = { ...state.pendingAsks }
      for (const sid of ids) delete pendingAsks[sid]
      const compactionSuggestion = { ...state.compactionSuggestion }
      for (const sid of ids) delete compactionSuggestion[sid]
      const unreadCounts = { ...state.unreadCounts }
      for (const sid of ids) delete unreadCounts[sid]
      return { sessions: state.sessions.filter((s) => !idSet.has(s.id)), messages, activeIds, planReviews, pendingAsks, compactionSuggestion, unreadCounts }
    })
  },

  moveToFolder: (id, folderId) => {
    set((state) => updateSessionIn(state, id, { folderId }))
    // Dragging a code chat into an empty folder also associates the folder with
    // its project — the same memory the chat created by the "+" would leave.
    learnFolderWorkspace(folderId, workspaceOfSession(get().sessions.find((s) => s.id === id)))
    emitSessionEvent(id)
  },

  placeSession: (id, { archived, ...rest }) => {
    set((state) => {
      const session = state.sessions.find((s) => s.id === id)
      if (!session) return state
      const archive = archived !== undefined && archived !== session.archived
        ? setArchivedState(session, archived)
        : {}
      return updateSessionIn(state, id, { ...rest, ...archive })
    })
    emitSessionEvent(id)
  },

  setSessionDirectories: (id, directory, extraDirectories) => {
    set((state) =>
      updateSessionIn(state, id, {
        ...(directory !== undefined ? { directory } : {}),
        extraDirectories: extraDirectories ?? [],
      }),
    )
    emitSessionEvent(id)
  },

  forkSession: async (id, messageId) => {
    const source = get().sessions.find((s) => s.id === id)
    if (!source) return null
    await get().ensureMessages(id)
    let msgs = get().messages[id] ?? []
    if (messageId) {
      const idx = msgs.findIndex((m) => m.id === messageId)
      if (idx >= 0) msgs = msgs.slice(0, idx + 1)
    }

    // Title "Original (fork #n)": n = highest existing counter of the same original + 1
    const baseTitle = source.title.replace(/ \(fork #\d+\)$/, "")
    const escaped = baseTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const counter = new RegExp(`^${escaped} \\(fork #(\\d+)\\)$`)
    const maxFork = get().sessions.reduce((max, s) => {
      const match = counter.exec(s.title)
      return match ? Math.max(max, Number(match[1])) : max
    }, 0)

    const now = Date.now()
    const fork: SessionInfo = {
      ...source,
      id: nanoid(),
      title: `${baseTitle} (fork #${maxFork + 1})`,
      pinned: false,
      createdAt: now,
      updatedAt: now,
    }
    // A fork is an independent session: it inherits no orchestration links nor revert
    delete fork.parentId
    delete fork.orchestration
    delete fork.revert

    // New message and part IDs (avoids event collision between sessions)
    const cloned = msgs.map((m) => ({
      ...m,
      id: nanoid(),
      parts: m.parts.map((p) => ({ ...p, id: nanoid() })),
    }))

    await storage.write(StorageKeys.session(fork.id), fork)
    await storage.write(StorageKeys.messages(fork.id), cloned)
    set((state) => ({
      sessions: [fork, ...state.sessions],
      messages: { ...state.messages, [fork.id]: cloned },
    }))
    loadedMessages.add(fork.id)
    emitChatEvent({ type: "session", sessionId: fork.id, session: fork })

    // Cloned image/artifact/document point to the SAME asset of the session
    // original (nothing is duplicated) — without linking the fork, the card stays
    // visible in its conversation but vanishes from the gallery's "This chat" filter.
    const mediaImagePrefix = `${MEDIA_SCHEME}://`
    const mediaIds = cloned
      .flatMap((m) => m.parts)
      .map((p) => {
        if (p.type === "image") return p.src.startsWith(mediaImagePrefix) ? p.src.slice(mediaImagePrefix.length) : null
        if (p.type === "artifact") return p.artifactId
        if (p.type === "document") return p.documentId
        return null
      })
      .filter((id): id is string => !!id)
    if (mediaIds.length > 0) void mediaApi.linkSessions(mediaIds, fork.id)

    return fork
  },

  deleteSessions: async (ids) => {
    const idSet = new Set<string>()
    for (const id of ids) {
      idSet.add(id)
      // Includes child workers in cascade
      for (const s of get().sessions) {
        if (s.parentId === id) idSet.add(s.id)
      }
    }
    for (const sid of idSet) {
      void chatApi.abort(sid)
      await storage.remove(StorageKeys.session(sid))
      await storage.remove(StorageKeys.messages(sid))
      loadedMessages.delete(sid)
      void chatApi.closeBrowser(sid)
      useBrainPrefs.getState().setEnabled(sid, true)
      useSimplePrefs.getState().clear(sid)
      useSessionModelPrefs.getState().clear(sid)
      useSessionReasoning.getState().clear(sid)
      usePermissionPrefs.getState().clear(sid)
      useModelRotationStore.getState().selectRotation(sid, null)
      void storage.remove(StorageKeys.planReview(sid))
      void storage.remove(StorageKeys.pendingAsks(sid))
      void docsApi.clearSession(sid)
      emitChatEvent({ type: "session:deleted", sessionId: sid })
    }
    set((state) => {
      const messages = { ...state.messages }
      for (const sid of idSet) delete messages[sid]
      const activeIds = { ...state.activeIds }
      for (const mode of ["chat", "code"] as SessionMode[]) {
        const active = activeIds[mode]
        if (active && idSet.has(active)) activeIds[mode] = null
      }
      const planReviews = { ...state.planReviews }
      for (const sid of idSet) delete planReviews[sid]
      const pendingAsks = { ...state.pendingAsks }
      for (const sid of idSet) delete pendingAsks[sid]
      const compactionSuggestion = { ...state.compactionSuggestion }
      for (const sid of idSet) delete compactionSuggestion[sid]
      const unreadCounts = { ...state.unreadCounts }
      for (const sid of idSet) delete unreadCounts[sid]
      return { sessions: state.sessions.filter((s) => !idSet.has(s.id)), messages, activeIds, planReviews, pendingAsks, compactionSuggestion, unreadCounts }
    })
  },

  createFolder: (mode, name, workspace) => {
    const folder: FolderInfo = {
      id: nanoid(),
      name,
      mode,
      pinned: false,
      archived: false,
      createdAt: Date.now(),
      // Project chosen in the dialog: without this the "+" of a newly created folder
      // only learns the repository when the first chat enters it
      // (learnFolderWorkspace), and until then it inherits the screen's workspace.
      workspace: workspace?.length ? workspace : undefined,
    }
    set((state) => {
      const folders = [...state.folders, folder]
      persistFolders(folders)
      return { folders }
    })
    emitChatEvent({ type: "folders", folders: get().folders })
    return folder
  },

  renameFolder: (id, name) => {
    set((state) => {
      const folders = state.folders.map((f) => (f.id === id ? { ...f, name } : f))
      persistFolders(folders)
      return { folders }
    })
    emitChatEvent({ type: "folders", folders: get().folders })
  },

  toggleFolderPin: (id) => {
    set((state) => {
      const folders = state.folders.map((f) => (f.id === id ? { ...f, pinned: !f.pinned } : f))
      persistFolders(folders)
      return { folders }
    })
    emitChatEvent({ type: "folders", folders: get().folders })
  },

  toggleFolderArchive: (id) => {
    const folder = get().folders.find((f) => f.id === id)
    if (!folder) return
    const archived = !folder.archived
    const affected: string[] = []
    set((state) => {
      const folders = state.folders.map((f) => (f.id === id ? { ...f, archived } : f))
      persistFolders(folders)
      // The folder's chats follow its state; the ones already in the
      // target state are not touched (nor re-emitted)
      const sessions = state.sessions.map((s) => {
        if (s.folderId !== id || s.archived === archived) return s
        affected.push(s.id)
        const next = setArchivedState(s, archived)
        persistSession(next)
        return next
      })
      return { folders, sessions }
    })
    for (const sid of affected) emitSessionEvent(sid)
    emitChatEvent({ type: "folders", folders: get().folders })
  },

  reviveFolder: (id) => {
    set((state) => {
      const folders = state.folders.map((f) => (f.id === id ? { ...f, archived: false } : f))
      persistFolders(folders)
      return { folders }
    })
    emitChatEvent({ type: "folders", folders: get().folders })
  },

  deleteFolder: (id) => {
    // Affected sessions BEFORE the set (afterwards, folderId will already be null)
    const affected = get().sessions.filter((s) => s.folderId === id).map((s) => s.id)
    // The folder's sources die with it: the chats go back to the root and none of
    // them resolves to this scope anymore, so whatever stayed on disk would be
    // unreachable garbage.
    void docsApi.clearFolder(id)
    set((state) => {
      const folders = state.folders.filter((f) => f.id !== id)
      persistFolders(folders)
      // Sessions of the folder go back to the root
      const sessions = state.sessions.map((s) => {
        if (s.folderId !== id) return s
        const next = { ...s, folderId: null }
        persistSession(next)
        return next
      })
      // Clears orphan entries from the automatic folder map
      const autoFolderMap = loadAutoFolderMap()
      for (const [dir, fid] of Object.entries(autoFolderMap)) {
        if (fid === id) {
          delete autoFolderMap[dir]
        }
      }
      persistAutoFolderMap(autoFolderMap)
      return { folders, sessions }
    })
    for (const sid of affected) emitSessionEvent(sid)
    emitChatEvent({ type: "folders", folders: get().folders })
  },

  folderWorkspace: (folderId) => {
    const folder = get().folders.find((f) => f.id === folderId)
    if (!folder) return undefined
    // The automatic map is the last clue of an EMPTY folder: the chats that
    // gave it the directory were deleted, but the project stays mapped.
    return workspaceOfFolder({
      folder,
      sessions: get().sessions,
      autoFolderMap: loadAutoFolderMap(),
    })
  },

  organizeSidebar: () => {
    const { sessions, folders } = get()

    // ——— 1) Folders of the same project (same mode and archiving state) → merge ———
    const byKey = new Map<string, FolderInfo[]>()
    for (const f of folders) {
      const key = `${f.mode}|${f.archived}|${folderKey(f.name)}`
      const list = byKey.get(key) ?? []
      list.push(f)
      byKey.set(key, list)
    }
    // absorbed → canonical; canonical = folder with more chats (tie → the oldest)
    const remap = new Map<string, string>()
    for (const list of byKey.values()) {
      if (list.length < 2) continue
      const count = (id: string) => sessions.filter((s) => s.folderId === id).length
      const canonical = [...list].sort((a, b) => count(b.id) - count(a.id) || a.createdAt - b.createdAt)[0]
      for (const dup of list) {
        if (dup.id !== canonical.id) remap.set(dup.id, canonical.id)
      }
    }
    if (remap.size > 0) {
      // Re-points entries of the automatic map of the absorbed folders
      const autoFolderMap = loadAutoFolderMap()
      for (const [dir, fid] of Object.entries(autoFolderMap)) {
        const target = remap.get(fid)
        if (target) autoFolderMap[dir] = target
      }
      persistAutoFolderMap(autoFolderMap)
      // Applied BEFORE step 2: createFolder (below) persists `state.folders`
      // and cannot re-include the absorbed folders.
      const foldersNext = folders.filter((f) => !remap.has(f.id))
      set({ folders: foldersNext })
      persistFolders(foldersNext)
      emitChatEvent({ type: "folders", folders: foldersNext })
    }

    // ——— 2) Loose chats (code, with a directory) → the project's folder ———
    const { sessions: current, folders: currentFolders } = get()
    const folderById = new Map(currentFolders.map((f) => [f.id, f]))
    const autoFolderMap = loadAutoFolderMap()
    let mapDirty = false
    const moves = new Map<string, string>() // sessionId → folderId
    // Sessions of absorbed folders move to the canonical one (layer 1)
    for (const s of current) {
      if (s.folderId && remap.has(s.folderId)) moves.set(s.id, remap.get(s.folderId)!)
    }
    const loose = current
      .filter((s) => s.mode === "code" && !s.folderId && !s.archived && !s.parentId && !s.routineId && !!s.directory)
      .sort((a, b) => b.updatedAt - a.updatedAt)
    // The same decision as the session creation, through the same path: here it
    // fixes the past (the chats that were already born loose), and there it avoids the
    // next one. Before, they were two similar and not equal rules — and the one here, on
    // running into the project's archived folder, created a SECOND folder with the
    // same name next to it: the duplicate this button exists to undo.
    for (const s of loose) {
      if (moves.has(s.id)) continue
      const directory = s.directory as string
      const plano = planAutoFolder({
        directory,
        mode: "code",
        folders: [...folderById.values()],
        mappedId: autoFolderMap[directory],
      })
      let folderId = plano.folderId
      if (!folderId) {
        const folder = get().createFolder("code", plano.create ?? normalizeFolderName(directory))
        folderById.set(folder.id, folder)
        folderId = folder.id
      }
      if (plano.revive) {
        get().reviveFolder(folderId)
        const revived = get().folders.find((f) => f.id === folderId)
        if (revived) folderById.set(folderId, revived)
      }
      if (autoFolderMap[directory] !== folderId) {
        autoFolderMap[directory] = folderId
        mapDirty = true
      }
      moves.set(s.id, folderId)
    }
    if (mapDirty) persistAutoFolderMap(autoFolderMap)

    if (moves.size > 0) {
      set((state) => ({
        sessions: state.sessions.map((s) => {
          const folderId = moves.get(s.id)
          if (folderId === undefined) return s
          const next = { ...s, folderId }
          persistSession(next)
          return next
        }),
      }))
      for (const sid of moves.keys()) emitSessionEvent(sid)
    }

    // Folder that gained chats now and never stored the workspace: learns from the
    // OLDEST of them — the first one to associate it with a repository.
    for (const folderId of new Set(moves.values())) {
      learnFolderWorkspace(folderId, workspaceOfSession(firstSessionOfFolder(folderId, get().sessions)))
    }
  },

  relocateFolder: (oldPath, newPath) => {
    if (!oldPath || !newPath || oldPath === newPath) return

    const autoFolderMap = loadAutoFolderMap()
    const folderId = autoFolderMap[oldPath]

    const affected: string[] = []
    set((state) => ({
      sessions: state.sessions.map((s) => {
        const patch = relocateSessionFolders(s, oldPath, newPath)
        if (!patch) return s
        affected.push(s.id)
        const next = { ...s, ...patch, updatedAt: Date.now() }
        persistSession(next)
        return next
      }),
    }))
    for (const sid of affected) emitSessionEvent(sid)

    const nextMap = relocateAutoFolderEntry(autoFolderMap, oldPath, newPath)
    if (nextMap) persistAutoFolderMap(nextMap)

    // The repository memory follows the relocation — in ANY folder
    // that pointed to the old path, not only in the one the map knows.
    let folders: FolderInfo[] | null = null
    for (const f of get().folders) {
      const workspace = relocateFolderWorkspace(f.workspace, oldPath, newPath)
      if (!workspace) continue
      folders = (folders ?? get().folders).map((x) => (x.id === f.id ? { ...x, workspace } : x))
    }
    if (folders) {
      set({ folders })
      persistFolders(folders)
      emitChatEvent({ type: "folders", folders })
    }

    // The folder name follows the project — but only when it is still the one derived from the
    // old path. A name chosen by hand is not touched.
    const folder = folderId ? get().folders.find((f) => f.id === folderId) : undefined
    if (folder) {
      const name = relocatedFolderName(folder.name, oldPath, newPath)
      if (name) get().renameFolder(folder.id, name)
    }
  },

  forgetFolder: (path) => {
    if (!path) return

    const affected: string[] = []
    set((state) => ({
      sessions: state.sessions.map((s) => {
        const extras = s.extraDirectories ?? []
        const discardsMain = s.directory === path
        const discardsExtra = extras.includes(path)
        if (!discardsMain && !discardsExtra) return s
        affected.push(s.id)
        const next: SessionInfo = { ...s, updatedAt: Date.now() }
        // Only the folder that vanished from disk leaves: the main one when it is that one, and the
        // extras the ones that remain, in the order they were in.
        if (discardsMain) delete next.directory
        if (discardsExtra) next.extraDirectories = extras.filter((extra) => extra !== path)
        persistSession(next)
        return next
      }),
    }))
    for (const sid of affected) emitSessionEvent(sid)

    const autoFolderMap = loadAutoFolderMap()
    if (autoFolderMap[path]) {
      delete autoFolderMap[path]
      persistAutoFolderMap(autoFolderMap)
    }
  },

  sendMessage: async (mode, text, config) => {
    const provider = useProviderStore.getState()
    // The model follows the session: chat override (or new chat draft)
    // > provider global default.
    const targetSessionId = config.sessionId ?? get().activeIds[mode]
    const selected = sessionModelFor(targetSessionId) ?? provider.selectedModel
    if (!selected) {
      throw new Error(i18n.t("chat.noModelSelected"))
    }

    // Level the new chat is running with — the one the composer shows and the turn
    // sends. Pinning it on the first send keeps the chat on it when the model's
    // default is touched later.
    const reasoningFallback = config.options.reasoning

    let sessionId = config.sessionId ?? get().activeIds[mode]
    if (sessionId) get().clearSuggestion(sessionId)
    let session = get().sessions.find((s) => s.id === sessionId)
    if (!session) {
      // The pending folder only counts if it belongs to the same mode as the session to create
      const pendingFolderId = get().pendingFolderId
      const pendingFolder = pendingFolderId
        ? get().folders.find((f) => f.id === pendingFolderId)
        : undefined
      session = await get().createSession(mode, {
        directory: config.directory,
        extraDirectories: config.extraDirectories,
        ...(pendingFolder && pendingFolder.mode === mode ? { folderId: pendingFolderId } : {}),
        // The agent picked for this new chat, in chat and in code alike.
        // A request made from the browser itself needs the general agent (the specialists have
        // no browser tools), so the pick does not apply there.
        ...(get().pendingProfile && !config.options.fromBrowser ? { profile: get().pendingProfile! } : {}),
      })
      if (get().pendingProfile) set({ pendingProfile: null })
      sessionId = session.id
      if (pendingFolderId) set({ pendingFolderId: null })
      // The new chat's Brain toggle (draft) starts counting for this session
      useBrainPrefs.getState().adopt(sessionId)
      useSimplePrefs.getState().adopt(sessionId)
      useModeOverrides.getState().adopt(sessionId)
      useSessionTools.getState().adopt(sessionId)
      useDraftInput.getState().adopt(sessionId)
      // The message replied to in the new chat ("draft" key) becomes the session's
      useMessageReply.getState().adopt(sessionId)
      // Sources attached in the tab BEFORE a session exists. It is awaited, and not
      // fired in parallel: the turn starts right below, and the agent has to
      // find the documents already in the session scope when it calls doc_list.
      await docsApi.adoptDraft(sessionId)
      // The panel tabs are stored per session; in a new chat they live
      // in an orphan bucket. Without changing buckets, the Sources tab the user just
      // used would vanish from the screen the instant they sent the message.
      usePanelStore.getState().adoptOrphanTabs(sessionId)
      // The model chosen in the new chat (draft) becomes the session's; without an
      // explicit choice, it pins the model actually used (inherited from the last
      // chat), so the picker and the send stay consistent.
      useSessionModelPrefs.getState().adopt(sessionId, selected)
      // Thinking and autonomy of the new chat also become the session's: without a
      // choice in the draft, it pins the level in force (the model's / the default),
      // so the chat does not change when the default is touched later.
      useSessionReasoning.getState().adopt(sessionId, reasoningFallback)
      usePermissionPrefs.getState().adopt(sessionId)
      // The rotation chosen in the new chat (draft) starts counting for the session
      useModelRotationStore.getState().adoptRotation(sessionId)
    } else if (mode === "code") {
      const dirChanged = config.directory && session.directory !== config.directory
      const extraChanged =
        config.extraDirectories &&
        JSON.stringify(config.extraDirectories) !== JSON.stringify(session.extraDirectories ?? [])
      if (dirChanged || extraChanged) {
        set((state) =>
          updateSessionIn(state, session!.id, {
            ...(dirChanged ? { directory: config.directory } : {}),
            extraDirectories: config.extraDirectories,
          }),
        )
      }
    }

    // The session may have been born a moment before this send — the side panel's new
    // chat, the voice call, "send to the side panel" — and then it never went through
    // the adoption above: the level chosen in the new chat stayed in the draft and the
    // chat opened "off" right after the first message. Only a chat that has not started
    // yet receives it; an ongoing one is never repainted by a stale draft.
    if (get().messages[sessionId!]?.length === 0 && !useSessionReasoning.getState().overrides[sessionId!]) {
      useSessionReasoning.getState().adopt(sessionId!, reasoningFallback)
    }

    // Clears an implemented/finished plan review and a finished orchestration
    const planReview = get().planReviews[sessionId!]
    const isPlanMsg = config.options.plan || config.options.planReview
    if (!isPlanMsg && planReview && planReview.status !== "proposed") {
      const next = { ...get().planReviews }
      delete next[sessionId!]
      set({ planReviews: next })
      void storage.remove(StorageKeys.planReview(sessionId!))
    }
    const orch = get().orchestration[sessionId!]
    // An INTERRUPTED plan is not swept away by the next message: its card is the
    // only way back to the work that never ran ("Continue"), and dropping it is the
    // person's call — the X is right there.
    if (orch && orch.status === "done" && !orch.interrupted) {
      // Same door as the card's X: a new message after the finished plan takes the
      // card away for good — marking it in the file, without deleting the plan (see
      // dismissOrchestration).
      get().dismissOrchestration(sessionId!)
    }

    // If it is sending in plan mode, mark it to create the review when the streaming ends
    if (config.options.plan) {
      set((state) => ({ _planReviewOutbox: { ...state._planReviewOutbox, [sessionId!]: true } }))
    }

    // Subagents, orchestra and /init use the configured worker model. Without
    // configuration, workerModel stays undefined on purpose: the engine then falls
    // back to providerId/modelId, which are the REAL model of this session — it is what the UI
    // promises ("with no selection, the workers use the same model as the main chat").
    // There used to be a `?? codeModel` here, which swapped that fallback for the
    // "Default model" preference — a different model, and one nobody validates against the
    // connected providers; if it were obsolete, the workers died with
    // "Model is unavailable" while the UI said it was using the main model.
    const needsWorker = config.options.subagents || config.options.orchestrate || config.options.initMode
    const worker = provider.workerModel
    const workerModel =
      needsWorker && worker
        ? { ...worker, reasoning: provider.workerReasoning ?? undefined }
        : undefined
    // Who conducts the orchestra (planning and synthesis): the model from Preferences /
    // "+" → Orchestra. Without it, the chat's own model — the same contract as the worker's.
    const conductor = provider.orchestratorModel
    const orchestratorModel =
      config.options.orchestrate && conductor
        ? { ...conductor, reasoning: provider.orchestratorReasoning ?? undefined }
        : undefined

    // Vision mode active = model configured AND mode active for this session
    // (per-chat toggle with a default in the preferences)
    const visionPrefs = (session.mode ?? mode) === "code"
      ? useModelModePrefs.getState().codeActiveModes
      : useModelModePrefs.getState().chatActiveModes

    await chatApi.send({
      sessionId: sessionId!,
      text,
      files: config.files,
      ...(config.retryOf ? { retryOf: config.retryOf } : {}),
      providerId: selected.providerId,
      modelId: selected.modelId,
      mode: session.mode ?? mode,
      options: config.options,
      directory: config.directory ?? session.directory,
      extraDirectories: config.extraDirectories ?? session.extraDirectories,
      workerModel,
      orchestratorModel,
      visionModel:
        provider.visionModel && modeActiveFor("vision", sessionId, visionPrefs.vision)
          ? provider.visionModel
          : undefined,
      language: LOCALE_PROMPT_NAME[useLocaleStore.getState().activeLocale],
      ...(config.options.loop ? { loopConfig: useLoopConfigStore.getState().config } : {}),
    })
  },

  stopStreaming: (sessionId) => {
    void chatApi.abort(sessionId)
    // Phase "cancelling": the abort was requested but main has not confirmed yet —
    // the button becomes a disabled "Stopping…" instead of vanishing, and the status only
    // goes back to idle when the engine emits it (or the fallback below confirms that
    // nothing was running).
    set((state) => ({
      status: { ...state.status, [sessionId]: "cancelling" as ChatStatus },
      errors: { ...state.errors, [sessionId]: undefined },
    }))
    // Fallback: when the generation has already ended, the abort is a no-op and no status
    // comes back — without this the status would stay stuck in cancelling forever.
    window.setTimeout(() => {
      void chatApi.running().then((ids) => {
        if (ids.includes(sessionId)) return
        set((state) => ({
          status: { ...state.status, [sessionId]: "idle" as ChatStatus },
        }))
      })
    }, 2500)
  },

  // Main persists and emits the "session" event with the updated state —
  // here it only mirrors immediately so the revert bar shows up without delay
  revertToMessage: async (sessionId, messageId) => {
    const revert = await sessionApi.revert(sessionId, messageId)
    if (!revert) return
    // A new revert replaces the previous unrevert notice.
    set((state) => ({ ...updateSessionIn(state, sessionId, { revert }), revertNotice: null }))
    // The reverted message goes back to the input, as if it were being edited.
    // The text comes out of `discardedMessages` instead of arriving in a field of its own in
    // SessionRevert: attachments are data URLs and duplicating them would double the size of
    // the session on disk.
    const prompt = revert.discardedMessages?.find((m) => m.role === "user")
    if (prompt) {
      const files = prompt.parts.filter((p): p is FilePart => p.type === "file")
      // The citation comes back as an ARMED reply (bar in the composer), and not as
      // `> [assistant] …` inside the text field: in the input the marker
      // would show up raw, and the send would come back with the answer marked the same
      // way — only by accident, without the person having chosen it.
      const { reply, body } = parseMessageReply(visibleMessageText(prompt))
      if (reply) useMessageReply.getState().setReply(sessionId, reply)
      useDraftInput.getState().setDraft(sessionId, body, files)
    }
  },

  unrevert: async (sessionId) => {
    const result = await sessionApi.unrevert(sessionId)
    if (!result?.done) return
    set((state) => updateSessionIn(state, sessionId, { revert: undefined }))
    // What could not come back (changed between the revert and now) stays visible as
    // a transient notice — not silent.
    const kept = (result.files?.conflicts.length ?? 0) + (result.media?.conflicts ?? 0)
    if (kept > 0 || result.files?.error) {
      set({
        revertNotice: {
          sessionId,
          files: result.files?.conflicts ?? [],
          filesError: result.files?.error,
          media: result.media,
        },
      })
    }
  },

  revertUncertain: async (sessionId) => {
    const revert = await sessionApi.revertUncertain(sessionId)
    if (revert) set((state) => updateSessionIn(state, sessionId, { revert }))
  },
}))

type Setter = (fn: (state: SessionState) => Partial<SessionState>) => void

// ─── Delta batching ──────────────────────────────────────────────────────
// Groups part-deltas into one frame (~33ms) so the stream looks fluid without one
// re-render per token (mirror of mobile). The flush applies everything in a single set
// copying only the affected session's list and updating only the affected
// message/part — the other messages keep the reference and do not re-render.

interface PendingDelta {
  sessionId: string
  messageId: string
  partId: string
  text: string
}

const DELTA_FLUSH_MS = 33

const deltaBuffer = new Map<string, PendingDelta>()
let deltaFlushTimer: ReturnType<typeof setTimeout> | null = null

function flushDeltas(set: Setter) {
  if (deltaFlushTimer) {
    clearTimeout(deltaFlushTimer)
    deltaFlushTimer = null
  }
  if (deltaBuffer.size === 0) return
  const pending = [...deltaBuffer.values()]
  deltaBuffer.clear()

  set((state) => {
    const messages = { ...state.messages }
    // Groups by session to copy each list only once
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
        if (part.type === "text" || part.type === "reasoning" || part.type === "agent") {
          parts[partIdx] = { ...part, text: part.text + delta.text }
          next[msgIdx] = { ...message, parts }
        }
      }
      messages[sessionId] = next
    }
    return { messages }
  })
}

/**
 * Mirror window (the Computer Use floating panel): applies the chat events to the
 * in-memory state to show the conversation live, but with no side
 * effect — the one that writes to disk, touches the preferences and, above all, fires
 * the message queue when the session goes idle is the main window. Two
 * windows doing that would send the same queued message twice.
 */
let passiveMirror = false
let mirrorStarted = false

export function startChatMirror(): void {
  if (mirrorStarted) return
  mirrorStarted = true
  passiveMirror = true
  chatApi.onEvent((event) => applyChatEvent(event, useSessionStore.setState, useSessionStore.getState))
}

function applyChatEvent(event: ChatEvent, set: Setter, get: () => SessionState) {
  // "folders" is the only event without a sessionId (complete replacement of the list)
  const sessionId = "sessionId" in event ? event.sessionId : ""

  // Events that touch the messages directly need to see the already
  // accumulated text — flush the pending deltas before applying them.
  if (event.type === "message" || event.type === "part" || event.type === "messages" || event.type === "status") {
    flushDeltas(set)
  }

  const persistPendingAsks = (sid: string) => {
    // Session not loaded yet (e.g.: "ask:done" from a card that main
    // closed before the conversation was opened): the store does not know its
    // list, and writing here would wipe the file that still holds valid requests.
    const asks = get().pendingAsks[sid]
    if (!asks || passiveMirror) return
    void storage.write(StorageKeys.pendingAsks(sid), asks)
  }

  switch (event.type) {
    case "status":
      set((state) => ({
        status: { ...state.status, [sessionId]: event.status },
        errors: { ...state.errors, [sessionId]: event.error },
        // Fallback (rotation): stores the attempt in progress; clears it when the
        // turn leaves the failure/fallback state.
        fallback:
          event.status === "fallback" && event.fallback
            ? { ...state.fallback, [sessionId]: event.fallback }
            : { ...state.fallback, [sessionId]: undefined },
      }))
      break

case "message": {
      const inbound = event.message
      set((state) => {
        const list = state.messages[sessionId] ?? []
        const idx = list.findIndex((m) => m.id === inbound.id)
        const next = idx >= 0 ? list.map((m, i) => (i === idx ? inbound : m)) : [...list, inbound]

        const isInbound = inbound.role === "assistant"
        // Empty placeholder the engine emits before the stream (and re-emits when
        // swapping attachments post-preprocess) does not count as unread — the first
        // part or the final message count.
        const placeholder =
          isInbound &&
          inbound.parts.length === 0 &&
          inbound.tokens === undefined &&
          inbound.error === undefined
        const activeId = state.activeIds["chat"] ?? state.activeIds["code"] ?? null
        const unreadCounts =
          isInbound && !placeholder && sessionId !== activeId
            ? { ...state.unreadCounts, [sessionId]: (state.unreadCounts[sessionId] ?? 0) + 1 }
            : state.unreadCounts

        // Status reconciliation: an assistant message with tokens/error
        // means the generation ended. If the `status: idle` event was
        // lost, this unlocks the input/stop and clears the "Thinking".
        const finished =
          inbound.role === "assistant" && (inbound.tokens !== undefined || inbound.error !== undefined)
        const stuck =
          state.status[sessionId] === "streaming" ||
          state.status[sessionId] === "submitted" ||
          state.status[sessionId] === "fallback"
        const status =
          finished && stuck
            ? { ...state.status, [sessionId]: "idle" as ChatStatus }
            : state.status
        const fallback = finished && stuck ? { ...state.fallback, [sessionId]: undefined } : state.fallback
        const liveContext =
          inbound.role === "assistant" && inbound.tokens !== undefined && state.liveContext[sessionId]
            ? { ...state.liveContext, [sessionId]: undefined }
            : state.liveContext

        return { messages: { ...state.messages, [sessionId]: next }, unreadCounts, status, fallback, liveContext }
      })

      // A model only gets into "recents" when it was actually used: the agent's final
      // answer (completedAt) arrived complete, with real content and without an
      // error. If the 1st turn fails (no answer), it does not count as usage — and a
      // later turn that answers does.
      if (
        !passiveMirror &&
        inbound.role === "assistant" &&
        inbound.completedAt &&
        !inbound.error &&
        inbound.parts.some((p) => p.type === "text" || p.type === "tool" || p.type === "image" || p.type === "agent")
      ) {
        useSessionModelPrefs.getState().markUsed(inbound.providerId, inbound.modelId)
      }
      break
    }

    case "part":
      // The event brings the COMPLETE state of the part (main keeps the
      // accumulated text), so any delta still in the buffer is already contained in it
      // — applying both would duplicate the stretch. Discarding the buffer here also
      // is what allows main to correct a text already transmitted (e.g.: the
      // sanitizing of internal markers in 'text-end').
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

    case "part-delta": {
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

    case "messages":
      // Complete replacement (e.g.: compaction inserted a summary in the middle) —
      // the event brings the whole list, so the session is already loaded.
      set((state) => ({
        messages: { ...state.messages, [sessionId]: event.messages },
        liveContext: { ...state.liveContext, [sessionId]: undefined },
      }))
      loadedMessages.add(sessionId)
      break

    case "context":
      set((state) => ({
        liveContext: {
          ...state.liveContext,
          [sessionId]: {
            input: event.input,
            output: event.output,
            estimated: event.estimated === true,
            cacheRead: event.cacheRead,
            cacheWrite: event.cacheWrite,
          },
        },
      }))
      break

    case "suggestion":
      set((state) => ({ suggestions: { ...state.suggestions, [sessionId]: event.text } }))
      break

    case "compaction:suggest":
      set((state) => {
        const previous = state.compactionSuggestion[sessionId]
        // The engine re-emits it at every end of turn while the condition holds. If the
        // person has already dismissed it for THIS count, the card does not come back — a
        // compaction (which changes the count) is what frees it again.
        if (previous && previous.summaries === event.summaries && previous.dismissed) return state
        return {
          compactionSuggestion: {
            ...state.compactionSuggestion,
            [sessionId]: {
              summaries: event.summaries,
              dismissed: false,
            },
          },
        }
      })
      break

    case "title":
      set((state) => {
        const sessions = state.sessions.map((s) => (s.id === sessionId ? { ...s, title: event.title } : s))
        return { sessions }
      })
      // The agent named the chat: mirrors the new title into the side panel's chat
      // tabs that point to that session.
      if (!passiveMirror) usePanelStore.getState().renameChatTabs(sessionId, event.title)
      break

    case "orchestration:plan":
      set((state) => ({ orchestration: { ...state.orchestration, [sessionId]: event.plan } }))
      break

    case "plan:review":
      set((state) => ({ planReviews: { ...state.planReviews, [sessionId]: event.review } }))
      if (!passiveMirror) void storage.write(StorageKeys.planReview(sessionId), event.review)
      break

    case "session":
      // Session created/updated by the main process (orchestration workers)
      set((state) => {
        const exists = state.sessions.some((s) => s.id === event.session.id)
        const sessions = exists
          ? state.sessions.map((s) => (s.id === event.session.id ? event.session : s))
          : [event.session, ...state.sessions]
        // Workers are born empty and main emits "session" before starting their
        // runChat: initializing the buffer here guarantees that the first
        // message/part events are not lost (a late ensureMessages
        // merges with the disk instead of overwriting).
        const messages =
          state.messages[event.session.id] === undefined
            ? { ...state.messages, [event.session.id]: [] }
            : state.messages
        return { sessions, messages }
      })
      break

    case "session:deleted":
      // Deleted in main (agent tool, mobile app): also clears what
      // this window keeps per conversation.
      loadedMessages.delete(sessionId)
      if (!passiveMirror) {
        useBrainPrefs.getState().setEnabled(sessionId, true)
        useSimplePrefs.getState().clear(sessionId)
        useSessionModelPrefs.getState().clear(sessionId)
        useSessionReasoning.getState().clear(sessionId)
        usePermissionPrefs.getState().clear(sessionId)
        useModelRotationStore.getState().selectRotation(sessionId, null)
      }
      set((state) => {
        const sessions = state.sessions.filter((s) => s.id !== sessionId)
        const messages = { ...state.messages }
        delete messages[sessionId]
        const activeIds = { ...state.activeIds }
        for (const mode of ["chat", "code"] as SessionMode[]) {
          if (activeIds[mode] === sessionId) activeIds[mode] = null
        }
        const planReviews = { ...state.planReviews }
        delete planReviews[sessionId]
        const unreadCounts = { ...state.unreadCounts }
        delete unreadCounts[sessionId]
        const pendingAsks = { ...state.pendingAsks }
        delete pendingAsks[sessionId]
        const compactionSuggestion = { ...state.compactionSuggestion }
        delete compactionSuggestion[sessionId]
        return { sessions, messages, activeIds, planReviews, unreadCounts, pendingAsks, compactionSuggestion }
      })
      break

    case "folders":
      set(() => ({ folders: event.folders }))
      break

    case "notifications:open": {
      // Click on a native notification → opens the corresponding session
      if (passiveMirror) break
      const session = get().sessions.find((s) => s.id === event.sessionId)
      if (session) void get().selectSession(session.mode, session.id)
      break
    }

    case "permission":
    case "question":
    case "subchat": {
      const ask: PendingAskUI =
        event.type === "permission"
          ? { requestId: event.requestId, kind: "permission", claim: event.claim, origin: event.origin }
          : event.type === "subchat"
            ? {
                requestId: event.requestId,
                kind: "subchat",
                subchat: { title: event.title, brief: event.brief, scope: event.scope, profile: event.profile },
                origin: event.origin,
              }
            : { requestId: event.requestId, kind: "question", questions: event.questions, origin: event.origin }
      set((state) => {
        const current = state.pendingAsks[sessionId] ?? []
        if (current.some((a) => a.requestId === ask.requestId)) return state
        return { pendingAsks: { ...state.pendingAsks, [sessionId]: [...current, ask] } }
      })
      void persistPendingAsks(sessionId)
      break
    }

    case "ask:batch":
      set((state) => {
        const current = state.pendingAsks[sessionId] ?? []
        const fresh = event.items
          .filter((item) => !current.some((a) => a.requestId === item.requestId))
          .map((item) => ({ ...item, batchId: event.batchId }))
        if (fresh.length === 0) return state
        return { pendingAsks: { ...state.pendingAsks, [sessionId]: [...current, ...fresh] } }
      })
      void persistPendingAsks(sessionId)
      break

    case "ask:done":
      set((state) => {
        const current = state.pendingAsks[sessionId]
        if (!current?.some((a) => a.requestId === event.requestId)) return state
        return {
          pendingAsks: {
            ...state.pendingAsks,
            [sessionId]: current.filter((a) => a.requestId !== event.requestId),
          },
        }
      })
      void persistPendingAsks(sessionId)
      break
  }

  function extractMessageText(msg: ChatMessage): string {
    return msg.parts
      .filter((p): p is TextPart => p.type === "text")
      .map((p) => p.text)
      .join("\n")
  }

  // Mirror: from here down there are only effects (proposed plan, queue).
  if (passiveMirror) return

  // When the streaming ends or errors, it checks plans and processes the queue
  if (event.type === "status" && event.status === "idle") {
    const state = get()
    const sessions = [...state.sessions].sort((a, b) => b.updatedAt - a.updatedAt)
    const patch: Partial<SessionState> = { sessions }

    // Creates a PlanReview if it was in plan mode
    if (state._planReviewOutbox[sessionId] && !state.planReviews[sessionId]) {
      const msgs = state.messages[sessionId] ?? []
      const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant")
      if (lastAssistant) {
        const review: PlanReview = {
          status: "proposed",
          messageId: lastAssistant.id,
          content: extractMessageText(lastAssistant),
        }
        patch.planReviews = { ...state.planReviews, [sessionId]: review }
        void storage.write(StorageKeys.planReview(sessionId), review)
        // Mobile only learns about the plan through this event: without it the accept
        // card never showed up there, even with the plan ready in the conversation.
        emitChatEvent({ type: "plan:review", sessionId, review })
      }
    }
    const cleanOutbox = { ...state._planReviewOutbox }
    delete cleanOutbox[sessionId]
    patch._planReviewOutbox = cleanOutbox

    set(() => patch)
  }

  // Processes the queue both in idle and in error (for retry/skip)
  if (event.type === "status" && (event.status === "idle" || event.status === "error")) {
    useMessageQueueStore.getState().onSessionIdle(sessionId)
    releaseUnseen(sessionId, set, get)
  }
}

/**
 * A conversation that streamed without ever being displayed (a worker, a
 * subchat, a routine) built its buffer from the events alone — and the history
 * cap in `ensureMessages` only knows the conversations that were displayed, so
 * those buffers stayed whole until a reload. One orchestra left a dozen workers
 * with thousands of tool parts each in the renderer. When such a turn ends the
 * buffer goes: main already wrote the history, and opening the conversation
 * re-reads it from disk.
 */
function releaseUnseen(sessionId: string, set: Setter, get: () => SessionState) {
  const state = get()
  if (state.messages[sessionId] === undefined) return
  if (recentSessions.includes(sessionId)) return
  if (Object.values(state.activeIds).includes(sessionId)) return
  if (state._planReviewOutbox[sessionId]) return
  loadedMessages.delete(sessionId)
  set((current) => {
    const messages = { ...current.messages }
    delete messages[sessionId]
    return { messages }
  })
}

/** Active session of the current mode */
export function useActiveSession(mode: SessionMode) {
  return useSessionStore((state) => {
    const id = state.activeIds[mode]
    return id ? state.sessions.find((s) => s.id === id) : undefined
  })
}

export function useSessionStatus(sessionId: string | null | undefined): ChatStatus {
  return useSessionStore((state) => (sessionId ? state.status[sessionId] ?? "idle" : "idle"))
}

/** The workspace the session TEACHES a folder: the main repository — a
 *  chat opened in a worktree belongs to the PROJECT's folder, and it is to the main
 *  one that the automatic map points — plus the extra folders. */
function workspaceOfSession(session: SessionInfo | undefined): string[] | undefined {
  if (!session || session.mode !== "code" || !session.directory) return undefined
  return [knownMain(session.directory), ...(session.extraDirectories ?? [])]
}

/**
 * The folder keeps the workspace of the FIRST chat that entered it and never swaps it again.
 * The chats say where it is being used NOW (and it is the most recent one that the "+"
 * follows); this memory is what is left when all of them are deleted — without
 * it, the "+" of an empty folder inherited the repository of the last chat on the screen.
 */
function learnFolderWorkspace(
  folderId: string | null | undefined,
  workspace: string[] | undefined,
): void {
  if (!folderId || !workspace?.length) return
  const { folders } = useSessionStore.getState()
  if (!folders.some((f) => f.id === folderId && !f.workspace?.length)) return
  const next = folders.map((f) => (f.id === folderId ? { ...f, workspace } : f))
  useSessionStore.setState({ folders: next })
  persistFolders(next)
  emitChatEvent({ type: "folders", folders: next })
}
