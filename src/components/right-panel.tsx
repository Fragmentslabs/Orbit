import { useCallback, useEffect, useMemo, useState } from "react"
import { FileCode, Globe, Folder, MessageSquare, Terminal, X, PlusIcon, Bot, LoaderIcon, XCircleIcon } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ChatView } from "@/src/components/chat-view"
import { TerminalTab } from "@/src/components/terminal-tab"
import { BrowserTab } from "@/src/components/browser-tab"
import { FoldersTab } from "@/src/components/folders-tab"
import { DiffTab } from "@/src/components/diff-tab"
import { useWorkspace } from "@/lib/workspace-context"
import { usePanelStore } from "@/src/stores/panel-store"
import { useSessionStore } from "@/src/stores/session-store"
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

function TabContent({ tab }: { tab: PanelTab }) {
  switch (tab.type) {
    case "chat":
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
          <DiffTab sessionId={tab.sessionId!} messageId={tab.messageId!} />
        </div>
      )
  }
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
  const workers = useMemo(
    () => sessions.filter((s) => s.parentId === activeId),
    [sessions, activeId],
  )

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
      <p className="text-sm font-medium text-foreground">O que deseja abrir?</p>
      <div className="grid grid-cols-2 gap-3 w-full max-w-xs">
        {(Object.entries(tabMeta) as [TabType, TabMeta][]).map(([type, { icon: Icon, label, description }]) => (
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
  )
}

let tabCounter = 0

export function RightPanel() {
  const [tabs, setTabs] = useState<PanelTab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const { mode } = useWorkspace()
  const activeSessionId = useSessionStore((s) => s.activeIds[mode])
  const sessions = useSessionStore((s) => s.sessions)
  const statusMap = useSessionStore((s) => s.status)

  const addTab = useCallback((type: TabType, sessionId?: string, title?: string) => {
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

  const activeTab = tabs.find(t => t.id === activeTabId)

  return (
    <div className="flex h-full min-w-0 flex-col rounded-lg shadow-sm ring-1 ring-sidebar-border bg-sidebar overflow-hidden">
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
              {(Object.entries(tabMeta) as [TabType, TabMeta][]).map(([type, { icon: Icon, label }]) => (
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
          <TabContent tab={activeTab} />
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
