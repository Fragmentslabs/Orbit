import { useCallback, useState } from "react"
import { Globe, Folder, MessageSquare, Terminal, X, PlusIcon } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ChatView } from "@/src/components/chat-view"
import { TerminalTab } from "@/src/components/terminal-tab"
import { BrowserTab } from "@/src/components/browser-tab"
import { cn } from "@/lib/utils"

type TabType = "chat" | "terminal" | "folders" | "browser"

interface PanelTab {
  id: string
  type: TabType
  title: string
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
}

function TabContent({ type }: { type: TabType }) {
  switch (type) {
    case "chat":
      return (
        <div className="flex flex-1 flex-col overflow-hidden p-4">
          <ChatView />
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
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Pastas
        </div>
      )
    case "browser":
      return (
        <div className="flex flex-1 flex-col overflow-hidden">
          <BrowserTab />
        </div>
      )
  }
}

function SelectorScreen({ onSelect }: { onSelect: (type: TabType) => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-6 gap-4">
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
    </div>
  )
}

let tabCounter = 0

export function RightPanel() {
  const [tabs, setTabs] = useState<PanelTab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)

  const addTab = useCallback((type: TabType) => {
    const meta = tabMeta[type]
    tabCounter++
    const id = `${type}-${tabCounter}`
    const title = `${meta.label} ${tabCounter > 1 ? tabCounter : ""}`.trim()
    const newTab: PanelTab = { id, type, title }
    setTabs(prev => [...prev, newTab])
    setActiveTabId(id)
  }, [])

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
    <div className="flex h-full flex-col rounded-lg shadow-sm ring-1 ring-sidebar-border bg-sidebar overflow-hidden">
      {tabs.length > 0 && (
        <div className="flex items-center gap-0.5 px-2 pt-2 overflow-x-auto">
          {tabs.map((tab) => {
            const { icon: Icon } = tabMeta[tab.type]
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
                <Icon className="size-3.5 shrink-0" />
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

      <div className="flex flex-1 flex-col overflow-hidden">
        {activeTab ? (
          <TabContent type={activeTab.type} />
        ) : (
          <SelectorScreen onSelect={addTab} />
        )}
      </div>
    </div>
  )
}
