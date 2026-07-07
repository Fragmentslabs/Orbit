import { useState } from "react"
import { Globe, Folder, MessageSquare, Terminal, ChevronDown, Pin } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
} from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import { useWorkspace, WorkspaceMode } from "@/lib/workspace-context"

const tabs = [
  { id: "chat", icon: MessageSquare, label: "Chat" },
  { id: "terminal", icon: Terminal, label: "Terminal" },
  { id: "folders", icon: Folder, label: "Pastas" },
  { id: "browser", icon: Globe, label: "Browser" },
] as const

type Tab = (typeof tabs)[number]["id"]

const workspaces: Record<WorkspaceMode, {
  pinned: { id: string; title: string }[]
  folders: { id: string; name: string; chats: { id: string; title: string }[] }[]
  recent: { id: string; title: string }[]
}> = {
  chat: {
    pinned: [
      { id: "chat-pinned-1", title: "Setup inicial do projeto" },
      { id: "chat-pinned-2", title: "Review de código - Sprint 5" },
    ],
    folders: [
      {
        id: "chat-folder-1",
        name: "Projeto Alpha",
        chats: [
          { id: "chat-c1", title: "Implementação de autenticação" },
          { id: "chat-c2", title: "Refatorar component Button" },
        ],
      },
    ],
    recent: [
      { id: "chat-recent-1", title: "Schema do banco de dados" },
      { id: "chat-recent-2", title: "Configurar ambiente de dev" },
    ],
  },
  code: {
    pinned: [
      { id: "code-pinned-1", title: "Gerar hook useDebounce" },
    ],
    folders: [
      {
        id: "code-folder-1",
        name: "Hooks",
        chats: [
          { id: "code-c1", title: "Criar hook useLocalStorage" },
        ],
      },
    ],
    recent: [
      { id: "code-recent-1", title: "Script de migração BD" },
    ],
  },
}

function AccordionGroup({ label, defaultExpanded = true, children }: {
  label: string
  defaultExpanded?: boolean
  children: React.ReactNode
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  return (
    <SidebarGroup>
      <SidebarGroupLabel
        className="flex cursor-pointer items-center gap-2"
        onClick={() => setExpanded(v => !v)}
      >
        <span className="flex-1 truncate">{label}</span>
        <ChevronDown className={cn("size-3 shrink-0 transition-transform", !expanded && "-rotate-90")} />
      </SidebarGroupLabel>
      {expanded && <SidebarGroupContent>{children}</SidebarGroupContent>}
    </SidebarGroup>
  )
}

function ChatHistory() {
  const { mode } = useWorkspace()
  const data = workspaces[mode]

  return (
    <div className="flex flex-col">
      <AccordionGroup label="Pastas">
        <SidebarMenu>
          {data.folders.map((folder) => (
            <SidebarMenuItem key={folder.id}>
              <SidebarMenuButton className="text-xs">
                <Folder className="size-4 shrink-0" />
                <span className="truncate">{folder.name}</span>
              </SidebarMenuButton>
              <SidebarMenuSub className="mr-0">
                {folder.chats.map((chat) => (
                  <SidebarMenuSubItem key={chat.id}>
                    <SidebarMenuSubButton className="text-xs">
                      <MessageSquare className="size-4 shrink-0" />
                      <span className="truncate">{chat.title}</span>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                ))}
              </SidebarMenuSub>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </AccordionGroup>
      <AccordionGroup label="Chats">
        <SidebarMenu>
          {data.pinned.map((chat) => (
            <SidebarMenuItem key={chat.id}>
              <SidebarMenuButton className="text-xs">
                <MessageSquare className="size-4 shrink-0" />
                <span className="truncate">{chat.title}</span>
                <Pin className="!size-3 shrink-0 text-sidebar-foreground/40 ml-auto" />
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
          {data.recent.map((chat) => (
            <SidebarMenuItem key={chat.id}>
              <SidebarMenuButton className="text-xs">
                <MessageSquare className="size-4 shrink-0" />
                <span className="truncate">{chat.title}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </AccordionGroup>
    </div>
  )
}

function TabContent({ tab }: { tab: Tab }) {
  switch (tab) {
    case "chat":
      return <ChatHistory />
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

export function RightPanel() {
  const [activeTab, setActiveTab] = useState<Tab>("chat")

  return (
    <div className="flex h-full flex-col rounded-lg shadow-sm ring-1 ring-sidebar-border bg-sidebar">
      <div className="flex h-12 items-center gap-0.5 px-2 border-b border-border">
        {tabs.map(({ id, icon: Icon, label }) => (
          <Button
            key={id}
            variant="ghost"
            size="sm"
            className={cn(
              "flex-1 gap-1.5 text-xs",
              activeTab === id
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground/60 hover:text-sidebar-foreground",
            )}
            onClick={() => setActiveTab(id)}
          >
            <Icon className="size-3.5" />
            {label}
          </Button>
        ))}
      </div>
      <div className="flex flex-1 flex-col overflow-auto">
        <TabContent tab={activeTab} />
      </div>
    </div>
  )
}
