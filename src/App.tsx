import { useCallback, useEffect, useRef, useState } from "react"

import { SidebarProvider, useSidebar } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppSidebar } from "@/components/app-sidebar"
import { ThemeProvider } from "@/components/theme-provider"
import { WorkspaceProvider, useWorkspace } from "@/lib/workspace-context"
import { useActiveSession } from "@/src/stores/session-store"
import { ChatHeader } from "@/src/components/chat-header"
import { ChatView } from "@/src/components/chat-view"
import { RightPanel } from "@/src/components/right-panel"
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

function HoverEdge({ onShow }: { onShow: () => void }) {
  return (
    <div
      className="absolute left-0 top-0 z-50 h-full"
      style={{ width: HOVER_ZONE_WIDTH }}
      onMouseEnter={onShow}
    />
  )
}

function Layout() {
  const { open, setOpen } = useSidebar()
  const { mode: workspaceMode } = useWorkspace()
  const activeSession = useActiveSession(workspaceMode)
  const [mode, setMode] = useState<SidebarMode>(loadMode)
  const [rightPanelOpen, setRightPanelOpen] = useState(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout>>()
  const showTimer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, mode)
  }, [mode])

  // Restore the open state on mount only, based on the persisted mode.
  useEffect(() => {
    if (mode === "pinned") setOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (workspaceMode !== "code") setRightPanelOpen(false)
  }, [workspaceMode])

  const handleHoverShow = useCallback(() => {
    clearTimeout(showTimer.current)
    showTimer.current = setTimeout(() => setOpen(true), SIDEBAR_SHOW_DELAY)
  }, [setOpen])

  const handleSidebarMouseEnter = useCallback(() => {
    clearTimeout(hideTimer.current)
  }, [])

  const handleSidebarMouseLeave = useCallback(() => {
    if (mode === "hover") {
      hideTimer.current = setTimeout(() => setOpen(false), SIDEBAR_HIDE_DELAY)
    }
  }, [mode, setOpen])

  const handleToggleSidebar = useCallback(() => {
    clearTimeout(hideTimer.current)
    clearTimeout(showTimer.current)
    if (open) {
      setMode("hover")
      setOpen(false)
    } else {
      setMode("pinned")
      setOpen(true)
    }
  }, [open, setOpen])

  return (
    <div className="relative flex min-w-0 flex-1">
      {!open && mode === "hover" && <HoverEdge onShow={handleHoverShow} />}
      <div
        onMouseEnter={handleSidebarMouseEnter}
        onMouseLeave={handleSidebarMouseLeave}
      >
        <AppSidebar />
      </div>
      <PanelGroup direction="horizontal" className="min-w-0 flex-1">
        <Panel className="min-w-0" defaultSize={rightPanelOpen ? 65 : 100} id="main" minSize={30} order={1}>
            <main className="flex h-full min-w-0 flex-col">
              <ChatHeader
                title={activeSession?.title ?? (workspaceMode === "chat" ? "Nova conversa" : "Novo código")}
                rightPanelOpen={rightPanelOpen}
                onToggleSidebar={handleToggleSidebar}
                onToggleRightPanel={workspaceMode === "code" ? () => setRightPanelOpen(v => !v) : undefined}
              />
              <div className="flex min-w-0 flex-1 flex-col overflow-hidden p-4">
                <ChatView />
              </div>
            </main>
        </Panel>
        {rightPanelOpen && (
          <>
            <PanelResizeHandle className="group relative flex items-center justify-center w-2">
              <div className="h-8 w-0.5 rounded-full bg-transparent group-hover:bg-border group-data-[resize-handle-active]:bg-border transition-colors" />
            </PanelResizeHandle>
            <Panel className="min-w-0" defaultSize={35} id="right-panel" maxSize={80} minSize={30} order={2}>
              <div className="flex h-full min-w-0 flex-col pt-2 pr-2 pb-2">
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
          <SidebarProvider className="h-svh overflow-hidden" open={open} onOpenChange={setOpen}>
            <Layout />
          </SidebarProvider>
        </WorkspaceProvider>
      </TooltipProvider>
    </ThemeProvider>
  )
}

export default App
