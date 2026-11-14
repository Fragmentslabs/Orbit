import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { DndContext } from "@dnd-kit/core"

import { SidebarProvider, useSidebar } from "@/components/ui/sidebar"
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppSidebar } from "@/components/app-sidebar"
import { ThemeProvider } from "@/components/theme-provider"
import { WorkspaceProvider, useWorkspace } from "@/lib/workspace-context"
import { FolderOpen } from "lucide-react"
import { fsApi, panelApi, windowApi } from "@/src/lib/ipc"
import { resolvePanelSession } from "@/src/lib/panel-session"
import { ORPHAN_KEY, usePanelStore, type PanelEvent } from "@/src/stores/panel-store"
import { usePipelineStore } from "@/src/stores/pipeline-store"
import { useActiveSession, useSessionStore } from "@/src/stores/session-store"
import type { SessionMode } from "@shared/chat"
import { ChatHeader } from "@/src/components/chat-header"
import { ChatView } from "@/src/components/chat-view"
import { RemoteChatView } from "@/src/components/peers/remote-chat-view"
import { RemoteOffline } from "@/src/components/peers/remote-offline"
import { PairRequestCards } from "@/src/components/peers/pair-request-cards"
import { useActiveRemoteSession, usePeersStore } from "@/src/stores/peers-store"
import { MissingFoldersBanner } from "@/src/components/missing-folders-banner"
import { MemoriesView } from "@/src/components/memories/memories-view"
import { UsageRangeControls } from "@/src/components/usage/usage-range"
import { ViewScopeToggle } from "@/src/components/view-scope-toggle"
import { useAnalyticsStore } from "@/src/stores/analytics-store"
import { useViewScope } from "@/src/stores/view-scope-store"
import { PipelineBoard } from "@/src/components/pipeline/pipeline-board"
import { PipelineHeaderActions, PipelineHeaderTitle, PipelineSettingsButton } from "@/src/components/pipeline/pipeline-header"
import { RoutinesView } from "@/src/components/routines/routines-view"
import { RoutineDetailsButton, RoutineHeaderActions, RoutineHeaderTitle } from "@/src/components/routines/routine-header"
import { RoutinesNewButton } from "@/src/components/routines/routines-new-button"
import { useRoutinesStore } from "@/src/stores/routines-store"
import { ToolsView } from "@/src/components/tools-view"
import { UsageView } from "@/src/components/usage/usage-view"
import { FragmentsView } from "@/src/components/fragments/fragments-view"
import { FragmentDetailsButton, FragmentHeaderActions } from "@/src/components/fragments/fragment-header-actions"
import { FragmentHeaderTitle } from "@/src/components/fragments/fragment-header"
import { useFragmentsStore } from "@/src/stores/fragments-store"
import { RightPanel, RightPanelDropZone } from "@/src/components/right-panel"
import { useSessionDragAndDrop } from "@/src/components/session-drag"
import { ensureAgentBrowser, evictInactiveWebviews } from "@/src/components/browser/webview-session"
import { TitleBar } from "@/src/components/titlebar"
import { SettingsDialogHost } from "@/src/components/settings-dialog"
import { RotationDialogHost } from "@/src/components/models/rotation-dialog"
import { WorkspaceSearchDialog } from "@/src/components/workspace-search-dialog"
import { useWorkspaceSearchStore } from "@/src/stores/workspace-search-store"
import { ChatSearch } from "@/src/components/chat-search"
import { VoiceCallProvider } from "@/src/components/voice-call-host"
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels"
import { LinkRouter } from "@/src/components/link-router"
import { FragmentToasts } from "@/src/components/fragments/fragment-toasts"
import { WidgetPanel } from "@/src/components/widgets/widget-panel"

const HOVER_ZONE_WIDTH = 6
const SIDEBAR_HIDE_DELAY = 300
const SIDEBAR_SHOW_DELAY = 100
const STORAGE_KEY = "sidebar-mode"

type SidebarMode = "hover" | "pinned"

/** Stable reference: `?? []` in a zustand selector becomes a render loop. */
const NO_FOLDERS: string[] = []

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

/** Memories: chat, code or both — until the user picks, it follows the workspace mode. */
function PageScopeToggle({ page, workspaceMode }: { page: "memories"; workspaceMode: "chat" | "code" }) {
  const [scope, setScope] = useViewScope(page, workspaceMode)
  return <ViewScopeToggle value={scope} onChange={setScope} />
}

/** Usage: the same toggle, plus the period. */
function UsageHeaderControls() {
  const scope = useAnalyticsStore((s) => s.scope)
  const setScope = useAnalyticsStore((s) => s.setScope)
  return (
    <div className="flex shrink-0 items-center gap-3">
      <ViewScopeToggle value={scope} onChange={setScope} />
      <UsageRangeControls />
    </div>
  )
}

/**
 * A specialist subchat makes its artifact under its own id; the tab belongs in the panel
 * of the chat being looked at (the parent), not in the hidden child's bucket.
 */
function retargetToVisibleChat(event: PanelEvent, mode: SessionMode): PanelEvent {
  if (event.type !== "motion" && event.type !== "design" && event.type !== "slides" && event.type !== "fragment") return event
  if (!event.sessionId) return event
  const { sessions, activeIds } = useSessionStore.getState()
  const parents = new Map(sessions.map((s) => [s.id, s.parentId]))
  const sessionId = resolvePanelSession(event.sessionId, activeIds[mode] ?? null, (id) => parents.get(id))
  return sessionId === event.sessionId ? event : { ...event, sessionId }
}

function Layout() {
  const { t } = useTranslation()
  const { open, setOpen } = useSidebar()
  const { mode: workspaceMode, view, folders, setFolders, setMode, setView } = useWorkspace()
  const activeSession = useActiveSession(workspaceMode)
  const [mode, setModeState] = useState<SidebarMode>(loadMode)
  // The panel belongs to the CHAT, not to the window. The agent may be working in a
  // session that is not the one on the screen: the tab (and the opening) are born there, and only
  // on going back to that chat does the panel appear — nothing is opened here.
  // Another desktop in the environment selector: the panel bucket is its chat (the
  // namespaced id), so its motion/design/slides tabs live apart from the local ones.
  const peersEnv = usePeersStore((s) => s.env)
  const remoteEnv = peersEnv !== "local"
  const remoteActive = useActiveRemoteSession()
  const remotePeer = usePeersStore((s) => s.snapshot?.peers.find((p) => p.peerId === s.env))
  const activeKey = remoteEnv ? (remoteActive?.sessionId ?? ORPHAN_KEY) : (activeSession?.id ?? ORPHAN_KEY)
  const rightPanelOpen = usePanelStore((s) => s.openBySession[activeKey] ?? false)
  const setRightPanelOpen = usePanelStore((s) => s.setRightPanelOpen)
  // A fragment on screen takes the whole area (no padding) and puts back/icon/name in the header.
  const openFragmentId = useFragmentsStore((s) => s.activeId)
  const fragmentFullscreen = view === "fragments" && !!openFragmentId
  // One routine open takes the page the same way: no padding, and the header shows the routine
  // (back to the list, name, state) instead of the page title.
  const openRoutine = useRoutinesStore((s) => (s.openId ? s.routines.find((r) => r.id === s.openId) : undefined))
  const closeRoutine = useRoutinesStore((s) => s.open)
  const routineScreen = view === "routines" && !!openRoutine
  const pendingFile = useWorkspaceSearchStore((s) => s.pending)
  const hideTimer = useRef<ReturnType<typeof setTimeout>>()
  const showTimer = useRef<ReturnType<typeof setTimeout>>()
  // Current mode for the main event handler: it is registered ONCE and
  // cannot depend on the render to know which workspace the user is in.
  const modeRef = useRef(workspaceMode)
  useEffect(() => {
    modeRef.current = workspaceMode
  }, [workspaceMode])

  // Main events (panel_* tools): the agent asked for the browser — records it in the
  // store and ensures the webview in the HIDDEN HOST, without opening the panel (the UI only
  // shows up when the user clicks the "testing…" indicator).
  useEffect(() => {
    return panelApi.onEvent((event) => {
      const store = usePanelStore.getState()
      // The motion event does not carry the session (the contract is {id, entry, title}):
      // without it the tab would be born in the orphan bucket, hidden behind the open chat.
      // The bucket is the ACTIVE chat's — it is where the panel is pointed now.
      const peers = usePeersStore.getState()
      const remoteBucket = peers.env !== "local" ? (peers.activeByPeer[peers.env] ?? undefined) : undefined
      const resolved =
        (event.type === "motion" || event.type === "design" || event.type === "slides") && !event.sessionId
          ? { ...event, sessionId: remoteBucket ?? useSessionStore.getState().activeIds[modeRef.current] ?? undefined }
          : event
      store.applyEvent(retargetToVisibleChat(resolved, modeRef.current))
      if (event.type === "ensure") {
        ensureAgentBrowser(event.sessionId, event.url)
      }
    })
  }, [])

  // Eviction of unmounted/inactive webviews (agent browser in the background
  // of closed chats) — runs every 5min, TTL of 10min.
  useEffect(() => {
    const timer = setInterval(() => evictInactiveWebviews(), 5 * 60 * 1000)
    return () => clearInterval(timer)
  }, [])

  // ─── Opening a folder in code mode ─────────────────────────────────────
  // Used by Explorer's "Open with Orbit" and by folder drag & drop.
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
    // Cold open: main left the folder pending before React mounted
    void windowApi.consumePendingOpen().then((directory) => {
      if (directory) void openFolderInCode(directory)
    })
    return unsub
  }, [openFolderInCode])

  // ─── Folder drag & drop (folders only; files follow the attachment flow) ─
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

  // Memories, tools and fragments belong to the machine you are sitting at; another
  // desktop only offers chats, routines, the pipeline and usage.
  useEffect(() => {
    if (remoteEnv && (view === "memories" || view === "tools" || view === "fragments")) setView("chat")
  }, [remoteEnv, view, setView])

  useEffect(() => {
    if (workspaceMode !== "code" && workspaceMode !== "chat") setRightPanelOpen(false)
  }, [workspaceMode, setRightPanelOpen])

  // The store also needs to know which bucket the screen is showing: whoever
  // opens the panel without belonging to a session (pipeline task diff, tab
  // picked in "+") opens it in the SCREEN's panel, and writes through that bucket.
  useEffect(() => {
    usePanelStore.getState().setUiBucket(activeKey)
  }, [activeKey])

  /**
   * The palette (⌘P) may request a file with the panel CLOSED — and then RightPanel
   * is not mounted (it lives under `rightPanelOpen`), so the effect that would open
   * the panel would be inside the component that does not exist. Opening the panel belongs to the
   * App; ensuring the tab belongs to RightPanel, which starts to exist right after.
   */
  useEffect(() => {
    if (pendingFile) setRightPanelOpen(true)
  }, [pendingFile, setRightPanelOpen])

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

  // Dragging a conversation from the sidebar: opens it in the side panel or moves it
  // (folder, pinned, conversations, archived) — same animation in both cases.
  const sessionDnd = useSessionDragAndDrop(workspaceMode)

  // OPEN pipeline (on the list there is none): the pipeline mode header reflects
  // its context — folders and branch. The model sits in each phase column: each
  // phase may have its own, so there is no "one" model of the pipeline.
  const openPipeline = usePipelineStore((s) =>
    s.openPipelineId ? (s.pipelines.find((p) => p.id === s.openPipelineId) ?? null) : null,
  )
  const pipelineFolders = usePipelineStore((s) => {
    const pipeline = s.openPipelineId ? s.pipelines.find((p) => p.id === s.openPipelineId) : undefined
    return pipeline ? s.projects.find((p) => p.id === pipeline.projectId)?.folders ?? NO_FOLDERS : NO_FOLDERS
  })

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
    <VoiceCallProvider>
      <DndContext {...sessionDnd.contextProps}>
        {sessionDnd.overlay}
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
          className="relative"
          onMouseEnter={handleSidebarMouseEnter}
          onMouseLeave={handleSidebarMouseLeave}
        >
          <AppSidebar />
          {/* The handle stays mounted even when it cannot be dragged: it is what applies the
              saved width, so the sidebar opens already at the chosen size. The
              drag itself only counts with the sidebar pinned (see the component). */}
          <SidebarResizeHandle active={open && mode === "pinned"} />
        </div>
        <PanelGroup direction="horizontal" className="min-w-0 flex-1">
          <Panel className="min-w-0" defaultSize={rightPanelOpen ? 65 : 100} id="main" minSize={30} order={1}>
              <main className="relative flex h-full min-w-0 flex-col">
                <ChatHeader
                  titleSlot={
                    fragmentFullscreen && openFragmentId ? (
                      <FragmentHeaderTitle fragmentId={openFragmentId} />
                    ) : routineScreen && openRoutine ? (
                      <RoutineHeaderTitle routine={openRoutine} onBack={() => closeRoutine(null)} />
                    ) : view === "pipeline" && openPipeline ? (
                      <PipelineHeaderTitle
                        pipeline={openPipeline}
                        onBack={() => usePipelineStore.getState().setOpenPipeline(null)}
                      />
                    ) : undefined
                  }
                  title={
                    view === "memories"
                      ? t("sidebar.memories")
                      : view === "pipeline"
                        ? t("pipeline.title")
                        : view === "routines"
                          ? t("routines.title")
                          : view === "tools"
                            ? t("sidebar.tools")
                            : view === "analytics"
                              ? t("analytics.title")
                              : view === "fragments"
                                ? t("fragments.title")
                                : remoteEnv
                                ? remoteActive?.session?.title ?? (workspaceMode === "chat" ? t("header.newChat") : t("header.newCode"))
                                : activeSession?.title ?? (workspaceMode === "chat" ? t("header.newChat") : t("header.newCode"))
                  }
                  // The menu works in both modes: pin, rename, archive,
                  // delete and search belong to the SESSION, and the sidebar already offers them
                  // for a code conversation through the row menu.
                  hasMenu={!remoteEnv && view === "chat" && !!activeSession}
                  showAgent={!remoteEnv && view === "chat"}
                  session={!remoteEnv && view === "chat" ? activeSession : undefined}
                  // Agent browser indicator: works in both modes of the
                  // conversation (chat and code), since the browser tools are
                  // keyed by the session id, not by the mode.
                  sessionId={!remoteEnv && view === "chat" ? activeSession?.id : undefined}
                  rightPanelOpen={rightPanelOpen}
                  onToggleSidebar={handleToggleSidebar}
                  onToggleRightPanel={workspaceMode === "code" || workspaceMode === "chat" ? () => setRightPanelOpen(!rightPanelOpen) : undefined}
                  repoPath={remoteEnv ? undefined : view === "pipeline" || view === "routines" || view === "memories" || view === "analytics" || view === "fragments" ? undefined : folders[0]}
                  workspaceMode={workspaceMode}
                  onRequestAgentAction={onRequestAgentAction}
                  // On the Pipeline page the header follows the OPEN pipeline,
                  // not the chat's folders: on the list no pipeline is chosen yet,
                  // and showing folder/branch there would suggest a context that
                  // does not exist. On the Routines page the folder is chosen
                  // INSIDE the creation dialog (one per routine) — the header has
                  // no "screen" folder to show.
                  folders={
                    remoteEnv
                      ? undefined
                      : view === "pipeline"
                      ? pipelineFolders.length
                        ? pipelineFolders
                        : undefined
                      : view === "routines" || view === "memories" || view === "analytics" || view === "fragments"
                        ? undefined
                        : workspaceMode === "code"
                          ? folders
                          : undefined
                  }
                  // The Memories page has no project or branch in the header (that is
                  // the conversation's context): it only says WHICH memories are showing.
                  extra={
                    routineScreen && openRoutine ? (
                      <RoutineHeaderActions routine={openRoutine} />
                    ) : view === "routines" ? (
                      <RoutinesNewButton />
                    ) : view === "memories" ? (
                      <PageScopeToggle page="memories" workspaceMode={workspaceMode} />
                    ) : view === "analytics" ? (
                      <UsageHeaderControls />
                    ) : fragmentFullscreen && openFragmentId ? (
                      <FragmentHeaderActions fragmentId={openFragmentId} />
                    ) : view === "pipeline" && openPipeline ? (
                      <PipelineHeaderActions pipeline={openPipeline} />
                    ) : undefined
                  }
                  // The screen's own settings, right before the panel button: the routine's
                  // panel and the fragment's details keep the same place on every screen.
                  endActions={
                    routineScreen && openRoutine ? (
                      <RoutineDetailsButton />
                    ) : fragmentFullscreen && openFragmentId ? (
                      <FragmentDetailsButton fragmentId={openFragmentId} />
                    ) : view === "pipeline" && openPipeline ? (
                      <PipelineSettingsButton />
                    ) : undefined
                  }
                  onFoldersChange={
                    remoteEnv || view === "pipeline" || view === "routines" || view === "memories" || view === "analytics" || view === "fragments"
                      ? undefined
                      : workspaceMode === "code"
                        ? setFolders
                        : undefined
                  }
                />
                <div className={`flex min-w-0 flex-1 flex-col overflow-hidden ${fragmentFullscreen || routineScreen || view === "routines" ? "" : "p-4"}`} style={{ '--panel-bg': 'var(--background)' } as React.CSSProperties}>
                  {remoteEnv ? null : <MissingFoldersBanner />}
                  {remoteEnv && remotePeer && !remotePeer.online && view !== "chat" ? (
                    <RemoteOffline name={remotePeer.name} error={remotePeer.error} />
                  ) : remoteEnv && view === "routines" ? (
                    <RoutinesView />
                  ) : remoteEnv && view === "pipeline" ? (
                    <PipelineBoard />
                  ) : remoteEnv && view === "analytics" ? (
                    <UsageView />
                  ) : remoteEnv ? (
                    <RemoteChatView />
                  ) : view === "memories" ? (
                    <MemoriesView />
                  ) : view === "pipeline" ? (
                    <PipelineBoard />
                  ) : view === "routines" ? (
                    <RoutinesView />
                  ) : view === "tools" ? (
                    <ToolsView />
                  ) : view === "analytics" ? (
                    <UsageView />
                  ) : view === "fragments" ? (
                    <FragmentsView />
                  ) : (
                    <ChatView />
                  )}
                </div>
                {/* The widget board lives on the right edge of a conversation — and only
                    while the side panel is closed, which is the strip it would share. */}
                {!remoteEnv && view === "chat" && !rightPanelOpen && <WidgetPanel />}
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
      <PairRequestCards />
      </DndContext>
    </VoiceCallProvider>
  )
}

function App() {
  const [open, setOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)

  // Ctrl+Space opens the global search
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.code === "Space" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        setSearchOpen((v) => !v)
      }
      // ⌘P searches the code of any tab: the palette exists to bring what
      // is not in sight, so tying it to the files tab would make the shortcut
      // go silent exactly when it is most useful. Whoever opens the tab is the panel,
      // on receiving the request from the result.
      if (e.code === "KeyP" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault()
        useWorkspaceSearchStore.getState().toggle()
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
            <WorkspaceSearchDialog />
            <SettingsDialogHost />
            <LinkRouter />
            {/* Notifications scheduled by fragments: over any screen, with the fragment's icon. */}
            <FragmentToasts />
            <RotationDialogHost />
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