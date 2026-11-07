import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useDroppable, useDndContext } from "@dnd-kit/core"
import { Brain, CalendarClock, Clapperboard, CodeXml, FileCode, FileText, Globe, Folder, Images, LayoutGrid, Library, Play, Presentation, Quote, MessageSquare, MessagesSquare, Terminal, X, PlusIcon, Loader2, Trash2, GripVertical } from "lucide-react"
import { ChatView } from "@/src/components/chat-view"
import { ChatInput } from "@/src/components/chat-input"
import { BranchSelector } from "@/src/components/branch-selector"
import { FolderSelector } from "@/src/components/folder-selector"
import { CompactWorkspaceSelector } from "@/src/components/workspace-selector-compact"
import type { SendMessageOptions, FilePart } from "@shared/chat"
import { ManagedTerminalTab } from "@/src/components/terminal-tab"
import { BrowserTab } from "@/src/components/browser-tab"
import { destroyWebview } from "@/src/components/browser/webview-session"
import { FoldersTab } from "@/src/components/folders-tab"
import { DiffTab } from "@/src/components/diff-tab"
import { MediaGallery } from "@/src/components/media-gallery"
import { CreateCards, RecentMedia } from "@/src/components/panel-hub"
import { openMediaEntryInPanel } from "@/src/lib/open-media-entry"
import { ProcessTab } from "@/src/components/process-tab"
import { ArtifactTab } from "@/src/components/artifact-tab"
import { MotionTab } from "@/src/components/motion-tab"
import { DesignTab } from "@/src/components/design-tab"
import { SlidesTab } from "@/src/components/slides-tab"
import { DocumentTab } from "@/src/components/document-tab"
import { SourcesTab } from "@/src/components/sources-tab"
import { SourceViewer } from "@/src/components/source-viewer"
import { MemoryTab } from "@/src/components/memory-tab"
import { RoutineTab } from "@/src/components/routines/routine-tab"
import { Hint } from "@/components/ui/hint"
import { Truncate, TruncatedText } from "@/components/ui/truncated-text"

import { useWorkspace, type WorkspaceMode } from "@/lib/workspace-context"
import { usePanelStore, nextTabId, ORPHAN_KEY, type TabType, type PanelTab } from "@/src/stores/panel-store"
import { useSessionStore } from "@/src/stores/session-store"
import { useProcessStore } from "@/src/stores/process-store"
import { useTerminalStore } from "@/src/stores/terminal-store"
import { useAppearanceStore } from "@/src/stores/appearance-store"
import { useWorkspaceSearchStore } from "@/src/stores/workspace-search-store"
import { cn } from "@/lib/utils"

interface TabMeta {
  icon: typeof MessageSquare
  label: string
  description: string
}

/**
 * The tab types the user can open empty, through the selector.
 *
 * "artifact" never enters: an artifact tab only exists pointing at an
 * artifact (it opens through the card in the conversation or through the gallery), never empty — and
 * "source" (singular, the viewer of a cited source) for the same reason.
 *
 * Code mode has everything; chat has the subset that makes sense without a working
 * folder. "sources" is in both: in code the repository is the corpus
 * of the FILES — `read` and `grep` already open PDF, DOCX and spreadsheet from there — but
 * site and pasted text are not in the repository and are precisely the material
 * that cannot be committed. The agent already receives the document tools and the
 * instruction about `srcN` in code mode (electron/lib/tools/index.ts and
 * prompts.ts): it was only the tab that was missing for the user to be able to declare a source.
 */
function isSelectableTab(type: TabType, mode: WorkspaceMode): boolean {
  // "process" also never enters: a process tab only exists following a
  // process that is already running (it opens through the card in the selector footer).
  //
  // "diff" left with them: it only exists pointing at ONE chat message or ONE
  // pipeline task. The CURRENT changes are read in the folders tab (Changes),
  // and the diff of a turn is conversation context — not a tab that opens empty.
  // "motion" and "design" neither: the preview exists for ONE registered piece and
  // is born from the event the agent fires when registering it (motion_preview /
  // design_write), never empty — like the artifact.
  if (
    type === "artifact" ||
    type === "source" ||
    type === "document" ||
    type === "process" ||
    type === "diff" ||
    type === "motion" ||
    type === "design" ||
    type === "slides" ||
    // "memory" also only exists pointing at a memory — it is born from the click
    // on the citation, inside the conversation. "routine" is the same: it is born from the
    // click on a routine in the Routines page.
    type === "memory" ||
    type === "routine"
  )
    return false
  if (mode === "code") return true
  // "browser" enters chat: the browser does not depend on a working folder (the
  // input's "browser" mode already counts in both modes, and the server list comes from the session).
  return type === "chat" || type === "media" || type === "sources" || type === "browser"
}

function useTabMeta(): Record<TabType, TabMeta> {
  const { t } = useTranslation()
  return {
    chat: { icon: MessageSquare, label: t("panel.tabs.chat.label"), description: t("panel.tabs.chat.description") },
    terminal: { icon: Terminal, label: t("panel.tabs.terminal.label"), description: t("panel.tabs.terminal.description") },
    process: { icon: Loader2, label: t("panel.tabs.process.label"), description: t("panel.tabs.process.description") },
    folders: { icon: Folder, label: t("panel.tabs.folders.label"), description: t("panel.tabs.folders.description") },
    browser: { icon: Globe, label: t("panel.tabs.browser.label"), description: t("panel.tabs.browser.description") },
    diff: { icon: FileCode, label: t("panel.tabs.diff.label"), description: t("panel.tabs.diff.description") },
    media: { icon: Images, label: t("panel.tabs.media.label"), description: t("panel.tabs.media.description") },
    artifact: { icon: CodeXml, label: t("panel.tabs.artifact.label"), description: t("panel.tabs.artifact.description") },
    sources: { icon: Library, label: t("panel.tabs.sources.label"), description: t("panel.tabs.sources.description") },
    source: { icon: Quote, label: t("panel.tabs.source.label"), description: t("panel.tabs.source.description") },
    document: { icon: FileText, label: t("panel.tabs.document.label"), description: t("panel.tabs.document.description") },
    motion: { icon: Clapperboard, label: t("panel.tabs.motion.label"), description: t("panel.tabs.motion.description") },
    design: { icon: LayoutGrid, label: t("panel.tabs.design.label"), description: t("panel.tabs.design.description") },
    slides: { icon: Presentation, label: t("panel.tabs.slides.label"), description: t("panel.tabs.slides.description") },
    memory: { icon: Brain, label: t("panel.tabs.memory.label"), description: t("panel.tabs.memory.description") },
    routine: { icon: CalendarClock, label: t("panel.tabs.routine.label"), description: t("panel.tabs.routine.description") },
  }
}

function NewChatTab({ onCreated }: { onCreated: (sessionId: string) => void }) {
  const { t } = useTranslation()
  // The folders of the tab are born like the screen's (the new chat would start the same as the
  // main panel's), but they change only here: the draft of a tab is not a
  // folder association of the chat that is open in the window.
  const { folders: screenFolders } = useWorkspace()
  const [folders, setFolders] = useState<string[]>(screenFolders)
  const handleSubmit = async (text: string, options: SendMessageOptions, files?: FilePart[]) => {
    if (folders.length > 0) {
      // Mirrors the main panel: a new chat with a folder becomes a code session
      const [directory, ...extraDirectories] = folders
      const newSession = await useSessionStore.getState().createSession("code", { setActive: false, directory, extraDirectories })
      onCreated(newSession.id)
      await useSessionStore.getState().sendMessage("code", text, { options, sessionId: newSession.id, directory, extraDirectories, files })
    } else {
      const newSession = await useSessionStore.getState().createSession("chat", { setActive: false })
      onCreated(newSession.id)
      await useSessionStore.getState().sendMessage("chat", text, { options, sessionId: newSession.id, files })
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden p-4" style={{ '--panel-bg': 'var(--sidebar)' } as React.CSSProperties}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-1.5">
        <FolderSelector folders={folders} onFoldersChange={setFolders} />
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        <div className="flex flex-col items-center gap-2">
          <p className="text-lg font-medium text-foreground">{t("panel.newChat.title")}</p>
          <p className="text-sm text-muted-foreground">{t("panel.newChat.subtitle")}</p>
        </div>
      </div>
      <ChatInput onSubmit={handleSubmit} draftKey="panel" />
    </div>
  )
}

/** Header of a chat opened in a tab: name + folder + branch, like the main panel header */
function ChatTabHeader({ sessionId }: { sessionId?: string }) {
  const session = useSessionStore((s) => (sessionId ? s.sessions.find((x) => x.id === sessionId) : undefined))
  const setSessionDirectories = useSessionStore((s) => s.setSessionDirectories)
  const folders = useMemo(() => {
    if (!session?.directory) return []
    return [session.directory, ...(session.extraDirectories ?? [])]
  }, [session])

  const handleAgentAction = useCallback((instruction: string) => {
    if (!sessionId) return
    const s = useSessionStore.getState().sessions.find((x) => x.id === sessionId)
    void useSessionStore.getState().sendMessage("code", instruction, {
      options: { simple: true },
      sessionId,
      directory: s?.directory,
      extraDirectories: s?.extraDirectories,
    })
  }, [sessionId])

  if (!session) return null

  const isCode = session.mode === "code" && !!session.directory

  // The association belongs to the tab session — the workspace is the main window's and
  // cannot start pointing at the folders from here.
  const handleFoldersChange = (next: string[]) => {
    setSessionDirectories(session.id, next[0], next.slice(1))
  }

  return (
    // z-20: `@container` creates a stacking context (layout containment), so
    // without it the folders dropdown stays trapped below the gradient at the top of the chat.
    // `bg-sidebar` + `shrink-0`: the conversation here has no veil, and without its own
    // background what passed under the header (message scrolling, card)
    // appeared behind the title and the folder chip.
    <div className="@container relative z-20 flex min-w-0 shrink-0 items-center gap-2 bg-sidebar px-1 pb-2">
      <Truncate text={session.title}>
        <span className="min-w-0 truncate text-sm font-medium text-foreground">{session.title}</span>
      </Truncate>
      <div className="hidden min-w-0 items-center gap-2 @xl:flex">
        {isCode && session.directory && <BranchSelector repoPath={session.directory} onRequestAgentAction={handleAgentAction} />}
        {folders.length > 0 && <FolderSelector folders={folders} onFoldersChange={handleFoldersChange} compact />}
      </div>
      <div className="flex min-w-0 items-center @xl:hidden">
        <CompactWorkspaceSelector
          repoPath={isCode ? session.directory : undefined}
          folders={folders}
          onFoldersChange={handleFoldersChange}
          onRequestAgentAction={handleAgentAction}
        />
      </div>
    </div>
  )
}

function TerminalTabContent({ tabId, sessionId }: { tabId: string; sessionId?: string }) {
  const { t } = useTranslation()
  const terminalEntry = useTerminalStore((s) => s.entries[tabId])
  if (!terminalEntry) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        {t("panel.terminalNotFound")}
      </div>
    )
  }
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <ManagedTerminalTab ptyId={terminalEntry.ptyId} sessionId={sessionId} />
    </div>
  )
}

function TabContent({ tab, sessionId, onUpdateTab }: { tab: PanelTab; sessionId?: string; onUpdateTab: (id: string, updates: Partial<PanelTab>) => void }) {
  switch (tab.type) {
    case "chat":
      if (tab.pending) {
        return <NewChatTab onCreated={(sessionId) => onUpdateTab(tab.id, { pending: false, sessionId })} />
      }
      return (
        <div className="flex flex-1 flex-col overflow-hidden px-4 pt-2 pb-4" style={{ '--panel-bg': 'var(--sidebar)' } as React.CSSProperties}>
          <ChatTabHeader sessionId={tab.sessionId} />
          <ChatView sessionId={tab.sessionId} embedded />
        </div>
      )
    case "terminal":
      return <TerminalTabContent tabId={tab.id} sessionId={sessionId} />
    case "process":
      return <ProcessTab pid={tab.processPid ?? 0} sessionId={tab.sessionId ?? sessionId} />
    case "folders":
      return (
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <FoldersTab />
        </div>
      )
    case "browser":
      return (
        <div className="flex flex-1 flex-col overflow-hidden">
          <BrowserTab
            initialUrl={tab.url}
            sessionId={tab.sessionId ?? sessionId}
            // Key of the webview in the pool (webview-session.ts). One per tab and per
            // chat: each tab has its own page, and going back to the chat resumes the
            // URL from where it stopped. Always defined — it is the pool that handles console,
            // navigation and selection mode.
            persistKey={`${sessionId ?? "__orphan__"}:${tab.id}`}
            onUrlChange={(url) => onUpdateTab(tab.id, { url })}
          />
        </div>
      )
    case "diff":
      return (
        <div className="flex flex-1 flex-col overflow-hidden p-4">
          <DiffTab
            sessionId={tab.sessionId}
            messageId={tab.messageId}
            pipelineId={tab.pipelineId}
            taskId={tab.taskId}
          />
        </div>
      )
    case "media":
      return (
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <MediaGallery />
        </div>
      )
    case "artifact":
      return (
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <ArtifactTab artifactId={tab.artifactId} title={tab.title} />
        </div>
      )
    case "motion":
      return (
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <MotionTab
            motionId={tab.motionId}
            entry={tab.motionEntry}
            path={tab.motionPath}
            title={tab.title}
            sessionId={tab.sessionId ?? sessionId}
          />
        </div>
      )
    case "slides":
      return (
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <SlidesTab slidesId={tab.slidesId} entry={tab.slidesEntry} title={tab.title} />
        </div>
      )
    case "design":
      return (
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <DesignTab
            designId={tab.designId}
            title={tab.title}
            path={tab.designPath}
            playFile={tab.designPlay}
            playFullscreen={tab.designFullscreen}
            sessionId={tab.sessionId ?? sessionId}
          />
        </div>
      )
    case "document":
      return (
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <DocumentTab
            documentId={tab.documentId}
            title={tab.title}
            sessionId={tab.sessionId ?? sessionId}
          />
        </div>
      )
    case "sources":
      return (
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <SourcesTab sessionId={tab.sessionId ?? sessionId} />
        </div>
      )
    case "memory":
      return (
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <MemoryTab memoryId={tab.memoryId} sessionId={tab.sessionId ?? sessionId} />
        </div>
      )
    case "routine":
      return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <RoutineTab routineId={tab.routineId} tabId={tab.id} sessionId={tab.sessionId ?? sessionId} />
        </div>
      )
    case "source":
      return (
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <SourceViewer
            sessionId={tab.sessionId ?? sessionId}
            docId={tab.sourceDocId}
            page={tab.sourcePage}
            fromLine={tab.sourceFromLine}
            toLine={tab.sourceToLine}
          />
        </div>
      )
  }
}

export function RightPanelDropZone() {
  const { t } = useTranslation()
  const { active } = useDndContext()
  const { setNodeRef, isOver } = useDroppable({ id: "right-panel-drop-zone" })
  const isDragging = active !== null

  if (!isDragging) return null

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "absolute right-0 top-0 bottom-0 z-50 flex flex-col items-center justify-center transition-all duration-200 rounded-l-xl border-2 border-dashed ml-0.5",
        isOver
          ? "w-[30%] border-primary/50 bg-primary/10"
          : "w-[25%] border-sidebar-border bg-sidebar/80",
      )}
    >
      <div className="flex flex-col items-center gap-2 text-primary">
        <GripVertical className="size-6" />
        <span className="text-sm font-medium whitespace-nowrap">{t("panel.dropToOpen")}</span>
      </div>
    </div>
  )
}

function SelectorScreen({ onSelect }: { onSelect: (type: TabType) => void }) {
  const { t } = useTranslation()
  const tabMeta = useTabMeta()
  const { mode, folders } = useWorkspace()
  const activeId = useSessionStore((s) => s.activeIds[mode])

  const allProcesses = useProcessStore((s) => s.allProcesses)
  const fetchAllProcesses = useProcessStore((s) => s.fetchAll)
  const killProcess = useProcessStore((s) => s.kill)
  // Bucket of tabs of the active session (or the orphan one, in the new chat still without a session):
  // the process tab opened here needs to fall into the same bucket as the rest.
  const bucketKey = activeId ?? ORPHAN_KEY

  // Scope of the footer: only this conversation (default) or all chats. It stays in
  // localStorage because the selector unmounts when a tab opens — without that the mode
  // would go back to the default on every navigation.
  const [scope, setScope] = useState<"chat" | "all">(() =>
    localStorage.getItem("orbit.panel.processScope") === "all" ? "all" : "chat",
  )
  const changeScope = useCallback((next: "chat" | "all") => {
    setScope(next)
    localStorage.setItem("orbit.panel.processScope", next)
  }, [])

  // Only the processes of THIS conversation, taken from the GLOBAL list — it is the same list
  // the main process would return filtered by session. Filtering at draw time
  // guarantees that the "this chat" mode does not show a process of another chat even if
  // another consumer of the store swaps the list.
  const ownProcesses = useMemo(
    () => (activeId ? allProcesses.filter((p) => p.sessionId === activeId) : []),
    [allProcesses, activeId],
  )

  // In global mode, the ones of this conversation on top; the ones of other chats after.
  const visibleProcesses = useMemo(() => {
    if (scope === "chat") return ownProcesses
    return [...allProcesses].sort(
      (a, b) => (a.sessionId === activeId ? 0 : 1) - (b.sessionId === activeId ? 0 : 1),
    )
  }, [scope, ownProcesses, allProcesses, activeId])

  const availableTabs = useMemo(
    () =>
      (Object.entries(tabMeta) as [TabType, TabMeta][]).filter(([type]) =>
        isSelectableTab(type, mode),
      ),
    [mode, tabMeta],
  )

  // The footer fetches the GLOBAL list (unfiltered) on purpose: the "this chat" mode
  // is filtered right above, and it is that same list that supports the "all chats" one.
  // Fetching unfiltered was what the store avoided; now it is explicit (fetchAll) and
  // each row says whether it belongs to this chat or to another.
  useEffect(() => {
    fetchAllProcesses()
    const interval = setInterval(fetchAllProcesses, 3_000)
    return () => clearInterval(interval)
  }, [fetchAllProcesses])

  return (
    <div className="@container flex flex-1 flex-col overflow-hidden">
      <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-5 py-6">
        <CreateCards />
        <RecentMedia
          onOpenEntry={(entry) => openMediaEntryInPanel(entry, bucketKey)}
          onSeeAll={() => onSelect("media")}
        />
        <section className="flex flex-col gap-2.5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("panel.hub.open")}</p>
          <div className="grid grid-cols-2 gap-2 @[30rem]:grid-cols-3">
            {availableTabs.map(([type, { icon: Icon, label, description }]) => {
              // Folders follow the repository selected in the workspace: with no active
              // chat it is still possible to open (new chat), as long as there is a project.
              const isDisabled = folders.length === 0 && type === "folders"
              return (
                <button
                  key={type}
                  disabled={isDisabled}
                  onClick={() => onSelect(type)}
                  className={cn(
                    "flex flex-col items-center gap-1.5 rounded-xl border border-sidebar-border bg-card px-2 py-3.5 text-center transition-colors",
                    isDisabled
                      ? "opacity-40 cursor-not-allowed"
                      : "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground cursor-pointer",
                  )}
                >
                  <Icon className="size-5 shrink-0" />
                  <span className="text-xs font-medium">{label}</span>
                  <span className="text-[10px] leading-tight text-muted-foreground line-clamp-2">{description}</span>
                </button>
              )
            })}
          </div>
        </section>
      </div>

      {allProcesses.length === 0 ? (
        <div className="flex shrink-0 items-center gap-2 border-t border-sidebar-border px-4 py-2.5 text-[11px] text-muted-foreground">
          <span className="flex-1">{t("panel.processes.title")}</span>
          <span>{t("panel.processes.none")}</span>
        </div>
      ) : (
        <div className="flex max-h-56 shrink-0 flex-col border-t border-sidebar-border">
          <div className="flex items-center gap-2 px-3 pt-2 pb-1">
            <p className="text-[11px] font-medium text-muted-foreground">{t("panel.processes.title")}</p>
            <span className="text-[10px] text-muted-foreground/70">{visibleProcesses.length}</span>
            <div className="ml-auto inline-flex items-center gap-0.5 rounded-md border border-sidebar-border bg-sidebar-accent/40 p-0.5">
              {(["chat", "all"] as const).map((value) => (
                <button
                  key={value}
                  onClick={() => changeScope(value)}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors",
                    scope === value
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-muted-foreground hover:text-sidebar-foreground",
                  )}
                >
                  {t(value === "chat" ? "panel.processes.scopeChat" : "panel.processes.scopeAll")}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-0.5 overflow-y-auto px-1.5 pb-1.5">
            {visibleProcesses.length === 0 ? (
              <p className="px-2 py-1 text-[10px] text-muted-foreground/70">{t("panel.processes.emptyScope")}</p>
            ) : (
              visibleProcesses.map((p) => {
                const openTab = () =>
                  usePanelStore.getState().openProcessTab(bucketKey, p.pid, p.label, p.sessionId)
                return (
                  <div
                    key={p.pid}
                    role="button"
                    tabIndex={0}
                    onClick={openTab}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") openTab()
                    }}
                    className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent cursor-pointer"
                    title={`${p.command}\n\n${t("panel.processes.viewOutput")}`}
                  >
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        p.status === "running" ? "bg-emerald-500" : "bg-muted-foreground/50",
                      )}
                    />
                    <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
                    <Truncate text={p.label}>
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-sidebar-foreground">{p.label}</span>
                    </Truncate>
                    <span className="hidden shrink-0 items-center gap-1 text-[10px] text-sidebar-foreground/60 @xl:flex">
                      <span>PID {p.pid}</span>
                      <span>·</span>
                      <span>{formatUptime(p.startTime)}</span>
                      {p.status !== "running" && (
                        <>
                          <span>·</span>
                          <span>{t(`panel.processes.status.${p.status}`)}</span>
                        </>
                      )}
                    </span>
                    {p.status === "running" && p.urls?.length ? (
                      <Hint label={`${t("panel.processes.openInBrowser")} — ${p.urls[0]}`}>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            usePanelStore.getState().openTerminalLink(bucketKey, p.urls![0])
                          }}
                          className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-sidebar-foreground/50 hover:text-foreground"
                        >
                          <Globe className="size-3" />
                        </button>
                      </Hint>
                    ) : null}
                    <Hint label={t("panel.processes.kill")}>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          void killProcess(p.pid, p.sessionId)
                        }}
                        className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-sidebar-foreground/50 hover:text-destructive"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </Hint>
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function formatUptime(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export function RightPanel() {
  const { t } = useTranslation()
  const tabClosePosition = useAppearanceStore((s) => s.tabClosePosition)
  const tabMeta = useTabMeta()
  const { mode, folders } = useWorkspace()
  const activeSessionId = useSessionStore((s) => s.activeIds[mode])
  const sessions = useSessionStore((s) => s.sessions)
  const statusMap = useSessionStore((s) => s.status)
  const unreadCounts = useSessionStore((s) => s.unreadCounts)

  const tabsBySession = usePanelStore((s) => s.tabsBySession)
  const activeTabBySession = usePanelStore((s) => s.activeTabBySession)
  const sessionKey = activeSessionId ?? ORPHAN_KEY
  // `?? []` creates a new array on every render: memoized, the callbacks and
  // effects below stop recreating along with it.
  const tabs = useMemo(() => tabsBySession[sessionKey] ?? [], [tabsBySession, sessionKey])
  const activeTabId = activeTabBySession[sessionKey] ?? null
  const addTabToStore = usePanelStore((s) => s.addTab)
  const removeTabFromStore = usePanelStore((s) => s.removeTab)
  const setActiveTabInStore = usePanelStore((s) => s.setActiveTab)
  const setRightPanelOpen = usePanelStore((s) => s.setRightPanelOpen)
  const pendingFile = useWorkspaceSearchStore((s) => s.pending)
  /** Last palette request already served — the nonce avoids repeating the opening. */
  const handledFileRequest = useRef(0)
  const { setNodeRef, isOver } = useDroppable({ id: "right-panel-drop-zone" })
  const dndContext = useDndContext()
  const isDragging = dndContext.active !== null

  const selectorOpen = usePanelStore((s) => s.selectorOpen)
  const setSelectorOpen = usePanelStore((s) => s.setSelectorOpen)

  // Esc goes back to the active tab; with no tabs, the selector stays on screen anyway.
  useEffect(() => {
    if (!selectorOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectorOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [selectorOpen, setSelectorOpen])

  /**
   * Number of the next numbered tab ("Terminal", "Terminal 2", "Terminal 3"…):
   * PER CHAT (it counts only the tabs open in this session, not a global counter) and
   * filling gaps — if "Terminal 1" was closed, the next one becomes 1
   * again instead of jumping to 4, 5… (the unique global id keeps coming from
   * nextTabId(); the number here is only the visible label).
   */
  const nextTabNumber = useCallback(
    (type: TabType): number => {
      const label = tabMeta[type].label
      const used = new Set<number>()
      for (const tab of tabs) {
        if (tab.type !== type) continue
        const m = tab.title.match(new RegExp(`^${label}(?: (\\d+))?$`))
        if (m) used.add(m[1] ? parseInt(m[1], 10) : 1)
      }
      let n = 1
      while (used.has(n)) n++
      return n
    },
    [tabs, tabMeta],
  )

  const addTab = useCallback(async (type: TabType, sessionId?: string, title?: string) => {
    // Folders follow the repository selected in the workspace: they only stay
    // blocked when there is no project selected (even with no active chat).
    if (type === "folders" && folders.length === 0) return

    // A tab was chosen: the selector leaves the scene and the open tab takes over.
    setSelectorOpen(false)

    if (sessionId) {
      const id = `chat-${sessionId}`
      const exists = tabs.some((t) => t.id === id)
      if (!exists) {
        addTabToStore(sessionKey, { id, type: "chat", title: title ?? "Chat", sessionId })
      }
      setActiveTabInStore(sessionKey, id)
      return
    }
    if (type === "chat") {
      const id = `chat-new-${nextTabId()}`
      addTabToStore(sessionKey, { id, type: "chat", title: "Chat", pending: true })
      setActiveTabInStore(sessionKey, id)
      return
    }
    if (type === "terminal") {
      const n = nextTabNumber("terminal")
      const id = `terminal-${nextTabId()}`
      const tabTitle = n > 1 ? `Terminal ${n}` : "Terminal"
      const cwdFolder = folders[0]
      await useTerminalStore.getState().createTerminal(id, cwdFolder)
      addTabToStore(sessionKey, { id, type: "terminal", title: tabTitle })
      setActiveTabInStore(sessionKey, id)
      return
    }
    const meta = tabMeta[type]
    const n = nextTabNumber(type)
    const id = `${type}-${nextTabId()}`
    const tabTitle = n > 1 ? `${meta.label} ${n}` : meta.label
    addTabToStore(sessionKey, { id, type, title: tabTitle })
    setActiveTabInStore(sessionKey, id)
  }, [sessionKey, tabs, addTabToStore, setActiveTabInStore, folders, tabMeta, nextTabNumber, setSelectorOpen])

  /**
   * The palette (⌘P) asked for a file. Here one only prepares the PLACE: opening the panel,
   * ensuring a files tab and activating it. The file itself is opened by the
   * FoldersTab, which listens to the same request — this effect does not know how to deal with the
   * viewer, and does not need to.
   */
  useEffect(() => {
    if (!pendingFile || handledFileRequest.current === pendingFile.nonce) return
    handledFileRequest.current = pendingFile.nonce
    if (folders.length === 0) return
    setRightPanelOpen(true)
    const existing = tabs.find((tab) => tab.type === "folders")
    if (existing) setActiveTabInStore(sessionKey, existing.id)
    else void addTab("folders")
  }, [pendingFile, folders.length, tabs, sessionKey, setActiveTabInStore, setRightPanelOpen, addTab])

  const removeTab = useCallback((id: string) => {
    const sk = activeSessionId ?? ORPHAN_KEY
    const tab = tabs.find((t) => t.id === id)
    if (tab?.type === "terminal") {
      useTerminalStore.getState().killTerminal(id)
    }
    if (tab?.type === "browser") {
      // The tab was closed: it destroys the webview of the pool and unregisters it in the main process (otherwise the
      // page would stay alive in the hidden host and the agent would navigate an orphan browser).
      destroyWebview(`${activeSessionId ?? "__orphan__"}:${id}`)
    }
    removeTabFromStore(sk, id)
  }, [activeSessionId, tabs, removeTabFromStore])

  const updateTab = useCallback((id: string, updates: Partial<PanelTab>) => {
    const sk = activeSessionId ?? "__orphan__"
    // It reads from the store instead of the closure: did-navigate may arrive after other
    // tab changes — with the closure, the map over an old list would discard
    // tabs added in the meantime.
    const current = usePanelStore.getState().tabsBySession[sk] ?? []
    usePanelStore.getState().setTabsForSession(
      sk,
      current.map((t) => (t.id === id ? { ...t, ...updates } : t)),
      usePanelStore.getState().getActiveTabId(sk),
    )
  }, [activeSessionId])

  // The agent browser does NOT open the panel by itself: the 'ensure' event creates the
  // webview in the hidden host (App.tsx) and the tab in the store (ensureAgentBrowserTab).
  // Here the panel only shows the tab when the user opens it — clicking the
  // "testing…" indicator (openAgentBrowser) or the manual toggle.

  // "Send to side chat" coming from the input: it opens a chat tab
  const pendingChatTab = usePanelStore((s) => s.pendingChatTab)
  const pendingChatTabSession = usePanelStore((s) => s.pendingChatTabSession)
  const pendingChatTabTitle = usePanelStore((s) => s.pendingChatTabTitle)
  useEffect(() => {
    if (pendingChatTab > 0 && pendingChatTabSession && activeSessionId) {
      const id = `chat-${pendingChatTabSession}`
      const exists = tabs.some((t) => t.id === id)
      if (!exists) {
        addTabToStore(activeSessionId, { id, type: "chat", title: pendingChatTabTitle ?? "Chat", sessionId: pendingChatTabSession })
      }
      setActiveTabInStore(activeSessionId, id)
      usePanelStore.setState({ pendingChatTab: 0, pendingChatTabSession: undefined, pendingChatTabTitle: undefined })
    }
    // Reacts to the REQUEST (pendingChatTab), reading the tabs of the moment. `tabs` as a
    // dep would make the effect run again because of the tab it just created itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingChatTab, pendingChatTabSession, pendingChatTabTitle, activeSessionId])

  // Diff requested by the chat: it opens a Diff tab
  const pendingDiff = usePanelStore((s) => s.pendingDiff)
  const pendingDiffSessionId = usePanelStore((s) => s.pendingDiffSessionId)
  const pendingDiffMessageId = usePanelStore((s) => s.pendingDiffMessageId)
  const pendingDiffPipelineId = usePanelStore((s) => s.pendingDiffPipelineId)
  const pendingDiffTaskId = usePanelStore((s) => s.pendingDiffTaskId)
  const pendingDiffTitle = usePanelStore((s) => s.pendingDiffTitle)
  useEffect(() => {
    if (pendingDiff === 0) return
    // The pipeline has no chat session: its tabs live under the orphan key, the
    // same one used when no chat is active.
    const fromPipeline = !!(pendingDiffPipelineId && pendingDiffTaskId)
    const key = fromPipeline ? activeSessionId ?? "__orphan__" : activeSessionId
    if (!key) return
    if (!fromPipeline && !(pendingDiffSessionId && pendingDiffMessageId)) return

    const id = fromPipeline
      ? `diff-task-${pendingDiffTaskId}`
      : `diff-${pendingDiffSessionId}-${pendingDiffMessageId}`
    const currentTabs = usePanelStore.getState().tabsBySession[key] ?? []
    if (!currentTabs.some((t) => t.id === id)) {
      addTabToStore(key, {
        id,
        type: "diff",
        title: pendingDiffTitle ?? "Diff",
        sessionId: pendingDiffSessionId,
        messageId: pendingDiffMessageId,
        pipelineId: pendingDiffPipelineId,
        taskId: pendingDiffTaskId,
      })
    }
    setActiveTabInStore(key, id)
    usePanelStore.setState({
      pendingDiff: 0,
      pendingDiffSessionId: undefined,
      pendingDiffMessageId: undefined,
      pendingDiffPipelineId: undefined,
      pendingDiffTaskId: undefined,
      pendingDiffTitle: undefined,
    })
    // Same: the trigger is the diff request, not the tab list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDiff, pendingDiffSessionId, pendingDiffMessageId, pendingDiffPipelineId, pendingDiffTaskId, pendingDiffTitle, activeSessionId])

  // Running orchestration workers open tabs automatically
  useEffect(() => {
    if (!activeSessionId) return
    for (const session of sessions) {
      const status = statusMap[session.id]
      if (
        session.parentId === activeSessionId &&
        (status === "submitted" || status === "streaming" || status === "cancelling" || status === "fallback")
      ) {
        const id = `chat-${session.id}`
        const exists = tabs.some((t) => t.id === id)
        if (!exists) {
          addTabToStore(activeSessionId, { id, type: "chat", title: session.title, sessionId: session.id })
        }
        const currentActive = usePanelStore.getState().getActiveTabId(activeSessionId)
        if (!currentActive) setActiveTabInStore(activeSessionId, id)
      }
    }
    // Opens a tab for a worker that started running; `tabs` is read at the moment
    // (the `exists` guard avoids duplicating) and as a dep it would re-fire itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, statusMap, activeSessionId])

  const activeTab = tabs.find(t => t.id === activeTabId)

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "relative flex h-full min-w-0 flex-col rounded-lg shadow-sm border border-sidebar-border bg-sidebar overflow-hidden transition-shadow",
      )}
    >
      {isDragging && (
        <div className={cn(
          "absolute inset-0 z-20 flex items-center justify-center rounded-lg transition-all pointer-events-none",
          isOver
            ? "bg-primary/20 border-2 border-primary/50"
            : "bg-black/30",
        )}>
          <div className="flex flex-col items-center gap-2 text-primary">
            <GripVertical className="size-6" />
            <span className="text-sm font-medium whitespace-nowrap">{t("panel.dropToOpen")}</span>
          </div>
        </div>
      )}
      {tabs.length > 0 && (
        <div className="flex items-center gap-0.5 px-2 pt-2 overflow-x-auto">
          {tabs.map((tab) => {
            const { icon: Icon } = tabMeta[tab.type]
            // The tab in presentation mode is the SAME Design tab (designPlay),
            // but what it does there is run the prototype — hence the Play, in place of
            // the canvas icon, so the two are not confused in the row.
            // A conversation in the panel is a conversation, not a worker: nested bubbles, the
            // same icon that identifies a sub-chat in the sidebar.
            const TabIcon = tab.type === "chat" && tab.sessionId ? MessagesSquare : tab.type === "design" && tab.designPlay ? Play : Icon
            // The three indicators speak of the CONVERSATION — it is answering, it gave
            // an error, a message arrived — and only the chat tab shows a conversation.
            // Several others carry a sessionId for being of that chat (the
            // Sources tab, the document viewer, the diff), and without this
            // narrowing all of them spun along with the turn: the PDF the person
            // is reading does not stay "loading" because the agent is writing.
            const isChatTab = tab.type === "chat" && !!tab.sessionId
            const tabStatus = isChatTab ? statusMap[tab.sessionId!] : undefined
            const isWorking = tabStatus === "submitted" || tabStatus === "streaming"
            const isError = tabStatus === "error"
            const hasUnread = isChatTab && (unreadCounts[tab.sessionId!] ?? 0) > 0
            const closeOnLeft = tabClosePosition === "left"
            const closeButton = (
              <Hint label={t("panel.closeTab")}>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); removeTab(tab.id) }}
                  className={cn(
                    "flex size-3.5 shrink-0 cursor-pointer items-center justify-center rounded-sm opacity-0 transition-opacity group-hover:opacity-100 hover:bg-sidebar-foreground/10",
                    closeOnLeft ? "mr-0.5" : "ml-0.5",
                  )}
                >
                  <X className="size-2.5" />
                </button>
              </Hint>
            )
            return (
              <div
                key={tab.id}
                className={cn(
                  "group flex min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors",
                  tab.id === activeTabId
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-accent/50",
                )}
                onClick={() => {
                  setActiveTabInStore(sessionKey, tab.id)
                  setSelectorOpen(false)
                }}
              >
                {closeOnLeft && closeButton}
                <TabIcon className="size-3.5 shrink-0" />
                <TruncatedText text={tab.title} className="max-w-24" />
                {isWorking && <Loader2 className="size-3 shrink-0 animate-spin text-primary" />}
                {isError && (
                  <span className="size-1.5 shrink-0 rounded-full bg-destructive" />
                )}
                {!isWorking && !isError && hasUnread && tab.id !== activeTabId && (
                  <span className="size-2 shrink-0 rounded-full bg-primary" title={t("panel.unreadMessages")} />
                )}
                {!closeOnLeft && closeButton}
              </div>
            )
          })}
          {/* The "+" opens the start screen of the panel (grid of tabs + background
              processes) instead of a dropdown: a new tab becomes an informed
              choice, and the processes footer stays always reachable. */}
          <Hint label={t("panel.selector.title")}>
            <button
              type="button"
              onClick={() => setSelectorOpen(!selectorOpen)}
              className={cn(
                "ml-auto flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors",
                selectorOpen
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-accent",
              )}
            >
              <PlusIcon className="size-3.5" />
            </button>
          </Hint>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {activeTab && !selectorOpen ? (
          // key forces a remount on tab switch: without it, React reuses the same
          // instance for tabs of the same type (browser↔browser) and they start
          // sharing state/history — it was the "shared context" and the
          // switching that did not work. With persistKey, the remount only
          // re-attaches the webview of that tab coming from the pool.
          <TabContent key={activeTab.id} tab={activeTab} sessionId={activeSessionId ?? undefined} onUpdateTab={updateTab} />
        ) : (
          <SelectorScreen
            onSelect={addTab}
          />
        )}
      </div>
    </div>
  )
}
