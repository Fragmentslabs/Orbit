import { useWorkspace } from "@/lib/workspace-context"
import { useSessionStore } from "@/src/stores/session-store"

/**
 * Opens the conversation an execution of a routine produced, from anywhere on the Routines
 * page. Same path as the sidebar's row: it activates the session in the mode it was born in
 * (a chat routine opens in chat, a code one in code, with its folders) and leaves the page for
 * the conversation. Returns false when the conversation no longer exists (it was deleted in
 * the sidebar), so the caller can fall back to something else.
 */
export function useOpenRun(): (sessionId: string) => boolean {
  const { mode, setMode, setView, setFolders } = useWorkspace()
  const sessions = useSessionStore((s) => s.sessions)
  return (sessionId) => {
    const session = sessions.find((s) => s.id === sessionId)
    if (!session) return false
    if (session.mode !== mode) setMode(session.mode)
    if (session.directory) setFolders([session.directory, ...(session.extraDirectories ?? [])])
    void useSessionStore.getState().selectSession(session.mode, session.id)
    setView("chat")
    return true
  }
}
