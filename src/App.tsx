import { useCallback, useEffect, useRef, useState } from "react"

import { SidebarProvider, useSidebar } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppSidebar } from "@/components/app-sidebar"
import { Button } from "@/components/ui/button"
import { ThemeProvider } from "@/components/theme-provider"
import { WorkspaceProvider, useWorkspace } from "@/lib/workspace-context"
import { ChatInput } from "@/src/components/chat-input"
import { CodeInput } from "@/src/components/code-input"
import { ChatHeader } from "@/src/components/chat-header"
import { RightPanel } from "@/src/components/right-panel"
import { Persona, type PersonaState } from "@/src/components/ai/persona"
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels"

const HOVER_ZONE_WIDTH = 6
const SIDEBAR_HIDE_DELAY = 300
const SIDEBAR_SHOW_DELAY = 100
const STORAGE_KEY = "sidebar-mode"

type SidebarMode = "hover" | "pinned"

function loadMode(): SidebarMode {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === "hover" || stored === "pinned") return stored
  return "hover"
}

function HoverEdge() {
  const { setOpen } = useSidebar()
  const showTimer = useRef<ReturnType<typeof setTimeout>>()

  const handleMouseEnter = useCallback(() => {
    clearTimeout(showTimer.current)
    showTimer.current = setTimeout(() => setOpen(true), SIDEBAR_SHOW_DELAY)
  }, [setOpen])

  return (
    <div
      className="absolute left-0 top-0 z-50 h-full"
      style={{ width: HOVER_ZONE_WIDTH }}
      onMouseEnter={handleMouseEnter}
    />
  )
}

function Placeholder() {
  const { mode } = useWorkspace()
  const [personaState, setPersonaState] = useState<PersonaState>("idle")

  const personaStates: { key: PersonaState; label: string }[] = [
    { key: "idle", label: "Parado" },
    { key: "thinking", label: "Pensando" },
    { key: "listening", label: "Ouvindo" },
    { key: "speaking", label: "Falando" },
    { key: "asleep", label: "Dormindo" },
  ]

  const chatContent = (
    <div className="flex flex-col items-center gap-6">
      <Persona state={personaState} />
      <div className="flex flex-col items-center gap-2">
        <p className="text-lg font-medium text-foreground">Pronto para conversar</p>
        <p className="text-sm text-muted-foreground">Selecione um chat ou inicie uma nova conversa</p>
      </div>
      <div className="flex items-center gap-2">
        {personaStates.map(({ key, label }) => (
          <Button
            key={key}
            onClick={() => setPersonaState(key)}
            variant={personaState === key ? "default" : "outline"}
            size="sm"
          >
            {label}
          </Button>
        ))}
      </div>
    </div>
  )

  const codeContent = (
    <div className="flex flex-col items-center gap-6">
      <Persona state={personaState} />
      <div className="flex flex-col items-center gap-2">
        <p className="text-lg font-medium text-foreground">Pronto para programar</p>
        <p className="text-sm text-muted-foreground">Selecione um contexto de código ou inicie um novo</p>
      </div>
      <div className="flex items-center gap-2">
        {personaStates.map(({ key, label }) => (
          <Button
            key={key}
            onClick={() => setPersonaState(key)}
            variant={personaState === key ? "default" : "outline"}
            size="sm"
          >
            {label}
          </Button>
        ))}
      </div>
    </div>
  )

  return mode === "chat" ? chatContent : codeContent
}

function Layout() {
  const { open, setOpen } = useSidebar()
  const { mode: workspaceMode } = useWorkspace()
  const [mode] = useState<SidebarMode>(loadMode)
  const [rightPanelOpen, setRightPanelOpen] = useState(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, mode)
  }, [mode])

  useEffect(() => {
    if (mode === "pinned") {
      setOpen(true)
    }
  }, [mode, setOpen])

  const handleSidebarMouseEnter = useCallback(() => {
    clearTimeout(hideTimer.current)
  }, [])

  const handleSidebarMouseLeave = useCallback(() => {
    if (mode === "hover") {
      hideTimer.current = setTimeout(() => setOpen(false), SIDEBAR_HIDE_DELAY)
    }
  }, [mode, setOpen])

  const handleToggleSidebar = useCallback(() => {
    setOpen(!open)
  }, [open, setOpen])

  return (
    <div className="relative flex flex-1">
      {!open && mode === "hover" && <HoverEdge />}
      <div
        onMouseEnter={handleSidebarMouseEnter}
        onMouseLeave={handleSidebarMouseLeave}
      >
        <AppSidebar />
      </div>
      <PanelGroup direction="horizontal" className="flex-1">
        <Panel defaultSize={rightPanelOpen ? 65 : 100} minSize={30}>
          <main className="flex h-full flex-col">
            <ChatHeader
              title={workspaceMode === "chat" ? "Nova conversa" : "Novo código"}
              rightPanelOpen={rightPanelOpen}
              onToggleSidebar={handleToggleSidebar}
              onToggleRightPanel={() => setRightPanelOpen(v => !v)}
            />
            <div className="flex flex-1 flex-col p-4 overflow-hidden">
              <div className="flex flex-1 items-center justify-center text-muted-foreground">
                <Placeholder />
              </div>
              {workspaceMode === "chat" ? <ChatInput /> : <CodeInput />}
            </div>
          </main>
        </Panel>
        {rightPanelOpen && (
          <>
            <PanelResizeHandle className="group relative flex items-center justify-center w-2">
              <div className="h-8 w-0.5 rounded-full bg-transparent group-hover:bg-border group-data-[resize-handle-active]:bg-border transition-colors" />
            </PanelResizeHandle>
            <Panel defaultSize={35} minSize={25} maxSize={80}>
              <div className="flex h-full flex-col pt-2 pr-2 pb-2">
                <RightPanel />
              </div>
            </Panel>
          </>
        )}
      </PanelGroup>
    </div>
  )
}

function App() {
  const [open, setOpen] = useState(false)

  return (
    <ThemeProvider defaultTheme="system" storageKey="vite-ui-theme">
      <TooltipProvider>
        <WorkspaceProvider>
          <SidebarProvider open={open} onOpenChange={setOpen}>
            <Layout />
          </SidebarProvider>
        </WorkspaceProvider>
      </TooltipProvider>
    </ThemeProvider>
  )
}

export default App
