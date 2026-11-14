import { create } from "zustand"
import type { ChatEvent, ChatMessage, ChatStatus, FolderInfo, OrchestrationPlan, PlanReview, RotationFallbackInfo, SessionInfo } from "@shared/chat"
import { parseRemoteSessionId, type PeersEvent, type PeersSnapshot } from "@shared/peers"
import { peersApi } from "@/src/lib/ipc"
import type { CompactionSuggestion, LiveContext, PendingAskUI } from "@/src/stores/session-store"

const ENV_KEY = "orbit:environment"
/** The most the other machine hands over per page of history (see `peers:messages`). */
const PAGE_SIZE = 100

/**
 * Other desktops, as the renderer sees them (electron/lib/peers).
 *
 * A separate store from session-store on purpose: a remote chat is read from the
 * network, never written to this machine's storage, and none of the local
 * features (folders, revert, fork, drafts) apply to it. Session ids here are
 * namespaced (`peer:<peerId>:<id>`), which is also what the panel bucket and the
 * piece IPCs receive.
 */

export type EnvId = "local" | string

/**
 * The fallback of every list selector. zustand 5 compares by reference: a selector
 * answering `?? []` returns a NEW array on each read, React sees a change every
 * time and re-renders forever ("Maximum update depth exceeded").
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const EMPTY_LIST: readonly any[] = Object.freeze([])

interface PeersState {
  snapshot: PeersSnapshot | null
  env: EnvId
  sessionsByPeer: Record<string, SessionInfo[]>
  foldersByPeer: Record<string, FolderInfo[]>
  runningByPeer: Record<string, string[]>
  activeByPeer: Record<string, string | null>
  messages: Record<string, ChatMessage[]>
  statuses: Record<string, ChatStatus>
  /** The provider rotation in progress ("trying fallback 2/3"), while the status is `fallback`. */
  fallback: Record<string, RotationFallbackInfo | undefined>
  /** Questions and permissions the other machine's agent is waiting on, by namespaced chat id. */
  pendingAsks: Record<string, PendingAskUI[]>
  /** Plan awaiting the person's decision, and the orchestration plan, by namespaced chat id. */
  planReviews: Record<string, PlanReview | undefined>
  orchestration: Record<string, OrchestrationPlan | undefined>
  /** Size of the context during the turn, the greyed-out next message and the compaction offer —
   *  same shapes as session-store, read by the composer. */
  liveContext: Record<string, LiveContext | undefined>
  suggestions: Record<string, string | undefined>
  compactionSuggestion: Record<string, CompactionSuggestion | undefined>
  /** History pages: the first page is the last 100 messages; the rest is fetched on demand. */
  historyExhausted: Record<string, boolean>
  olderLoading: Record<string, boolean>
  loading: Record<string, boolean>
  errors: Record<string, string | undefined>
  /** Message being sent from here (the input shows the spinner). */
  sending: Record<string, boolean>
  /** The "Connect devices" modal — opened from the sidebar footer and the environment selector. */
  connectOpen: boolean
  connectTab: "phone" | "computer"
  openConnect: (tab?: "phone" | "computer") => void
  setConnectOpen: (open: boolean) => void
  setEnv: (env: EnvId) => void
  openSession: (sessionId: string) => void
  /** Folder (of the active desktop) where the next new chat is born — the "+" of a folder row. */
  homeFolderId: string | null
  /** The "new routine" form of the desktop on screen (opened from the Routines page). */
  routineDialogOpen: boolean
  setRoutineDialogOpen: (open: boolean) => void
  /** Back to the "new chat" screen of a desktop (no chat open), optionally inside a folder. */
  goHome: (peerId: string, folderId?: string | null) => void
  loadMessages: (sessionId: string, force?: boolean) => Promise<void>
  /** The page of history before the ones already loaded. */
  loadOlder: (sessionId: string) => Promise<void>
  /** Takes a plan card off the screen on this machine only (the other one keeps its own state). */
  dismissPlanReview: (sessionId: string) => void
  send: (sessionId: string, text: string, opts?: { directory?: string; extraDirectories?: string[] }) => Promise<void>
  abort: (sessionId: string) => Promise<void>
  /** Answers a question/permission on the machine that runs the agent. */
  replyAsk: (peerId: string, requestId: string, value: unknown) => Promise<void>
}

const DELTA_FLUSH_MS = 50
const deltas = new Map<string, { sessionId: string; messageId: string; partId: string; text: string }>()
let deltaTimer: ReturnType<typeof setTimeout> | null = null

export const usePeersStore = create<PeersState>((set, get) => ({
  snapshot: null,
  env: "local",
  sessionsByPeer: {},
  foldersByPeer: {},
  runningByPeer: {},
  activeByPeer: {},
  messages: {},
  statuses: {},
  fallback: {},
  pendingAsks: {},
  planReviews: {},
  orchestration: {},
  liveContext: {},
  suggestions: {},
  compactionSuggestion: {},
  historyExhausted: {},
  olderLoading: {},
  loading: {},
  errors: {},
  sending: {},
  homeFolderId: null,
  routineDialogOpen: false,
  setRoutineDialogOpen: (open) => set({ routineDialogOpen: open }),
  connectOpen: false,
  connectTab: "phone",
  openConnect: (tab) => set((s) => ({ connectOpen: true, connectTab: tab ?? s.connectTab })),
  setConnectOpen: (open) => set({ connectOpen: open }),

  setEnv: (env) => {
    set({ env })
    try {
      localStorage.setItem(ENV_KEY, env)
    } catch {
      /* storage unavailable — the choice just does not survive a reload */
    }
    if (env !== "local") void peersApi.resend(env)
  },

  openSession: (sessionId) => {
    const parsed = parseRemoteSessionId(sessionId)
    if (!parsed) return
    set((s) => ({
      env: parsed.peerId,
      homeFolderId: null,
      activeByPeer: { ...s.activeByPeer, [parsed.peerId]: sessionId },
    }))
    void get().loadMessages(sessionId)
  },

  goHome: (peerId, folderId = null) =>
    set((s) => ({ env: peerId, homeFolderId: folderId, activeByPeer: { ...s.activeByPeer, [peerId]: null } })),

  loadMessages: async (sessionId, force = false) => {
    if (!force && (get().messages[sessionId] || get().loading[sessionId])) return
    set((s) => ({ loading: { ...s.loading, [sessionId]: true }, errors: { ...s.errors, [sessionId]: undefined } }))
    try {
      const [list, state] = await Promise.all([
        peersApi.messages(sessionId, { limit: 100 }),
        // The cards the agent is waiting on live outside the messages.
        peersApi.sessionState(sessionId).catch(() => null),
      ])
      set((s) => ({
        messages: { ...s.messages, [sessionId]: list },
        historyExhausted: { ...s.historyExhausted, [sessionId]: list.length < PAGE_SIZE },
        pendingAsks: { ...s.pendingAsks, [sessionId]: (state?.pendingAsks ?? []) as PendingAskUI[] },
        planReviews: { ...s.planReviews, [sessionId]: state?.planReview },
        orchestration: { ...s.orchestration, [sessionId]: state?.plan },
      }))
    } catch (err) {
      set((s) => ({ errors: { ...s.errors, [sessionId]: (err as Error).message } }))
    } finally {
      set((s) => ({ loading: { ...s.loading, [sessionId]: false } }))
    }
  },

  loadOlder: async (sessionId) => {
    const s = get()
    const loaded = s.messages[sessionId]
    if (!loaded || s.historyExhausted[sessionId] || s.olderLoading[sessionId]) return
    set((st) => ({ olderLoading: { ...st.olderLoading, [sessionId]: true } }))
    try {
      const page = await peersApi.messages(sessionId, { limit: PAGE_SIZE, offset: loaded.length })
      set((st) => {
        const current = st.messages[sessionId] ?? []
        const known = new Set(current.map((m) => m.id))
        const fresh = page.filter((m) => !known.has(m.id))
        return {
          messages: fresh.length ? { ...st.messages, [sessionId]: [...fresh, ...current] } : st.messages,
          historyExhausted: { ...st.historyExhausted, [sessionId]: page.length < PAGE_SIZE || fresh.length === 0 },
        }
      })
    } catch (err) {
      set((st) => ({ errors: { ...st.errors, [sessionId]: (err as Error).message } }))
    } finally {
      set((st) => ({ olderLoading: { ...st.olderLoading, [sessionId]: false } }))
    }
  },

  dismissPlanReview: (sessionId) => set((s) => ({ planReviews: { ...s.planReviews, [sessionId]: undefined } })),

  send: async (sessionId, text, opts) => {
    set((s) => ({ sending: { ...s.sending, [sessionId]: true }, errors: { ...s.errors, [sessionId]: undefined } }))
    try {
      await peersApi.send(sessionId, text, opts)
    } catch (err) {
      set((s) => ({ errors: { ...s.errors, [sessionId]: (err as Error).message } }))
      throw err
    } finally {
      set((s) => ({ sending: { ...s.sending, [sessionId]: false } }))
    }
  },

  abort: async (sessionId) => {
    await peersApi.abort(sessionId).catch(() => {})
  },

  replyAsk: async (peerId, requestId, value) => {
    await peersApi.request(peerId, { type: "ask:reply", requestId, value })
  },
}))

function flushDeltas() {
  if (deltaTimer) clearTimeout(deltaTimer)
  deltaTimer = null
  if (!deltas.size) return
  const pending = [...deltas.values()]
  deltas.clear()
  usePeersStore.setState((state) => {
    const messages = { ...state.messages }
    for (const d of pending) {
      const list = messages[d.sessionId]
      if (!list) continue
      const idx = list.findIndex((m) => m.id === d.messageId)
      if (idx < 0) continue
      const message = list[idx]
      const partIdx = message.parts.findIndex((p) => p.id === d.partId)
      if (partIdx < 0) continue
      const part = message.parts[partIdx]
      if (part.type !== "text" && part.type !== "reasoning" && part.type !== "agent") continue
      const parts = message.parts.slice()
      parts[partIdx] = { ...part, text: part.text + d.text }
      const next = list.slice()
      next[idx] = { ...message, parts }
      messages[d.sessionId] = next
    }
    return { messages }
  })
}

function applyChat(event: ChatEvent) {
  const sessionId = "sessionId" in event ? event.sessionId : ""
  if (!sessionId) return
  if (event.type === "message" || event.type === "messages" || event.type === "part" || event.type === "status") flushDeltas()
  switch (event.type) {
    case "status":
      usePeersStore.setState((s) => ({
        statuses: { ...s.statuses, [sessionId]: event.status },
        fallback: { ...s.fallback, [sessionId]: event.status === "fallback" ? event.fallback : undefined },
      }))
      break
    case "message":
      usePeersStore.setState((s) => {
        const list = s.messages[sessionId]
        if (!list) return {}
        const idx = list.findIndex((m) => m.id === event.message.id)
        const next = idx >= 0 ? list.map((m, i) => (i === idx ? event.message : m)) : [...list, event.message]
        return { messages: { ...s.messages, [sessionId]: next } }
      })
      break
    case "messages":
      usePeersStore.setState((s) => ({ messages: { ...s.messages, [sessionId]: event.messages } }))
      break
    case "part":
      deltas.delete(`${sessionId}:${event.messageId}:${event.part.id}`)
      usePeersStore.setState((s) => {
        const list = s.messages[sessionId]
        if (!list) return {}
        const next = list.map((m) => {
          if (m.id !== event.messageId) return m
          const idx = m.parts.findIndex((p) => p.id === event.part.id)
          const parts = idx >= 0 ? m.parts.map((p, i) => (i === idx ? event.part : p)) : [...m.parts, event.part]
          return { ...m, parts }
        })
        return { messages: { ...s.messages, [sessionId]: next } }
      })
      break
    case "part-delta": {
      const key = `${sessionId}:${event.messageId}:${event.partId}`
      const current = deltas.get(key)
      if (current) current.text += event.delta
      else deltas.set(key, { sessionId, messageId: event.messageId, partId: event.partId, text: event.delta })
      if (!deltaTimer) deltaTimer = setTimeout(flushDeltas, DELTA_FLUSH_MS)
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
      usePeersStore.setState((s) => {
        const current = s.pendingAsks[sessionId] ?? []
        if (current.some((a) => a.requestId === ask.requestId)) return {}
        return { pendingAsks: { ...s.pendingAsks, [sessionId]: [...current, ask] } }
      })
      break
    }
    case "ask:batch":
      usePeersStore.setState((s) => {
        const current = s.pendingAsks[sessionId] ?? []
        const fresh = event.items
          .filter((item) => !current.some((a) => a.requestId === item.requestId))
          .map((item) => ({ ...item, batchId: event.batchId }))
        return fresh.length ? { pendingAsks: { ...s.pendingAsks, [sessionId]: [...current, ...fresh] } } : {}
      })
      break
    case "ask:done":
      usePeersStore.setState((s) => {
        const current = s.pendingAsks[sessionId]
        if (!current?.some((a) => a.requestId === event.requestId)) return {}
        return { pendingAsks: { ...s.pendingAsks, [sessionId]: current.filter((a) => a.requestId !== event.requestId) } }
      })
      break
    case "context":
      usePeersStore.setState((s) => ({
        liveContext: {
          ...s.liveContext,
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
      usePeersStore.setState((s) => ({ suggestions: { ...s.suggestions, [sessionId]: event.text } }))
      break
    case "compaction:suggest":
      usePeersStore.setState((s) => {
        const previous = s.compactionSuggestion[sessionId]
        // Re-emitted at the end of every turn while the condition holds: a dismissal sticks
        // for this count, and only a compaction (which changes it) frees the offer again.
        if (previous && previous.summaries === event.summaries && previous.dismissed) return {}
        return { compactionSuggestion: { ...s.compactionSuggestion, [sessionId]: { summaries: event.summaries, dismissed: false } } }
      })
      break
    case "orchestration:plan":
      usePeersStore.setState((s) => ({ orchestration: { ...s.orchestration, [sessionId]: event.plan } }))
      break
    case "plan:review":
      usePeersStore.setState((s) => ({ planReviews: { ...s.planReviews, [sessionId]: event.review } }))
      break
    default:
      break
  }
}

function applyEvent(event: PeersEvent) {
  switch (event.type) {
    case "snapshot": {
      const paired = new Set(event.snapshot.peers.map((p) => p.peerId))
      usePeersStore.setState((s) => ({
        snapshot: event.snapshot,
        // The machine was forgotten (or this one was revoked there): back home.
        env: s.env !== "local" && !paired.has(s.env) ? "local" : s.env,
      }))
      break
    }
    case "sessions":
      usePeersStore.setState((s) => ({ sessionsByPeer: { ...s.sessionsByPeer, [event.peerId]: event.sessions } }))
      break
    case "folders":
      usePeersStore.setState((s) => ({ foldersByPeer: { ...s.foldersByPeer, [event.peerId]: event.folders } }))
      break
    case "statuses":
      usePeersStore.setState((s) => {
        const statuses = { ...s.statuses }
        const running = new Set(event.running)
        for (const sid of s.runningByPeer[event.peerId] ?? []) if (!running.has(sid)) statuses[sid] = "idle"
        for (const sid of running) if (!statuses[sid] || statuses[sid] === "idle") statuses[sid] = "streaming"
        return { runningByPeer: { ...s.runningByPeer, [event.peerId]: event.running }, statuses }
      })
      break
    case "chat":
      applyChat(event.event)
      break
  }
}

let started = false

export function startPeersMirror(): void {
  if (started || !window.ipcRenderer) return
  started = true
  // The environment survives a reload — coming back to "this computer" every
  // time made the remote machine feel like a tab that forgets itself.
  try {
    const saved = localStorage.getItem(ENV_KEY)
    if (saved && saved !== "local") usePeersStore.setState({ env: saved })
  } catch {
    /* no storage */
  }
  peersApi.onEvent(applyEvent)
  void peersApi.snapshot().then((snapshot) => usePeersStore.setState({ snapshot }))
  void peersApi.resend()
}

/** The remote session on screen, when the environment is another desktop. */
export function useActiveRemoteSession(): { sessionId: string; session: SessionInfo | undefined } | null {
  const env = usePeersStore((s) => s.env)
  const sessionId = usePeersStore((s) => (s.env === "local" ? null : (s.activeByPeer[s.env] ?? null)))
  const session = usePeersStore((s) =>
    s.env === "local" || !sessionId ? undefined : s.sessionsByPeer[s.env]?.find((x) => x.id === sessionId),
  )
  if (env === "local" || !sessionId) return null
  return { sessionId, session }
}

export function isRemoteRunning(status: ChatStatus | undefined): boolean {
  return status === "submitted" || status === "streaming" || status === "cancelling" || status === "fallback"
}
