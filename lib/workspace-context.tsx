import { createContext, useContext, useState } from "react"

export type WorkspaceMode = "chat" | "code"

type WorkspaceContextType = {
  mode: WorkspaceMode
  setMode: (mode: WorkspaceMode) => void
}

const WorkspaceContext = createContext<WorkspaceContextType | null>(null)

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<WorkspaceMode>("chat")

  return (
    <WorkspaceContext.Provider value={{ mode, setMode }}>
      {children}
    </WorkspaceContext.Provider>
  )
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider")
  return ctx
}
