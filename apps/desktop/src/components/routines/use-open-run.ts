import { useWorkspace } from "@/lib/workspace-context"
import { isRoutineSession } from "@/src/lib/last-chat"
import { useSessionStore } from "@/src/stores/session-store"

/**
 * Opens the conversation an execution of a routine produced, from anywhere on the Routines
 * page. Same path as the sidebar's row: it activates the session in the mode it was born in
 * (a chat routine opens in chat, a code one in code) and leaves the page for the conversation.
 * Returns false when the conversation no longer exists (it was deleted in the sidebar), so the
 * caller can fall back to something else.
 */
export function useOpenRun(): (sessionId: string) => boolean {
  const { mode, setMode, setView, setFolders } = useWorkspace()
  const sessions = useSessionStore((s) => s.sessions)
  return (sessionId) => {
    const session = sessions.find((s) => s.id === sessionId)
    if (!session) return false
    if (session.mode !== mode) setMode(session.mode)
    // The routine's conversation lives in the routine's own folder: it opens with that folder
    // (the chat reads it from the session), but it is not handed to the workspace — the next NEW
    // chat keeps the folder of the last chat the person actually worked in.
    if (session.directory && !isRoutineSession(session)) setFolders([session.directory, ...(session.extraDirectories ?? [])])
    void useSessionStore.getState().selectSession(session.mode, session.id)
    setView("chat")
    return true
  }
}
