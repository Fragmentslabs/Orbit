import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core"

import { SidebarProvider, useSidebar } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppSidebar } from "@/components/app-sidebar"
import { ThemeProvider } from "@/components/theme-provider"
import { WorkspaceProvider, useWorkspace } from "@/lib/workspace-context"
import { FolderOpen } from "lucide-react"
import { fsApi, panelApi, windowApi } from "@/src/lib/ipc"
import { usePanelStore } from "@/src/stores/panel-store"
import { useActiveSession, useSessionStore } from "@/src/stores/session-store"
import { ChatHeader } from "@/src/components/chat-header"
import { ChatView } from "@/src/components/chat-view"
import { MemoriesView } from "@/src/components/memories/memories-view"
import { ModelsView } from "@/src/components/models/models-view"
import { RightPanel, RightPanelDropZone } from "@/src/components/right-panel"
import { TitleBar } from "@/src/components/titlebar"
import { ChatSearch } from "@/src/components/chat-search"
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
  const { t } = useTranslation()
  const { open, setOpen } = useSidebar()
  const { mode: workspaceMode, view, folders, setFolders, setMode, setView } = useWorkspace()
  const activeSession = useActiveSession(workspaceMode)
  const [mode, setModeState] = useState<SidebarMode>(loadMode)
  const rightPanelOpen = usePanelStore((s) => s.rightPanelOpen)
  const setRightPanelOpen = usePanelStore((s) => s.setRightPanelOpen)
  const hideTimer = useRef<ReturnType<typeof setTimeout>>()
  const showTimer = useRef<ReturnType<typeof setTimeout>>()
  // Eventos do main (tools panel_*): abre o painel/aba Browser automaticamente
  useEffect(() => {
    return panelApi.onEvent((event) => usePanelStore.getState().applyEvent(event))
  }, [])

  // ─── Abertura de pasta no modo código ─────────────────────────────────────
  // Usada pelo "Abrir com Orbit" do Explorer e pelo drag & drop de pastas.
  const openFolderInCode = useCallback(
    async (directory: string) => {
      await useSessionStore.getState().createSession("code", { directory, setActive: true })
      setMode("code")
      setView("chat")
      setFolders([directory])
    },
    [setMode, setView, setFolders],
  )

  useEffect(() => {
    const unsub = windowApi.onOpenFolder((directory) => void openFolderInCode(directory))
    // Abertura fria: o main deixou a pasta pendente antes do React montar
    void windowApi.consumePendingOpen().then((directory) => {
      if (directory) void openFolderInCode(directory)
    })
    return unsub
  }, [openFolderInCode])

  // ─── Drag & drop de pastas (só pastas; arquivos seguem o fluxo de anexo) ─
  const [draggingFolder, setDraggingFolder] = useState(false)
  const dragDepth = useRef(0)

  const isFolderDrag = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return false
    const item = e.dataTransfer.items?.[0]
    const entry = item?.webkitGetAsEntry?.()
    return !!entry?.isDirectory
  }, [])

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (!isFolderDrag(e)) return
      e.preventDefault()
      dragDepth.current += 1
      setDraggingFolder(true)
    },
    [isFolderDrag],
  )

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!isFolderDrag(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = "copy"
    },
    [isFolderDrag],
  )

  const handleDragLeave = useCallback(
    (e: React.DragEvent) => {
      if (!isFolderDrag(e)) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDraggingFolder(false)
    },
    [isFolderDrag],
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      if (!isFolderDrag(e)) return
      e.preventDefault()
      dragDepth.current = 0
      setDraggingFolder(false)
      const file = e.dataTransfer.files?.[0]
      if (!file) return
      const filePath = window.getPathForFile(file)
      if (!filePath) return
      void fsApi.stat(filePath).then((stat) => {
        if (stat.ok && stat.isDirectory) void openFolderInCode(filePath)
      })
    },
    [isFolderDrag, openFolderInCode],
  )

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, mode)
  }, [mode])

  // Restore the open state on mount only, based on the persisted mode.
  useEffect(() => {
    if (mode === "pinned") setOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (workspaceMode !== "code" && workspaceMode !== "chat") setRightPanelOpen(false)
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
      setModeState("hover")
      setOpen(false)
    } else {
      setModeState("pinned")
      setOpen(true)
    }
  }, [open, setOpen])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  )

  const handleDragStart = useCallback(() => {
  }, [])

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    if (event.over?.id === "right-panel-drop-zone") {
      const data = event.active.data.current as { sessionId: string; title: string } | undefined
      if (data?.sessionId) {
        const sessionStore = useSessionStore.getState()
        if (sessionStore.activeIds[workspaceMode] === data.sessionId) {
          sessionStore.createSession(workspaceMode, { setActive: true })
        }
        usePanelStore.getState().openChatTab(data.sessionId, data.title)
      }
    }
  }, [workspaceMode])

  const onRequestAgentAction = useCallback((instruction: string) => {
    const activeId = useSessionStore.getState().activeIds["code"]
    if (!activeId) return
    useSessionStore.getState().sendMessage("code", instruction, {
      options: { simple: true },
      sessionId: activeId,
      directory: folders[0],
      extraDirectories: folders.slice(1),
    })
  }, [folders])

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div
        className="relative flex min-w-0 flex-1"
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {draggingFolder && (
          <div className="pointer-events-none absolute inset-0 z-[100] flex items-center justify-center bg-background/80 backdrop-blur-sm">
            <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-background px-8 py-6 shadow-lg">
              <FolderOpen className="size-8 text-primary" />
              <p className="text-sm font-medium">{t("openFolder.overlayTitle")}</p>
              <p className="text-xs text-muted-foreground">{t("openFolder.overlayHint")}</p>
            </div>
          </div>
        )}
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
                  title={
                    view === "memories"
                      ? t("sidebar.memories")
                      : view === "models"
                        ? t("header.models")
                        : activeSession?.title ?? (workspaceMode === "chat" ? t("header.newChat") : t("header.newCode"))
                  }
                  hasMenu={view === "chat" && workspaceMode === "chat" && !!activeSession}
                  session={view === "chat" && workspaceMode === "chat" ? activeSession : undefined}
                  rightPanelOpen={rightPanelOpen}
                  onToggleSidebar={handleToggleSidebar}
                  onToggleRightPanel={workspaceMode === "code" || workspaceMode === "chat" ? () => setRightPanelOpen(!rightPanelOpen) : undefined}
                  repoPath={folders[0]}
                  workspaceMode={workspaceMode}
                  onRequestAgentAction={onRequestAgentAction}
                  folders={workspaceMode === "code" ? folders : undefined}
                  onFoldersChange={workspaceMode === "code" ? setFolders : undefined}
                />
                <div className="flex min-w-0 flex-1 flex-col overflow-hidden p-4" style={{ '--panel-bg': 'var(--background)' } as React.CSSProperties}>
                  {view === "memories" ? <MemoriesView /> : view === "models" ? <ModelsView /> : <ChatView />}
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
        {!rightPanelOpen && <RightPanelDropZone />}
      </div>
    </DndContext>
  )
}

function App() {
  const [open, setOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)

  // Ctrl+Space abre a busca global
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.code === "Space" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        setSearchOpen((v) => !v)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  return (
    <ThemeProvider defaultTheme="system" storageKey="vite-ui-theme">
      <TooltipProvider>
        <WorkspaceProvider>
          <div className="flex h-svh flex-col overflow-hidden">
            <TitleBar onSearchOpen={() => setSearchOpen(true)} />
            <ChatSearch open={searchOpen} onOpenChange={setSearchOpen} />
            <SidebarProvider className="min-h-0 flex-1 overflow-hidden" open={open} onOpenChange={setOpen}>
              <Layout />
            </SidebarProvider>
          </div>
        </WorkspaceProvider>
      </TooltipProvider>
    </ThemeProvider>
  )
}

export default App