import { useCallback, useEffect, useMemo, useState } from "react"
import { useDroppable, useDndContext } from "@dnd-kit/core"
import { FileCode, Globe, Folder, MessageSquare, Terminal, X, PlusIcon, Bot, LoaderIcon, XCircleIcon, Trash2, GripVertical } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ChatView } from "@/src/components/chat-view"
import { ChatInput } from "@/src/components/chat-input"
import type { SendMessageOptions, FilePart } from "@shared/chat"
import { TerminalTab } from "@/src/components/terminal-tab"
import { BrowserTab } from "@/src/components/browser-tab"
import { FoldersTab } from "@/src/components/folders-tab"
import { DiffTab } from "@/src/components/diff-tab"
import { useWorkspace } from "@/lib/workspace-context"
import { usePanelStore } from "@/src/stores/panel-store"
import { useSessionStore } from "@/src/stores/session-store"
import { useProcessStore } from "@/src/stores/process-store"
import { cn } from "@/lib/utils"

type TabType = "chat" | "terminal" | "folders" | "browser" | "diff"

interface PanelTab {
  id: string
  type: TabType
  title: string
  /** Tab de chat apontando para uma session específica (workers da orquestração) */
  sessionId?: string
  /** ID da mensagem do assistente (diff) */
  messageId?: string
  /** Tab novo ainda sem session — só cria quando enviar a primeira mensagem */
  pending?: boolean
}

interface TabMeta {
  icon: typeof MessageSquare
  label: string
  description: string
}

const tabMeta: Record<TabType, TabMeta> = {
  chat: { icon: MessageSquare, label: "Chat", description: "Converse com a IA sobre qualquer assunto" },
  terminal: { icon: Terminal, label: "Terminal", description: "Execute comandos e scripts" },
  folders: { icon: Folder, label: "Pastas", description: "Navegue pelos arquivos do projeto" },
  browser: { icon: Globe, label: "Browser", description: "Pesquise e visualize páginas web" },
  diff: { icon: FileCode, label: "Diff", description: "Alterações das ferramentas" },
}

function NewChatTab({ onCreated }: { onCreated: (sessionId: string) => void }) {
  const handleSubmit = async (text: string, options: SendMessageOptions, files?: FilePart[]) => {
    const newSession = await useSessionStore.getState().createSession("chat", { setActive: false })
    onCreated(newSession.id)
    await useSessionStore.getState().sendMessage("chat", text, { options, sessionId: newSession.id, files })
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden p-4" style={{ '--panel-bg': 'var(--sidebar)' } as React.CSSProperties}>
      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        <div className="flex flex-col items-center gap-2">
          <p className="text-lg font-medium text-foreground">Nova conversa</p>
          <p className="text-sm text-muted-foreground">Digite uma mensagem para começar</p>
        </div>
      </div>
      <ChatInput onSubmit={handleSubmit} />
    </div>
  )
}

function TabContent({ tab, onUpdateTab }: { tab: PanelTab; onUpdateTab: (id: string, updates: Partial<PanelTab>) => void }) {
  switch (tab.type) {
    case "chat":
      if (tab.pending) {
        return <NewChatTab onCreated={(sessionId) => onUpdateTab(tab.id, { pending: false, sessionId })} />
      }
      return (
        <div className="flex flex-1 flex-col overflow-hidden p-4" style={{ '--panel-bg': 'var(--sidebar)' } as React.CSSProperties}>
          <ChatView sessionId={tab.sessionId} />
        </div>
      )
    case "terminal":
      return (
        <div className="flex flex-1 flex-col overflow-hidden">
          <TerminalTab />
        </div>
      )
    case "folders":
      return (
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <FoldersTab />
        </div>
      )
    case "browser":
      return (
        <div className="flex flex-1 flex-col overflow-hidden">
          <BrowserTab />
        </div>
      )
    case "diff":
      return (
        <div className="flex flex-1 flex-col overflow-hidden p-4">
          <DiffTab sessionId={tab.sessionId} messageId={tab.messageId} />
        </div>
      )
  }
}

export function RightPanelDropZone() {
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
        <span className="text-sm font-medium whitespace-nowrap">Solte para abrir</span>
      </div>
    </div>
  )
}

function WorkerStatusIcon({ status }: { status: string }) {
  if (status === "submitted" || status === "streaming") {
    return <LoaderIcon className="size-3 shrink-0 animate-spin text-muted-foreground" />
  }
  if (status === "error") return <XCircleIcon className="size-3 shrink-0 text-destructive" />
  return <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
}

function SelectorScreen({ onSelect, onOpenWorker }: {
  onSelect: (type: TabType) => void
  onOpenWorker: (sessionId: string, title: string) => void
}) {
  const { mode } = useWorkspace()
  const activeId = useSessionStore((s) => s.activeIds[mode])
  const sessions = useSessionStore((s) => s.sessions)
  const statusMap = useSessionStore((s) => s.status)

  const processes = useProcessStore((s) => s.processes)
  const fetchProcesses = useProcessStore((s) => s.fetch)
  const killProcess = useProcessStore((s) => s.kill)

  const workers = useMemo(
    () => sessions.filter((s) => s.parentId === activeId),
    [sessions, activeId],
  )

  const availableTabs = useMemo(
    () => (Object.entries(tabMeta) as [TabType, TabMeta][]).filter(([type]) => mode !== "chat" || type === "chat"),
    [mode],
  )

  useEffect(() => {
    fetchProcesses()
    const interval = setInterval(() => fetchProcesses(), 3_000)
    return () => clearInterval(interval)
  }, [fetchProcesses])

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
        <p className="text-sm font-medium text-foreground">O que deseja abrir?</p>
        <div className={cn("grid gap-3 w-full max-w-xs", availableTabs.length === 1 ? "grid-cols-1 justify-items-center" : "grid-cols-2")}>
          {availableTabs.map(([type, { icon: Icon, label, description }]) => (
            <button
              key={type}
              onClick={() => onSelect(type)}
              className="flex flex-col items-center gap-2 rounded-lg border border-sidebar-border bg-sidebar-accent/30 p-4 text-center transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <Icon className="size-6 shrink-0" />
              <span className="text-xs font-medium">{label}</span>
              <span className="text-[10px] leading-tight text-muted-foreground line-clamp-2">{description}</span>
            </button>
          ))}
        </div>

        {workers.length > 0 && (
          <div className="mt-2 flex w-full max-w-xs flex-col gap-1">
            <p className="px-1 text-[11px] font-medium text-muted-foreground">Workers da conversa ativa</p>
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
        <div className="flex items-center gap-2 border-t border-sidebar-border px-3 py-2 text-xs text-sidebar-foreground/70">
          {processes.map((p) => (
            <div key={p.pid} className="flex items-center gap-1.5 rounded-md bg-sidebar-accent/50 px-2 py-1">
              {p.status === "running" ? (
                <span className="size-1.5 rounded-full bg-emerald-500 shrink-0" />
              ) : (
                <span className="size-1.5 rounded-full bg-muted-foreground/50 shrink-0" />
              )}
              <span className="font-medium">{p.label}</span>
              <span className="text-[10px]">PID {p.pid}</span>
              <span className="text-[10px]">{formatUptime(p.startTime)}</span>
              {p.status !== "running" && (
                <span className="text-[10px] text-muted-foreground">({p.status})</span>
              )}
              <button
                onClick={() => void killProcess(p.pid)}
                className="ml-0.5 flex size-3.5 items-center justify-center rounded-sm text-sidebar-foreground/50 hover:text-destructive"
              >
                <Trash2 className="size-3" />
              </button>
            </div>
          ))}
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

let tabCounter = 0

export function RightPanel() {
  const [tabs, setTabs] = useState<PanelTab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const { mode } = useWorkspace()
  const activeSessionId = useSessionStore((s) => s.activeIds[mode])
  const sessions = useSessionStore((s) => s.sessions)
  const statusMap = useSessionStore((s) => s.status)

  const { setNodeRef, isOver } = useDroppable({ id: "right-panel-drop-zone" })
  const dndContext = useDndContext()
  const isDragging = dndContext.active !== null

  const availableTabs = useMemo(
    () => (Object.entries(tabMeta) as [TabType, TabMeta][]).filter(([type]) => mode !== "chat" || type === "chat"),
    [mode],
  )

  const addTab = useCallback(async (type: TabType, sessionId?: string, title?: string) => {
    if (sessionId) {
      // Tab de session específica: reusa se já aberta
      const id = `chat-${sessionId}`
      setTabs((prev) =>
        prev.some((t) => t.id === id)
          ? prev
          : [...prev, { id, type: "chat", title: title ?? "Chat", sessionId }],
      )
      setActiveTabId(id)
      return
    }
    if (type === "chat") {
      tabCounter++
      const id = `chat-new-${tabCounter}`
      setTabs((prev) => [...prev, { id, type: "chat", title: "Chat", pending: true }])
      setActiveTabId(id)
      return
    }
    const meta = tabMeta[type]
    tabCounter++
    const id = `${type}-${tabCounter}`
    const tabTitle = `${meta.label} ${tabCounter > 1 ? tabCounter : ""}`.trim()
    setTabs((prev) => [...prev, { id, type, title: tabTitle }])
    setActiveTabId(id)
  }, [])

  // Agente pediu o browser (tools panel_*): garante/ativa a aba Browser
  const browserRequestId = usePanelStore((s) => s.browserRequestId)
  useEffect(() => {
    if (browserRequestId === 0) return
    const id = "browser-agent"
    setTabs((prev) =>
      prev.some((t) => t.id === id) ? prev : [...prev, { id, type: "browser", title: "Browser" }],
    )
    setActiveTabId(id)
  }, [browserRequestId])

  // "Enviar para chat lateral" vindo do input: abre aba de chat
  const pendingChatTab = usePanelStore((s) => s.pendingChatTab)
  const pendingChatTabSession = usePanelStore((s) => s.pendingChatTabSession)
  const pendingChatTabTitle = usePanelStore((s) => s.pendingChatTabTitle)
  useEffect(() => {
    if (pendingChatTab > 0 && pendingChatTabSession) {
      const id = `chat-${pendingChatTabSession}`
      setTabs((prev) =>
        prev.some((t) => t.id === id)
          ? prev
          : [...prev, { id, type: "chat", title: pendingChatTabTitle ?? "Chat", sessionId: pendingChatTabSession }],
      )
      setActiveTabId(id)
      usePanelStore.setState({ pendingChatTab: 0, pendingChatTabSession: undefined, pendingChatTabTitle: undefined })
    }
  }, [pendingChatTab, pendingChatTabSession, pendingChatTabTitle])

  // Diff solicitado pelo chat: abre aba Diff
  const pendingDiff = usePanelStore((s) => s.pendingDiff)
  const pendingDiffSessionId = usePanelStore((s) => s.pendingDiffSessionId)
  const pendingDiffMessageId = usePanelStore((s) => s.pendingDiffMessageId)
  const pendingDiffTitle = usePanelStore((s) => s.pendingDiffTitle)
  useEffect(() => {
    if (pendingDiff > 0 && pendingDiffSessionId && pendingDiffMessageId) {
      const id = `diff-${pendingDiffSessionId}-${pendingDiffMessageId}`
      setTabs((prev) =>
        prev.some((t) => t.id === id)
          ? prev
          : [...prev, { id, type: "diff", title: pendingDiffTitle ?? "Diff", sessionId: pendingDiffSessionId, messageId: pendingDiffMessageId }],
      )
      setActiveTabId(id)
      usePanelStore.setState({ pendingDiff: 0, pendingDiffSessionId: undefined, pendingDiffMessageId: undefined, pendingDiffTitle: undefined })
    }
  }, [pendingDiff, pendingDiffSessionId, pendingDiffMessageId, pendingDiffTitle])

  // Workers da orquestração em execução abrem tabs automaticamente
  useEffect(() => {
    if (!activeSessionId) return
    for (const session of sessions) {
      const status = statusMap[session.id]
      if (
        session.parentId === activeSessionId &&
        (status === "submitted" || status === "streaming")
      ) {
        const id = `chat-${session.id}`
        setTabs((prev) =>
          prev.some((t) => t.id === id)
            ? prev
            : [...prev, { id, type: "chat", title: session.title, sessionId: session.id }],
        )
        setActiveTabId((current) => current ?? id)
      }
    }
  }, [sessions, statusMap, activeSessionId])

  const removeTab = useCallback((id: string) => {
    setTabs(prev => {
      const idx = prev.findIndex(t => t.id === id)
      const next = prev.filter(t => t.id !== id)
      if (next.length === 0) {
        setActiveTabId(null)
      } else if (activeTabId === id) {
        setActiveTabId(next[Math.min(idx, next.length - 1)].id)
      }
      return next
    })
  }, [activeTabId])

  const updateTab = useCallback((id: string, updates: Partial<PanelTab>) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...updates } : t)))
  }, [])

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
            <span className="text-sm font-medium whitespace-nowrap">Solte para abrir</span>
          </div>
        </div>
      )}
      {tabs.length > 0 && (
        <div className="flex items-center gap-0.5 px-2 pt-2 overflow-x-auto">
          {tabs.map((tab) => {
            const { icon: Icon } = tabMeta[tab.type]
            const TabIcon = tab.type === "chat" && tab.sessionId ? Bot : Icon
            return (
              <div
                key={tab.id}
                className={cn(
                  "group flex min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors",
                  tab.id === activeTabId
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-accent/50",
                )}
                onClick={() => setActiveTabId(tab.id)}
              >
                <TabIcon className="size-3.5 shrink-0" />
                <span className="truncate max-w-24">{tab.title}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); removeTab(tab.id) }}
                  className="ml-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-sm opacity-0 transition-opacity group-hover:opacity-100 hover:bg-sidebar-foreground/10"
                >
                  <X className="size-2.5" />
                </button>
              </div>
            )
          })}
          <DropdownMenu>
            <DropdownMenuTrigger className="ml-auto flex size-5 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-accent">
              <PlusIcon className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-32">
              {availableTabs.map(([type, { icon: Icon, label }]) => (
                <DropdownMenuItem key={type} onClick={() => addTab(type)}>
                  <Icon className="size-4" />
                  {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {activeTab ? (
          <TabContent tab={activeTab} onUpdateTab={updateTab} />
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
