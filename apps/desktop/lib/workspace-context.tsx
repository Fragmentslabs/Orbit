import { createContext, useContext, useEffect, useState } from "react"

export type WorkspaceMode = "chat" | "code"

export type WorkspaceView = "chat" | "memories" | "models" | "esteira" | "rotinas"

const RECENT_FOLDERS_KEY = "orbit-recent-folders"

function loadDefaultMode(): WorkspaceMode {
  try {
    const raw = localStorage.getItem("orbit-default-mode")
    if (raw) {
      const parsed = JSON.parse(raw) as WorkspaceMode
      if (parsed === "chat" || parsed === "code") return parsed
    }
  } catch {}
  return "chat"
}

function loadInitialFolders(): string[] {
  try {
    const stored = localStorage.getItem(RECENT_FOLDERS_KEY)
    if (stored) return JSON.parse(stored)
  } catch {}
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

  // Persiste pastas no localStorage sempre que mudam
  useEffect(() => {
    localStorage.setItem(RECENT_FOLDERS_KEY, JSON.stringify(folders))
  }, [folders])

  // Trocar de modo sempre volta para a view de chat
  const setMode = (next: WorkspaceMode) => {
    setModeState(next)
    setView("chat")
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
