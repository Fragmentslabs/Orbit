import { createContext, useContext, useEffect, useState } from "react"

export type WorkspaceMode = "chat" | "code"

export type WorkspaceView = "chat" | "memories" | "models" | "pipeline" | "routines" | "tools" | "analytics"

const RECENT_FOLDERS_KEY = "orbit-recent-folders"

function loadDefaultMode(): WorkspaceMode {
  try {
    const raw = localStorage.getItem("orbit-default-mode")
    if (raw) {
      const parsed = JSON.parse(raw) as WorkspaceMode
      if (parsed === "chat" || parsed === "code") return parsed
    }
  } catch {
    // localStorage unavailable or corrupted JSON — falls back to the default
  }
  return "chat"
}

function loadInitialFolders(): string[] {
  try {
    const stored = localStorage.getItem(RECENT_FOLDERS_KEY)
    if (stored) return JSON.parse(stored)
  } catch {
    // same: a corrupted folder list starts over empty
  }
  return []
}

type WorkspaceContextType = {
  mode: WorkspaceMode
  setMode: (mode: WorkspaceMode) => void
  view: WorkspaceView
  setView: (view: WorkspaceView) => void
  folders: string[]
  setFolders: (folders: string[]) => void
}

const WorkspaceContext = createContext<WorkspaceContextType | null>(null)

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<WorkspaceMode>(loadDefaultMode)
  const [view, setView] = useState<WorkspaceView>("chat")
  const [folders, setFolders] = useState<string[]>(loadInitialFolders)

  // Persists folders in localStorage whenever they change
  useEffect(() => {
    localStorage.setItem(RECENT_FOLDERS_KEY, JSON.stringify(folders))
  }, [folders])

  // Switching modes always goes back to the chat view and persists the mode: on the
  // next opening of the app, it opens in the same mode (chat or code).
  const setMode = (next: WorkspaceMode) => {
    setModeState(next)
    setView("chat")
    try {
      localStorage.setItem("orbit-default-mode", JSON.stringify(next))
    } catch {
      // full quota or private mode: the mode is only worth in this session
    }
  }

  return (
    <WorkspaceContext.Provider value={{ mode, setMode, view, setView, folders, setFolders }}>
      {children}
    </WorkspaceContext.Provider>
  )
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider")
  return ctx
}

/**
 * The current workspace mode, read also OUTSIDE the provider — the Computer Use panels
 * window has no workspace, and there the caller always brings the fixed session, so the
 * fallback never decides which chat answers.
 */
export function useWorkspaceMode(): WorkspaceMode {
  return useContext(WorkspaceContext)?.mode ?? loadDefaultMode()
}
