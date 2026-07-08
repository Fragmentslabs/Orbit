import { createContext, useContext, useState } from "react"

export type WorkspaceMode = "chat" | "code"

const RECENT_FOLDERS_KEY = "orbit-recent-folders"

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
  folders: string[]
  setFolders: (folders: string[]) => void
}

const WorkspaceContext = createContext<WorkspaceContextType | null>(null)

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<WorkspaceMode>("chat")
  const [folders, setFolders] = useState<string[]>(loadInitialFolders)

  return (
    <WorkspaceContext.Provider value={{ mode, setMode, folders, setFolders }}>
      {children}
    </WorkspaceContext.Provider>
  )
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider")
  return ctx
}
