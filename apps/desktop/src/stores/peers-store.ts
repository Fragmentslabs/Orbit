import { create } from "zustand"
import type { ChatEvent, ChatMessage, ChatStatus, FolderInfo, SessionInfo } from "@shared/chat"
import { parseRemoteSessionId, type PeersEvent, type PeersSnapshot } from "@shared/peers"
import { peersApi } from "@/src/lib/ipc"

const ENV_KEY = "orbit:environment"

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
  loadMessages: (sessionId: string, force?: boolean) => Promise<void>
  send: (sessionId: string, text: string) => Promise<void>
  abort: (sessionId: string) => Promise<void>
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
  loading: {},
  errors: {},
  sending: {},
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
    set((s) => ({ env: parsed.peerId, activeByPeer: { ...s.activeByPeer, [parsed.peerId]: sessionId } }))
    void get().loadMessages(sessionId)
  },

  loadMessages: async (sessionId, force = false) => {
    if (!force && (get().messages[sessionId] || get().loading[sessionId])) return
    set((s) => ({ loading: { ...s.loading, [sessionId]: true }, errors: { ...s.errors, [sessionId]: undefined } }))
    try {
      const list = await peersApi.messages(sessionId, { limit: 100 })
      set((s) => ({ messages: { ...s.messages, [sessionId]: list } }))
    } catch (err) {
      set((s) => ({ errors: { ...s.errors, [sessionId]: (err as Error).message } }))
    } finally {
      set((s) => ({ loading: { ...s.loading, [sessionId]: false } }))
    }
  },

  send: async (sessionId, text) => {
    set((s) => ({ sending: { ...s.sending, [sessionId]: true }, errors: { ...s.errors, [sessionId]: undefined } }))
    try {
      await peersApi.send(sessionId, text)
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
      usePeersStore.setState((s) => ({ statuses: { ...s.statuses, [sessionId]: event.status } }))
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
