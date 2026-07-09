import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import {
  Archive,
  ArchiveRestore,
  Bot,
  BrainCircuit,
  ChevronDown,
  Ellipsis,
  Folder,
  FolderPlus,
  LogOut,
  MessageSquare,
  Monitor,
  Moon,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Settings,
  Sun,
  Terminal,
  Trash2,
  User,
} from "lucide-react"

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
import { ConfirmDialog } from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
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
import type { FolderInfo, SessionInfo } from "@/shared/chat"
import { useSessionStore } from "@/src/stores/session-store"
import { SettingsDialog } from "@/src/components/settings-dialog"

type MenuItem = { icon: React.ReactNode; label: string; onSelect: () => void }

function NewChatButton() {
  const { mode, setView } = useWorkspace()
  const selectSession = useSessionStore((s) => s.selectSession)
  return (
    <Button
      variant="outline"
      className="w-full justify-start gap-2 text-sm"
      onClick={() => {
        setView("chat")
        void selectSession(mode, null)
      }}
    >
      <Plus className="size-4" />
      {mode === "chat" ? "Novo Chat" : "Nova sessão"}
    </Button>
  )
}

function MemoriesButton() {
  const { view, setView } = useWorkspace()
  const active = view === "memories"
  return (
    <Button
      variant="ghost"
      className={cn(
        "w-full justify-start gap-2 text-sm",
        active && "bg-sidebar-accent text-sidebar-accent-foreground",
      )}
      onClick={() => setView(active ? "chat" : "memories")}
    >
      <BrainCircuit className="size-4" />
      Memórias
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

function AccordionGroup({ label, defaultExpanded = true, action, children }: {
  label: string
  defaultExpanded?: boolean
  action?: React.ReactNode
  children: React.ReactNode
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  return (
    <SidebarGroup>
      <SidebarGroupLabel
        className="flex cursor-pointer items-center gap-2"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <span className="flex-1 truncate">{label}</span>
        {action}
        <ChevronDown className={cn("size-3 shrink-0 transition-transform", !expanded && "-rotate-90")} />
      </SidebarGroupLabel>
      {expanded && <SidebarGroupContent>{children}</SidebarGroupContent>}
    </SidebarGroup>
  )
}

function EllipsisMenu({ items, groupClass = "group-hover/menu-item:opacity-100", buttonClassName }: {
  items: MenuItem[]
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
          className={cn(
            "absolute right-1 top-1.5 flex size-5 items-center justify-center rounded-[calc(var(--radius-sm)-2px)] p-0 text-sidebar-foreground group-hover/menu-row:bg-sidebar-accent group-hover/menu-row:text-sidebar-accent-foreground [&>svg]:size-4 [&>svg]:shrink-0",
            "opacity-0 transition-all duration-200",
            groupClass,
            menuOpen && "opacity-100",
            buttonClassName,
          )}
      >
        <Ellipsis className="size-4" />
        <span className="sr-only">Opções</span>
      </button>
      {menuOpen && createPortal(
        <div
          ref={menuRef}
          className="fixed z-50 w-48 rounded-lg border bg-popover/70 p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 backdrop-blur-2xl backdrop-saturate-150"
          style={{ top: menuPos.top, left: menuPos.left }}
        >
          {items.map((item, i) => (
            <div
              key={i}
              className="flex min-h-7 cursor-default items-center gap-2 rounded-md px-2 py-1 text-xs outline-hidden select-none hover:bg-foreground/10"
              onClick={() => {
                setMenuOpen(false)
                item.onSelect()
              }}
            >
              {item.icon}
              {item.label}
            </div>
          ))}
        </div>,
        document.body
      )}
    </>
  )
}

function PromptDialog({ open, onOpenChange, title, initialValue = "", placeholder, onSubmit }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  initialValue?: string
  placeholder?: string
  onSubmit: (value: string) => void
}) {
  const [value, setValue] = useState(initialValue)

  useEffect(() => {
    if (open) setValue(initialValue)
  }, [open, initialValue])

  const submit = () => {
    const trimmed = value.trim()
    if (trimmed) onSubmit(trimmed)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit()
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={submit}>Salvar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function MoveToFolderDialog({ open, onOpenChange, session }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  session: SessionInfo
}) {
  const folders = useSessionStore((s) => s.folders).filter((f) => f.mode === session.mode)
  const moveToFolder = useSessionStore((s) => s.moveToFolder)
  const createFolder = useSessionStore((s) => s.createFolder)
  const [newName, setNewName] = useState("")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Adicionar a pasta</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-1">
          {folders.map((folder) => (
            <Button
              key={folder.id}
              variant={session.folderId === folder.id ? "secondary" : "ghost"}
              className="justify-start gap-2"
              onClick={() => {
                moveToFolder(session.id, folder.id)
                onOpenChange(false)
              }}
            >
              <Folder className="size-4" />
              {folder.name}
            </Button>
          ))}
          {session.folderId && (
            <Button
              variant="ghost"
              className="justify-start gap-2 text-muted-foreground"
              onClick={() => {
                moveToFolder(session.id, null)
                onOpenChange(false)
              }}
            >
              <Trash2 className="size-4" />
              Remover da pasta atual
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Input
            value={newName}
            placeholder="Nova pasta…"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newName.trim()) {
                const folder = createFolder(session.mode, newName.trim())
                moveToFolder(session.id, folder.id)
                onOpenChange(false)
              }
            }}
          />
          <Button
            variant="outline"
            disabled={!newName.trim()}
            onClick={() => {
              const folder = createFolder(session.mode, newName.trim())
              moveToFolder(session.id, folder.id)
              onOpenChange(false)
            }}
          >
            Criar
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SessionRow({ session, button: ButtonComponent, buttonClassName, actionButtonClassName, icon: Icon = MessageSquare, statusDot, trailing }: {
  session: SessionInfo
  button: React.ElementType
  buttonClassName?: string
  actionButtonClassName?: string
  /** Ícone à esquerda (padrão: balão de chat; workers usam Bot/Terminal) */
  icon?: React.ElementType
  /** Status da sessão exibido como dot (workers da orquestração) */
  statusDot?: string
  /** Nó extra dentro do botão (ex: chevron de expandir do orquestrador) */
  trailing?: React.ReactNode
}) {
  const { mode, setMode, setView } = useWorkspace()
  const selectSession = useSessionStore((s) => s.selectSession)
  const activeId = useSessionStore((s) => s.activeIds[mode])
  const togglePin = useSessionStore((s) => s.togglePin)
  const toggleArchive = useSessionStore((s) => s.toggleArchive)
  const deleteSession = useSessionStore((s) => s.deleteSession)
  const renameSession = useSessionStore((s) => s.renameSession)

  const [confirmDelete, setConfirmDelete] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [movingToFolder, setMovingToFolder] = useState(false)

  const menuItems: MenuItem[] = [
    {
      icon: session.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />,
      label: session.pinned ? "Desafixar" : "Fixar",
      onSelect: () => togglePin(session.id),
    },
    {
      icon: <Folder className="size-4" />,
      label: "Adicionar a pasta",
      onSelect: () => setMovingToFolder(true),
    },
    { icon: <Pencil className="size-4" />, label: "Renomear", onSelect: () => setRenaming(true) },
    {
      icon: session.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />,
      label: session.archived ? "Desarquivar" : "Arquivar",
      onSelect: () => toggleArchive(session.id),
    },
    { icon: <Trash2 className="size-4" />, label: "Deletar", onSelect: () => setConfirmDelete(true) },
  ]

  return (
    <div className="group/menu-row relative min-w-0">
      <ButtonComponent
        isActive={activeId === session.id}
        onClick={() => {
          // Workers podem ter modo diferente do workspace atual (ex: worker code
          // de um orquestrador chat) — acompanha o modo da sessão
          if (session.mode !== mode) setMode(session.mode)
          setView("chat")
          void selectSession(session.mode, session.id)
        }}
        className={cn(
          "group-hover/menu-row:bg-sidebar-accent group-hover/menu-row:text-sidebar-accent-foreground",
          "text-xs",
          session.pinned ? "group-hover/menu-row:pr-10" : "group-hover/menu-row:pr-8",
          buttonClassName,
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 truncate">
          <Icon className="size-4 shrink-0" />
          <span className="truncate">{session.title}</span>
          {(statusDot === "submitted" || statusDot === "streaming") && (
            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" />
          )}
          {statusDot === "error" && (
            <span className="size-1.5 shrink-0 rounded-full bg-destructive" />
          )}
          {trailing}
        </div>
        {session.pinned && <Pin className="!size-3 shrink-0 text-sidebar-foreground/40" />}
      </ButtonComponent>
      <EllipsisMenu
        groupClass="group-hover/menu-row:opacity-100"
        buttonClassName={cn("w-0 overflow-hidden group-hover/menu-row:w-5", actionButtonClassName)}
        items={menuItems}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Excluir conversa?"
        description={`"${session.title}" e todas as suas mensagens serão excluídas permanentemente.`}
        confirmLabel="Excluir"
        destructive
        onConfirm={() => void deleteSession(session.id)}
      />
      <PromptDialog
        open={renaming}
        onOpenChange={setRenaming}
        title="Renomear conversa"
        initialValue={session.title}
        onSubmit={(title) => renameSession(session.id, title)}
      />
      {movingToFolder && (
        <MoveToFolderDialog open={movingToFolder} onOpenChange={setMovingToFolder} session={session} />
      )}
    </div>
  )
}

function SessionItem({ session, childSessions = [] }: {
  session: SessionInfo
  childSessions?: SessionInfo[]
}) {
  const [expanded, setExpanded] = useState(true)
  const statusMap = useSessionStore((s) => s.status)
  const hasChildren = childSessions.length > 0

  return (
    <SidebarMenuItem>
      <SessionRow
        button={SidebarMenuButton}
        session={session}
        trailing={
          hasChildren ? (
            <span
              role="button"
              tabIndex={0}
              className="flex size-4 shrink-0 items-center justify-center rounded hover:bg-sidebar-foreground/10"
              onClick={(e) => {
                e.stopPropagation()
                setExpanded((prev) => !prev)
              }}
            >
              <ChevronDown className={cn("size-3 transition-transform", !expanded && "-rotate-90")} />
            </span>
          ) : undefined
        }
      />
      {hasChildren && expanded && (
        <SidebarMenuSub className="mr-0">
          {childSessions.map((child) => (
            <SidebarMenuSubItem key={child.id}>
              <SessionRow
                button={SidebarMenuSubButton}
                actionButtonClassName="top-1"
                session={child}
                icon={child.mode === "code" ? Terminal : Bot}
                statusDot={statusMap[child.id]}
              />
            </SidebarMenuSubItem>
          ))}
        </SidebarMenuSub>
      )}
    </SidebarMenuItem>
  )
}

function FolderItem({ folder, sessions }: { folder: FolderInfo; sessions: SessionInfo[] }) {
  const [expanded, setExpanded] = useState(true)
  const { mode } = useWorkspace()
  const selectSession = useSessionStore((s) => s.selectSession)
  const renameFolder = useSessionStore((s) => s.renameFolder)
  const toggleFolderPin = useSessionStore((s) => s.toggleFolderPin)
  const deleteFolder = useSessionStore((s) => s.deleteFolder)

  const [confirmDelete, setConfirmDelete] = useState(false)
  const [renaming, setRenaming] = useState(false)

  return (
    <SidebarMenuItem>
      <div className="group/menu-row relative min-w-0">
        <SidebarMenuButton
          className={cn(
            "group-hover/menu-row:bg-sidebar-accent group-hover/menu-row:text-sidebar-accent-foreground",
            "text-xs",
            folder.pinned ? "group-hover/menu-row:pr-14" : "group-hover/menu-row:pr-12",
          )}
          onClick={() => setExpanded((prev) => !prev)}
        >
          <Folder className="size-4 shrink-0" />
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
            <span className="truncate">{folder.name}</span>
            <ChevronDown className={cn("size-3 shrink-0 transition-transform", !expanded && "-rotate-90")} />
          </div>
          {folder.pinned && <Pin className="!size-3 shrink-0 text-sidebar-foreground/40" />}
        </SidebarMenuButton>

        <button
          onClick={(e) => {
            e.stopPropagation()
            // Novo chat dentro da pasta: limpa a seleção e pré-atribui a pasta
            void useSessionStore
              .getState()
              .createSession(mode, { folderId: folder.id })
              .then((session) => selectSession(mode, session.id))
          }}
          className="absolute right-7 top-1.5 flex h-5 w-0 items-center justify-center overflow-hidden rounded-[calc(var(--radius-sm)-2px)] p-0 text-sidebar-foreground transition-all duration-200 group-hover/menu-row:w-5 group-hover/menu-row:bg-sidebar-accent group-hover/menu-row:text-sidebar-accent-foreground [&>svg]:size-4 [&>svg]:shrink-0"
        >
          <Plus className="size-4 shrink-0" />
          <span className="sr-only">Adicionar</span>
        </button>

        <EllipsisMenu
          groupClass="group-hover/menu-row:opacity-100"
          buttonClassName="w-0 overflow-hidden group-hover/menu-row:w-5"
          items={[
            { icon: <Pencil className="size-4" />, label: "Renomear", onSelect: () => setRenaming(true) },
            {
              icon: folder.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />,
              label: folder.pinned ? "Desafixar" : "Fixar",
              onSelect: () => toggleFolderPin(folder.id),
            },
            { icon: <Trash2 className="size-4" />, label: "Remover", onSelect: () => setConfirmDelete(true) },
          ]}
        />
      </div>

      {expanded && sessions.length > 0 && (
        <SidebarMenuSub className="mr-0">
          {sessions.map((session) => (
            <SidebarMenuSubItem key={session.id}>
              <SessionRow
                button={SidebarMenuSubButton}
                actionButtonClassName="top-1"
                session={session}
              />
            </SidebarMenuSubItem>
          ))}
        </SidebarMenuSub>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Remover pasta?"
        description={`As conversas de "${folder.name}" não serão excluídas — voltarão para a lista principal.`}
        confirmLabel="Remover"
        destructive
        onConfirm={() => deleteFolder(folder.id)}
      />
      <PromptDialog
        open={renaming}
        onOpenChange={setRenaming}
        title="Renomear pasta"
        initialValue={folder.name}
        onSubmit={(name) => renameFolder(folder.id, name)}
      />
    </SidebarMenuItem>
  )
}

function ChatHistory() {
  const { mode } = useWorkspace()
  const sessions = useSessionStore((s) => s.sessions)
  const folders = useSessionStore((s) => s.folders)
  const createFolder = useSessionStore((s) => s.createFolder)
  const [creatingFolder, setCreatingFolder] = useState(false)

  const modeSessions = useMemo(
    () => sessions.filter((s) => s.mode === mode),
    [sessions, mode],
  )
  // Workers ficam agrupados sob o orquestrador (independente do modo do worker)
  const childrenByParent = useMemo(() => {
    const map: Record<string, SessionInfo[]> = {}
    for (const s of sessions) {
      if (s.parentId && !s.archived) (map[s.parentId] ??= []).push(s)
    }
    return map
  }, [sessions])
  const active = modeSessions.filter((s) => !s.archived && !s.parentId)
  const archived = modeSessions.filter((s) => s.archived && !s.parentId)
  const modeFolders = folders.filter((f) => f.mode === mode)
  const sortedFolders = [...modeFolders.filter((f) => f.pinned), ...modeFolders.filter((f) => !f.pinned)]
  const rootSessions = active.filter((s) => !s.folderId || !modeFolders.some((f) => f.id === s.folderId))
  const pinned = rootSessions.filter((s) => s.pinned)
  const recent = rootSessions.filter((s) => !s.pinned)

  return (
    <>
      <AccordionGroup
        label="Pastas"
        action={
          <button
            onClick={(e) => {
              e.stopPropagation()
              setCreatingFolder(true)
            }}
            className="flex size-4 items-center justify-center rounded hover:bg-sidebar-accent"
            title="Nova pasta"
          >
            <FolderPlus className="size-3" />
          </button>
        }
      >
        <SidebarMenu>
          {sortedFolders.map((folder) => (
            <FolderItem
              key={folder.id}
              folder={folder}
              sessions={active.filter((s) => s.folderId === folder.id)}
            />
          ))}
          {sortedFolders.length === 0 && (
            <div className="px-3 py-1 text-xs text-sidebar-foreground/50">Nenhuma pasta</div>
          )}
        </SidebarMenu>
      </AccordionGroup>

      <AccordionGroup label="Chats">
        <SidebarMenu>
          {pinned.map((session) => (
            <SessionItem key={session.id} session={session} childSessions={childrenByParent[session.id]} />
          ))}
          {recent.map((session) => (
            <SessionItem key={session.id} session={session} childSessions={childrenByParent[session.id]} />
          ))}
          {pinned.length === 0 && recent.length === 0 && (
            <div className="px-3 py-1 text-xs text-sidebar-foreground/50">Nenhuma conversa ainda</div>
          )}
        </SidebarMenu>
      </AccordionGroup>

      {archived.length > 0 && (
        <AccordionGroup label="Arquivados" defaultExpanded={false}>
          <SidebarMenu>
            {archived.map((session) => (
              <SessionItem key={session.id} session={session} />
            ))}
          </SidebarMenu>
        </AccordionGroup>
      )}

      <PromptDialog
        open={creatingFolder}
        onOpenChange={setCreatingFolder}
        title="Nova pasta"
        placeholder="Nome da pasta"
        onSubmit={(name) => createFolder(mode, name)}
      />
    </>
  )
}

function AccountDropdown({ onOpenSettings }: { onOpenSettings: () => void }) {
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
          <AvatarFallback>OR</AvatarFallback>
        </Avatar>
        <div className="flex flex-1 flex-col truncate">
          <span className="truncate font-medium">Orbit</span>
          <span className="truncate text-sidebar-foreground/60">Assistente local</span>
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
          <DropdownMenuItem onClick={onOpenSettings}>
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

export function AppSidebar() {
  const initialize = useSessionStore((s) => s.initialize)
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    void initialize()
  }, [initialize])

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
          <div className="px-3 pb-2">
            <MemoriesButton />
          </div>
          <SidebarSeparator className="mx-3" />
          <ChatHistory />
        </div>
      </SidebarContent>
      <SidebarFooter className="p-0">
        <SidebarSeparator className="mx-3" />
        <AccountSection onOpenSettings={() => setSettingsOpen(true)} />
      </SidebarFooter>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </Sidebar>
  )
}

function AccountSection({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="flex items-center px-3 py-2">
      <AccountDropdown onOpenSettings={onOpenSettings} />
    </div>
  )
}
