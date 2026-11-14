import { useCallback } from "react"
import type { ChatStatus, SessionInfo } from "@shared/chat"
import { useWorkspace } from "@/lib/workspace-context"
import { EMPTY_LIST, usePeersStore } from "@/src/stores/peers-store"
import { useSessionStore } from "@/src/stores/session-store"

/**
 * The chats of the machine on screen: this computer's, or the paired desktop's
 * (ids namespaced). Screens that list or open "the runs of a routine", "a usage
 * row" and the like read through here so they do not need to know which one it is.
 */
export function useEnvSessions(): SessionInfo[] {
  const env = usePeersStore((s) => s.env)
  const local = useSessionStore((s) => s.sessions)
  const remote = usePeersStore((s) => (s.env === "local" ? EMPTY_LIST : (s.sessionsByPeer[s.env] ?? EMPTY_LIST))) as SessionInfo[]
  return env === "local" ? local : remote
}

/** Whether the list above has been read at least once (the remote one arrives with the connection). */
export function useEnvSessionsReady(): boolean {
  const env = usePeersStore((s) => s.env)
  const local = useSessionStore((s) => s.initialized)
  const remote = usePeersStore((s) => s.env !== "local" && s.sessionsByPeer[s.env] !== undefined)
  return env === "local" ? local : remote
}

export function useEnvSessionStatus(sessionId: string | undefined): ChatStatus | undefined {
  const env = usePeersStore((s) => s.env)
  const local = useSessionStore((s) => (sessionId ? s.status[sessionId] : undefined))
  const remote = usePeersStore((s) => (sessionId ? s.statuses[sessionId] : undefined))
  return env === "local" ? local : remote
}

/**
 * Opens a chat on the machine on screen and leaves the current page for the conversation.
 * Returns false when the chat is gone (so the caller can fall back to something else).
 */
export function useOpenEnvSession(): (sessionId: string) => boolean {
  const { mode, setMode, setView, setFolders } = useWorkspace()
  const sessions = useEnvSessions()
  const env = usePeersStore((s) => s.env)
  const openRemote = usePeersStore((s) => s.openSession)
  return useCallback(
    (sessionId) => {
      const session = sessions.find((s) => s.id === sessionId)
      if (!session) return false
      if (session.mode !== mode) setMode(session.mode)
      if (env !== "local") {
        openRemote(sessionId)
      } else {
        if (session.directory) setFolders([session.directory, ...(session.extraDirectories ?? [])])
        void useSessionStore.getState().selectSession(session.mode, session.id)
      }
      setView("chat")
      return true
    },
    [sessions, mode, env, openRemote, setMode, setView, setFolders],
  )
}
