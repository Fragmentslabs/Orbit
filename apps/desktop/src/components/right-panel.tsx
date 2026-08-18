import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { useDroppable, useDndContext } from "@dnd-kit/core"
import { FileCode, Globe, Folder, Images, MessageSquare, Terminal, X, PlusIcon, Bot, LoaderIcon, Loader2, XCircleIcon, Trash2, GripVertical } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
import { ProcessOutputDialog } from "@/src/components/process-output-dialog"
import { useWorkspace } from "@/lib/workspace-context"
import { usePanelStore, nextTabId, type TabType, type PanelTab } from "@/src/stores/panel-store"
import { useSessionStore } from "@/src/stores/session-store"
import { useProcessStore } from "@/src/stores/process-store"
import { useTerminalStore } from "@/src/stores/terminal-store"
import { useAppearanceStore } from "@/src/stores/appearance-store"
import type { ProcessInfo } from "@/src/lib/ipc"
import { cn } from "@/lib/utils"

interface TabMeta {
  icon: typeof MessageSquare
  label: string
  description: string
}

function useTabMeta(): Record<TabType, TabMeta> {
  const { t } = useTranslation()
  return {
    chat: { icon: MessageSquare, label: t("panel.tabs.chat.label"), description: t("panel.tabs.chat.description") },
    terminal: { icon: Terminal, label: t("panel.tabs.terminal.label"), description: t("panel.tabs.terminal.description") },
    folders: { icon: Folder, label: t("panel.tabs.folders.label"), description: t("panel.tabs.folders.description") },
    browser: { icon: Globe, label: t("panel.tabs.browser.label"), description: t("panel.tabs.browser.description") },
    diff: { icon: FileCode, label: t("panel.tabs.diff.label"), description: t("panel.tabs.diff.description") },
    media: { icon: Images, label: t("panel.tabs.media.label"), description: t("panel.tabs.media.description") },
  }
}

function NewChatTab({ onCreated }: { onCreated: (sessionId: string) => void }) {
  const { t } = useTranslation()
  const { folders, setFolders } = useWorkspace()
  const handleSubmit = async (text: string, options: SendMessageOptions, files?: FilePart[]) => {
    if (folders.length > 0) {
      // Espelha o painel principal: novo chat com pasta vira sessão de código
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

/** Header de um chat aberto em aba: nome + pasta + branch, como o header do painel principal */
function ChatTabHeader({ sessionId }: { sessionId?: string }) {
  const session = useSessionStore((s) => (sessionId ? s.sessions.find((x) => x.id === sessionId) : undefined))
  const setSessionDirectories = useSessionStore((s) => s.setSessionDirectories)
  const setFolders = useWorkspace().setFolders
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

  const handleFoldersChange = (next: string[]) => {
    setSessionDirectories(session.id, next[0], next.slice(1))
    // Mantém o workspace sincronizado (o input do painel envia com as pastas do workspace)
    setFolders(next)
  }

  return (
    // z-20: o `@container` cria stacking context (layout containment), então
    // sem ele o dropdown de pastas fica preso abaixo do degrade do topo do chat
    <div className="@container relative z-20 flex min-w-0 items-center gap-2 px-1 pb-2">
      <span className="min-w-0 truncate text-sm font-medium text-foreground">{session.title}</span>
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
        <div className="flex flex-1 flex-col overflow-hidden p-4" style={{ '--panel-bg': 'var(--sidebar)' } as React.CSSProperties}>
          <ChatTabHeader sessionId={tab.sessionId} />
          <ChatView sessionId={tab.sessionId} />
        </div>
      )
    case "terminal":
      return <TerminalTabContent tabId={tab.id} sessionId={sessionId} />
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
            // Chave do webview no pool (webview-session.ts). Uma por aba e por
            // chat: cada aba tem sua própria página, e voltar ao chat retoma a
            // URL de onde parou. Sempre definida — é o pool que trata console,
            // navegação e modo seleção.
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
            esteiraId={tab.esteiraId}
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

function WorkerStatusIcon({ status }: { status: string }) {
  if (status === "submitted" || status === "streaming" || status === "cancelling") {
    return <LoaderIcon className="size-3 shrink-0 animate-spin text-muted-foreground" />
  }
  if (status === "error") return <XCircleIcon className="size-3 shrink-0 text-destructive" />
  return <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
}

function SelectorScreen({ onSelect, onOpenWorker }: {
  onSelect: (type: TabType) => void
  onOpenWorker: (sessionId: string, title: string) => void
}) {
  const { t } = useTranslation()
  const tabMeta = useTabMeta()
  const { mode, folders } = useWorkspace()
  const activeId = useSessionStore((s) => s.activeIds[mode])
  const sessions = useSessionStore((s) => s.sessions)
  const statusMap = useSessionStore((s) => s.status)

  const processes = useProcessStore((s) => s.processes)
  const fetchProcesses = useProcessStore((s) => s.fetch)
  const killProcess = useProcessStore((s) => s.kill)
  const [outputPid, setOutputPid] = useState<number | null>(null)
  const outputProcess: ProcessInfo | null = processes.find((p) => p.pid === outputPid) ?? null

  const workers = useMemo(
    () => sessions.filter((s) => s.parentId === activeId),
    [sessions, activeId],
  )

  const availableTabs = useMemo(
    () => (Object.entries(tabMeta) as [TabType, TabMeta][]).filter(([type]) => mode !== "chat" || type === "chat" || type === "media"),
    [mode, tabMeta],
  )

  // Footer escopado por sessão: só processos iniciados pelo chat ativo.
  useEffect(() => {
    fetchProcesses(activeId ?? undefined)
    const interval = setInterval(() => fetchProcesses(activeId ?? undefined), 3_000)
    return () => clearInterval(interval)
  }, [fetchProcesses, activeId])

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
        <p className="text-sm font-medium text-foreground">{t("panel.selector.title")}</p>
        <div className={cn("grid gap-3 w-full max-w-xs", availableTabs.length === 1 ? "grid-cols-1 justify-items-center" : "grid-cols-2")}>
          {availableTabs.map(([type, { icon: Icon, label, description }]) => {
            // Pastas e diff seguem o repositório selecionado no workspace: sem
            // chat ativo ainda é possível abrir (novo chat), desde que haja projeto.
            const isDisabled = folders.length === 0 && (type === "folders" || type === "diff")
            return (
              <button
                key={type}
                disabled={isDisabled}
                onClick={() => onSelect(type)}
                className={cn(
                  "flex flex-col items-center gap-2 rounded-lg border border-sidebar-border bg-sidebar-accent/30 p-4 text-center transition-colors",
                  isDisabled
                    ? "opacity-40 cursor-not-allowed"
                    : "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground cursor-pointer",
                )}
              >
                <Icon className="size-6 shrink-0" />
                <span className="text-xs font-medium">{label}</span>
                <span className="text-[10px] leading-tight text-muted-foreground line-clamp-2">{description}</span>
              </button>
            )
          })}
        </div>

        {workers.length > 0 && (
          <div className="mt-2 flex w-full max-w-xs flex-col gap-1">
            <p className="px-1 text-[11px] font-medium text-muted-foreground">{t("panel.selector.workersTitle")}</p>
            {workers.map((worker) => (
              <button
                key={worker.id}
                onClick={() => onOpenWorker(worker.id, worker.title)}
                className="flex items-center gap-2 rounded-md border border-sidebar-border bg-sidebar-accent/20 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-sidebar-accent"
              >
                {worker.mode === "code" ? (
                  <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <Bot className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate">{worker.title}</span>
                <WorkerStatusIcon status={statusMap[worker.id] ?? "idle"} />
              </button>
            ))}
          </div>
        )}
      </div>

      {processes.length > 0 && (
        <div className="border-t border-sidebar-border">
          <div className="flex gap-2 overflow-x-auto px-3 py-2">
            {processes.map((p) => (
              <div
                key={p.pid}
                role="button"
                tabIndex={0}
                onClick={() => setOutputPid(p.pid)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") setOutputPid(p.pid)
                }}
                className="flex w-40 shrink-0 flex-col gap-1 rounded-md border border-sidebar-border bg-sidebar-accent/50 px-2.5 py-1.5 text-left transition-colors hover:bg-sidebar-accent cursor-pointer"
                title={`${p.command}\n\n${t("panel.processes.viewOutput")}`}
              >
                <div className="flex items-center gap-1.5">
                  {p.status === "running" ? (
                    <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
                  ) : (
                    <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-sidebar-foreground">{p.label}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      void killProcess(p.pid, activeId ?? undefined)
                    }}
                    title={t("panel.processes.kill")}
                    className="flex size-4 shrink-0 items-center justify-center rounded-sm text-sidebar-foreground/50 hover:text-destructive"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-x-1 text-[10px] text-sidebar-foreground/60">
                  <span>PID {p.pid}</span>
                  <span>·</span>
                  <span>{formatUptime(p.startTime)}</span>
                  {p.status !== "running" && (
                    <>
                      <span>·</span>
                      <span>{t(`panel.processes.status.${p.status}`)}</span>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <ProcessOutputDialog process={outputProcess} onOpenChange={(open) => !open && setOutputPid(null)} />
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
  const sessionKey = activeSessionId ?? "__orphan__"
  const tabs = tabsBySession[sessionKey] ?? []
  const activeTabId = activeTabBySession[sessionKey] ?? null
  const addTabToStore = usePanelStore((s) => s.addTab)
  const removeTabFromStore = usePanelStore((s) => s.removeTab)
  const setActiveTabInStore = usePanelStore((s) => s.setActiveTab)
  const { setNodeRef, isOver } = useDroppable({ id: "right-panel-drop-zone" })
  const dndContext = useDndContext()
  const isDragging = dndContext.active !== null

  const availableTabs = useMemo(
    () => (Object.entries(tabMeta) as [TabType, TabMeta][]).filter(([type]) => mode !== "chat" || type === "chat" || type === "media"),
    [mode, tabMeta],
  )

  /**
   * Número da próxima aba numerada ("Terminal", "Terminal 2", "Terminal 3"…):
   * POR CHAT (conta só as abas abertas desta sessão, não um contador global) e
   * preenchendo lacunas — se a "Terminal 1" foi fechada, a próxima volta a ser
   * a 1 em vez de pular para 4, 5… (o id único global continua vindo de
   * nextTabId(); o número aqui é apenas o rótulo visível).
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
    // Pastas e diff seguem o repositório selecionado no workspace: só ficam
    // bloqueados quando não há projeto selecionado (mesmo sem chat ativo).
    if ((type === "folders" || type === "diff") && folders.length === 0) return

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
  }, [activeSessionId, tabs, addTabToStore, setActiveTabInStore, folders, tabMeta, nextTabNumber])

  const removeTab = useCallback((id: string) => {
    const sk = activeSessionId ?? "__orphan__"
    const tab = tabs.find((t) => t.id === id)
    if (tab?.type === "terminal") {
      useTerminalStore.getState().killTerminal(id)
    }
    if (tab?.type === "browser") {
      // Fechou a aba: destrói o webview do pool e desregistra no main (senão a
      // página continuaria viva no host oculto e o agente navegaria um browser órfão).
      destroyWebview(`${activeSessionId ?? "__orphan__"}:${id}`)
    }
    removeTabFromStore(sk, id)
  }, [activeSessionId, tabs, removeTabFromStore])

  const updateTab = useCallback((id: string, updates: Partial<PanelTab>) => {
    const sk = activeSessionId ?? "__orphan__"
    // Lê do store em vez do closure: did-navigate pode chegar depois de outras
    // mudanças de abas — com o closure, o map sobre uma lista antiga descartaria
    // abas adicionadas entretanto.
    const current = usePanelStore.getState().tabsBySession[sk] ?? []
    usePanelStore.getState().setTabsForSession(
      sk,
      current.map((t) => (t.id === id ? { ...t, ...updates } : t)),
      usePanelStore.getState().getActiveTabId(sk),
    )
  }, [activeSessionId])

  // O browser do agente NÃO abre o painel sozinho: o evento 'ensure' cria o
  // webview no host oculto (App.tsx) e a aba no store (ensureAgentBrowserTab).
  // Aqui o painel só mostra a aba quando o usuário abre — clicando no
  // indicador "testando…" (openAgentBrowser) ou no toggle manual.

  // "Enviar para chat lateral" vindo do input: abre aba de chat
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
  }, [pendingChatTab, pendingChatTabSession, pendingChatTabTitle, activeSessionId])

  // Diff solicitado pelo chat: abre aba Diff
  const pendingDiff = usePanelStore((s) => s.pendingDiff)
  const pendingDiffSessionId = usePanelStore((s) => s.pendingDiffSessionId)
  const pendingDiffMessageId = usePanelStore((s) => s.pendingDiffMessageId)
  const pendingDiffEsteiraId = usePanelStore((s) => s.pendingDiffEsteiraId)
  const pendingDiffTaskId = usePanelStore((s) => s.pendingDiffTaskId)
  const pendingDiffTitle = usePanelStore((s) => s.pendingDiffTitle)
  useEffect(() => {
    if (pendingDiff === 0) return
    // A esteira não tem sessão de chat: as abas dela ficam na chave órfã, que
    // é a mesma usada quando nenhum chat está ativo.
    const daEsteira = !!(pendingDiffEsteiraId && pendingDiffTaskId)
    const chave = daEsteira ? activeSessionId ?? "__orphan__" : activeSessionId
    if (!chave) return
    if (!daEsteira && !(pendingDiffSessionId && pendingDiffMessageId)) return

    const id = daEsteira
      ? `diff-task-${pendingDiffTaskId}`
      : `diff-${pendingDiffSessionId}-${pendingDiffMessageId}`
    const atuais = usePanelStore.getState().tabsBySession[chave] ?? []
    if (!atuais.some((t) => t.id === id)) {
      addTabToStore(chave, {
        id,
        type: "diff",
        title: pendingDiffTitle ?? "Diff",
        sessionId: pendingDiffSessionId,
        messageId: pendingDiffMessageId,
        esteiraId: pendingDiffEsteiraId,
        taskId: pendingDiffTaskId,
      })
    }
    setActiveTabInStore(chave, id)
    usePanelStore.setState({
      pendingDiff: 0,
      pendingDiffSessionId: undefined,
      pendingDiffMessageId: undefined,
      pendingDiffEsteiraId: undefined,
      pendingDiffTaskId: undefined,
      pendingDiffTitle: undefined,
    })
  }, [pendingDiff, pendingDiffSessionId, pendingDiffMessageId, pendingDiffEsteiraId, pendingDiffTaskId, pendingDiffTitle, activeSessionId])

  // Workers da orquestração em execução abrem tabs automaticamente
  useEffect(() => {
    if (!activeSessionId) return
    for (const session of sessions) {
      const status = statusMap[session.id]
      if (
        session.parentId === activeSessionId &&
        (status === "submitted" || status === "streaming" || status === "cancelling")
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
            const TabIcon = tab.type === "chat" && tab.sessionId ? Bot : Icon
            const tabStatus = tab.sessionId ? statusMap[tab.sessionId] : undefined
            const isWorking = tabStatus === "submitted" || tabStatus === "streaming"
            const isError = tabStatus === "error"
            const hasUnread = !!tab.sessionId && (unreadCounts[tab.sessionId] ?? 0) > 0
            const closeOnLeft = tabClosePosition === "left"
            const closeButton = (
              <button
                onClick={(e) => { e.stopPropagation(); removeTab(tab.id) }}
                className={cn(
                  "flex size-3.5 shrink-0 items-center justify-center rounded-sm opacity-0 transition-opacity group-hover:opacity-100 hover:bg-sidebar-foreground/10",
                  closeOnLeft ? "mr-0.5" : "ml-0.5",
                )}
              >
                <X className="size-2.5" />
              </button>
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
                onClick={() => setActiveTabInStore(sessionKey, tab.id)}
              >
                {closeOnLeft && closeButton}
                <TabIcon className="size-3.5 shrink-0" />
                <span className="truncate max-w-24">{tab.title}</span>
                {isWorking && <Loader2 className="size-3 shrink-0 animate-spin text-primary" />}
                {isError && (
                  <span className="size-1.5 shrink-0 rounded-full bg-destructive" />
                )}
                {!isWorking && !isError && hasUnread && tab.id !== activeTabId && (
                  <span className="size-2 shrink-0 rounded-full bg-primary" title="Mensagens não lidas" />
                )}
                {!closeOnLeft && closeButton}
              </div>
            )
          })}
          <DropdownMenu>
            <DropdownMenuTrigger className="ml-auto flex size-5 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-accent">
              <PlusIcon className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-32">
              {availableTabs.map(([type, { icon: Icon, label }]) => {
                const isDisabled = folders.length === 0 && (type === "folders" || type === "diff")
                return (
                  <DropdownMenuItem key={type} disabled={isDisabled} onClick={() => addTab(type)}>
                    <Icon className="size-4" />
                    {label}
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {activeTab ? (
          // key força remount ao trocar de aba: sem ela, o React reusa a mesma
          // instância para abas do mesmo tipo (browser↔browser) e elas passam a
          // compartilhar estado/histórico — era o "contexto compartilhado" e a
          // alternância que não funcionava. Com persistKey, o remount apenas
          // reanexa o webview daquela aba vindo do pool.
          <TabContent key={activeTab.id} tab={activeTab} sessionId={activeSessionId ?? undefined} onUpdateTab={updateTab} />
        ) : (
          <SelectorScreen
            onSelect={addTab}
            onOpenWorker={(sessionId, title) => addTab("chat", sessionId, title)}
          />
        )}
      </div>
    </div>
  )
}
