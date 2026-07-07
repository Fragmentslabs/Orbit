import { useCallback, useState } from "react"
import { Globe, Folder, MessageSquare, Terminal, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/src/components/ai/prompt-input"
import { cn } from "@/lib/utils"

type TabType = "chat" | "terminal" | "folders" | "browser"

interface PanelTab {
  id: string
  type: TabType
  title: string
}

const tabMeta: Record<TabType, { icon: typeof MessageSquare; label: string }> = {
  chat: { icon: MessageSquare, label: "Chat" },
  terminal: { icon: Terminal, label: "Terminal" },
  folders: { icon: Folder, label: "Pastas" },
  browser: { icon: Globe, label: "Browser" },
}

function PanelChat() {
  return (
    <div className="flex flex-1 flex-col">
      <div className="flex-1" />
      <div className="px-3 pb-2">
        <PromptInput
          multiple
          onSubmit={(message) => {
            console.log("Right panel chat message:", message)
          }}
          className="rounded-xl border border-sidebar-border overflow-hidden [&>div]:!border-none [&>div]:!rounded-none [&>div]:!bg-transparent"
        >
          <PromptInputAttachments className="!px-3 !py-1.5">
            {(attachment) => <PromptInputAttachment data={attachment} />}
          </PromptInputAttachments>
          <PromptInputBody>
            <PromptInputTextarea placeholder="Pergunte qualquer coisa..." className="px-3 text-sm" />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              <PromptInputActionAddAttachments label="Anexar" />
            </PromptInputTools>
            <div className="flex items-center gap-1">
              <PromptInputSubmit />
            </div>
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  )
}

function TabContent({ type }: { type: TabType }) {
  switch (type) {
    case "chat":
      return <PanelChat />
    case "terminal":
      return (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Terminal
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
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Browser
        </div>
      )
  }
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
    setTabs(prev => {
      const next = [...prev, newTab]
      return next
    })
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
    <div className="flex h-full flex-col rounded-lg shadow-sm ring-1 ring-sidebar-border bg-sidebar">
      {tabs.length > 0 && (
        <div className="flex items-center gap-0.5 px-2 pt-2 overflow-x-auto">
          {tabs.map((tab) => {
            const { icon: Icon } = tabMeta[tab.type]
            return (
              <div
                key={tab.id}
                className={cn(
                  "group flex min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md px-2.5 py-1.5 text-xs transition-colors",
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
        </div>
      )}

      <div className={cn(
        "flex items-center gap-1",
        tabs.length > 0 ? "px-2 py-1.5" : "px-2 pt-2 pb-1.5",
      )}>
        {(Object.entries(tabMeta) as [TabType, typeof tabMeta[TabType]][]).map(([type, { icon: Icon, label }]) => (
          <Button
            key={type}
            variant="ghost"
            size="xs"
            className={cn(
              "gap-1",
              tabs.length === 0
                ? "flex-1"
                : "",
            )}
            onClick={() => addTab(type)}
          >
            <Icon className="size-3" />
            {tabs.length === 0 && label}
          </Button>
        ))}
      </div>

      <div className="flex flex-1 flex-col overflow-hidden border-t border-sidebar-border">
        {activeTab ? (
          <TabContent type={activeTab.type} />
        ) : (
          <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
            Selecione uma opção para começar
          </div>
        )}
      </div>
    </div>
  )
}
