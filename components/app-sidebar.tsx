import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { ChevronDown, Circle, Ellipsis, Folder, MessageSquare, Pin, Plus, Terminal, Trash2, User, Archive, Pencil, Settings, LogOut, Sun, Moon, Monitor } from "lucide-react"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarSeparator,
} from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import { useTheme } from "@/components/theme-provider"
import { useWorkspace, WorkspaceMode } from "@/lib/workspace-context"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

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
          { id: "chat-c3", title: "API de usuários - revisão" },
        ],
      },
      {
        id: "chat-folder-2",
        name: "Infraestrutura",
        chats: [
          { id: "chat-c4", title: "Configurar Docker Compose" },
          { id: "chat-c5", title: "Pipeline CI/CD" },
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
      { id: "code-pinned-2", title: "Refatorar API service layer" },
    ],
    folders: [
      {
        id: "code-folder-1",
        name: "Componentes",
        chats: [
          { id: "code-c1", title: "Criar componente DataTable" },
          { id: "code-c2", title: "Migrar Button para variantes" },
          { id: "code-c3", title: "Implementar virtual scroll" },
        ],
      },
      {
        id: "code-folder-2",
        name: "Utils",
        chats: [
          { id: "code-c4", title: "Função de formatação de data" },
          { id: "code-c5", title: "Validação de CPF/CNPJ" },
        ],
      },
    ],
    recent: [
      { id: "code-recent-1", title: "Script de migração BD" },
      { id: "code-recent-2", title: "Otimizar consultas N+1" },
    ],
  },
}

function NewChatButton() {
  const { mode } = useWorkspace()
  return (
    <Button variant="outline" className="w-full justify-start gap-2 text-sm">
      <Plus className="size-4" />
      {mode === "chat" ? "Novo Chat" : "Novo Código"}
    </Button>
  )
}

function ModeTabs() {
  const { mode, setMode } = useWorkspace()

  return (
    <Tabs value={mode} onValueChange={(v) => setMode(v as WorkspaceMode)}>
      <TabsList className="w-full">
        <TabsTrigger value="chat" className="flex-1 gap-1.5">
          <MessageSquare className="size-3.5" />
          Chat
        </TabsTrigger>
        <TabsTrigger value="code" className="flex-1 gap-1.5">
          <Terminal className="size-3.5" />
          Código
        </TabsTrigger>
      </TabsList>
    </Tabs>
  )
}

function EllipsisMenu({ items, groupClass = "group-hover/menu-item:opacity-100", buttonClassName }: {
  items: { icon: React.ReactNode; label: string }[]
  groupClass?: string
  buttonClassName?: string
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 })
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (menuOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect()
      setMenuPos({ top: rect.bottom + 4, left: rect.left })
    }
  }, [menuOpen])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false)
      }
    }
    if (menuOpen) {
      document.addEventListener("mousedown", handleClickOutside)
      return () => document.removeEventListener("mousedown", handleClickOutside)
    }
  }, [menuOpen])

  return (
    <>
      <button
        ref={buttonRef}
        onClick={(e) => {
          e.stopPropagation()
          setMenuOpen((prev) => !prev)
        }}
        data-slot="sidebar-menu-action"
        data-sidebar="menu-action"
          className={cn(
            "absolute right-1 top-1 flex size-5 items-center justify-center rounded-[calc(var(--radius-sm)-2px)] p-0 text-sidebar-foreground group-hover/menu-row:bg-sidebar-accent group-hover/menu-row:text-sidebar-accent-foreground [&>svg]:size-4 [&>svg]:shrink-0",
            "opacity-0 transition-all duration-200",
            groupClass,
            menuOpen && "opacity-100",
            buttonClassName,
          )}
      >
        <Ellipsis className="size-4" />
        <span className="sr-only">Opções</span>
      </button>
      {menuOpen && (
        <div
          ref={menuRef}
          className="fixed z-50 w-48 rounded-lg border bg-popover/70 p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 backdrop-blur-2xl backdrop-saturate-150"
          style={{ top: menuPos.top, left: menuPos.left }}
        >
          {items.map((item, i) => (
            <div
              key={i}
              className="flex min-h-7 cursor-default items-center gap-2 rounded-md px-2 py-1 text-xs outline-hidden select-none hover:bg-foreground/10"
              onClick={() => setMenuOpen(false)}
            >
              {item.icon}
              {item.label}
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function ChatRow({ chat, menuItems, button: Button, buttonClassName }: {
  chat: { id: string; title: string }
  menuItems?: { icon: React.ReactNode; label: string }[]
  button: React.ElementType
  buttonClassName?: string
}) {
  return (
    <div className="group/menu-row relative min-w-0">
      <Button className={cn("group-hover/menu-row:pr-8 hover:bg-transparent hover:text-sidebar-foreground group-hover/menu-row:bg-sidebar-accent group-hover/menu-row:text-sidebar-accent-foreground text-xs", buttonClassName)}>
        <MessageSquare className="size-4" />
        <span>{chat.title}</span>
      </Button>
      <EllipsisMenu
        groupClass="group-hover/menu-row:opacity-100"
        buttonClassName="w-0 overflow-hidden group-hover/menu-row:w-5"
        items={menuItems ?? [
          { icon: <Pin className="size-4" />, label: "Fixar" },
          { icon: <Pencil className="size-4" />, label: "Renomear" },
          { icon: <Folder className="size-4" />, label: "Adicionar a pasta" },
          { icon: <Archive className="size-4" />, label: "Arquivar" },
          { icon: <Trash2 className="size-4" />, label: "Deletar" },
        ]}
      />
    </div>
  )
}

function ChatItem({ chat, menuItems }: { chat: { id: string; title: string }; menuItems?: { icon: React.ReactNode; label: string }[] }) {
  return (
    <SidebarMenuItem>
      <ChatRow
        button={SidebarMenuButton}
        buttonClassName="!pr-0"
        chat={chat}
        menuItems={menuItems}
      />
    </SidebarMenuItem>
  )
}

function FolderItem({ folder }: { folder: { id: string; name: string; chats: { id: string; title: string }[] } }) {
  const [expanded, setExpanded] = useState(true)

  return (
    <SidebarMenuItem>
      <div className="group/menu-row relative min-w-0">
        <SidebarMenuButton className="hover:bg-transparent hover:text-sidebar-foreground group-hover/menu-row:bg-sidebar-accent group-hover/menu-row:text-sidebar-accent-foreground text-xs">
          <Folder className="size-4" />
          <span>{folder.name}</span>
        </SidebarMenuButton>

        <button
          onClick={(e) => {
            e.stopPropagation()
            setExpanded((prev) => !prev)
          }}
          data-slot="sidebar-menu-action"
          data-sidebar="menu-action"
          className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-[calc(var(--radius-sm)-2px)] p-0 text-sidebar-foreground transition-all duration-200 group-hover/menu-row:bg-sidebar-accent group-hover/menu-row:text-sidebar-accent-foreground group-hover/menu-row:right-8 [&>svg]:size-4 [&>svg]:shrink-0"
        >
          <ChevronDown className={cn("size-4 transition-transform", expanded && "rotate-180")} />
          <span className="sr-only">Expandir pasta</span>
        </button>

        <EllipsisMenu
          groupClass="group-hover/menu-row:opacity-100"
          buttonClassName="w-0 overflow-hidden group-hover/menu-row:w-5"
          items={[
            { icon: <Pencil className="size-4" />, label: "Renomear" },
            { icon: <Pin className="size-4" />, label: "Fixar" },
            { icon: <Circle className="size-4" />, label: "Alterar cor" },
            { icon: <Archive className="size-4" />, label: "Arquivar" },
            { icon: <Trash2 className="size-4" />, label: "Remover" },
          ]}
        />
      </div>

      {expanded && (
        <SidebarMenuSub className="mr-0">
          {folder.chats.map((chat) => (
            <SidebarMenuSubItem key={chat.id}>
              <ChatRow
                button={SidebarMenuSubButton}
                chat={chat}
                menuItems={[
                  { icon: <Pin className="size-4" />, label: "Fixar" },
                  { icon: <Pencil className="size-4" />, label: "Renomear" },
                  { icon: <Archive className="size-4" />, label: "Arquivar" },
                  { icon: <Trash2 className="size-4" />, label: "Deletar" },
                ]}
              />
            </SidebarMenuSubItem>
          ))}
        </SidebarMenuSub>
      )}
    </SidebarMenuItem>
  )
}

function ChatHistory() {
  const { mode } = useWorkspace()
  const data = workspaces[mode]

  return (
    <>
      <SidebarGroup>
        <SidebarGroupLabel>Fixados</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {data.folders.length > 0 && <FolderItem folder={data.folders[0]} />}
            {data.pinned.map((chat) => (
              <ChatItem key={chat.id} chat={chat} />
            ))}
            {data.folders.length > 1 && <FolderItem folder={data.folders[1]} />}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <SidebarGroup>
        <SidebarGroupLabel>Projetos</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {data.folders.map((folder) => (
              <FolderItem key={folder.id} folder={folder} />
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <SidebarGroup>
        <SidebarGroupLabel>Recentes</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {data.recent.map((chat) => (
              <ChatItem key={chat.id} chat={chat} />
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  )
}

function AccountDropdown() {
  const { theme, setTheme } = useTheme()
  const [themeOpen, setThemeOpen] = useState(false)
  const themeTimeoutRef = useRef<ReturnType<typeof setTimeout>>()

  const openTheme = () => {
    clearTimeout(themeTimeoutRef.current)
    setThemeOpen(true)
  }

  const closeTheme = () => {
    themeTimeoutRef.current = setTimeout(() => setThemeOpen(false), 100)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2 rounded-md p-2 text-left text-xs hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
        <Avatar size="sm">
          <AvatarImage src="" />
          <AvatarFallback>JD</AvatarFallback>
        </Avatar>
        <div className="flex flex-1 flex-col truncate">
          <span className="truncate font-medium">João Desenvolvedor</span>
          <span className="truncate text-sidebar-foreground/60">joao@email.com</span>
        </div>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        className="w-56"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel>Minha Conta</DropdownMenuLabel>
          <DropdownMenuItem>
            <User className="size-4" />
            Perfil
          </DropdownMenuItem>
          <DropdownMenuItem>
            <Settings className="size-4" />
            Configurações
          </DropdownMenuItem>
          <DropdownMenuSub open={themeOpen} onOpenChange={setThemeOpen}>
            <DropdownMenuSubTrigger
              onMouseEnter={openTheme}
              onMouseLeave={closeTheme}
            >
              <Sun className="size-4" />
              Alterar tema
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent
              onMouseEnter={openTheme}
              onMouseLeave={closeTheme}
            >
              <DropdownMenuItem onClick={() => setTheme("light")}>
                <Sun className="size-4" />
                Claro
                {theme === "light" && <span className="ml-auto text-xs">✓</span>}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setTheme("dark")}>
                <Moon className="size-4" />
                Escuro
                {theme === "dark" && <span className="ml-auto text-xs">✓</span>}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setTheme("system")}>
                <Monitor className="size-4" />
                Sistema
                {theme === "system" && <span className="ml-auto text-xs">✓</span>}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem>
          <LogOut className="size-4" />
          Sair
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function AccountSection() {
  return (
    <div className="flex items-center p-2">
      <AccountDropdown />
    </div>
  )
}

export function AppSidebar() {
  return (
    <Sidebar variant="floating" collapsible="offcanvas">
      <SidebarHeader>
        <ModeTabs />
      </SidebarHeader>
      <SidebarContent>
        <div className="flex min-w-0 flex-col overflow-x-hidden">
          <div className="px-3 py-2">
            <NewChatButton />
          </div>
          <SidebarSeparator className="mx-3" />
          <ChatHistory />
        </div>
      </SidebarContent>
      <SidebarFooter>
        <SidebarSeparator className="mx-3" />
        <AccountSection />
      </SidebarFooter>
    </Sidebar>
  )
}
