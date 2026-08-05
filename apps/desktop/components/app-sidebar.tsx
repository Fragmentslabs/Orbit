import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { createPortal } from "react-dom"
import { useDraggable } from "@dnd-kit/core"
import {
  Archive,
  ArchiveRestore,
  BarChart3,
  Bot,
  Boxes,
  BrainCircuit,
  Check,
  CheckSquare,
  ChevronDown,
  Ellipsis,
  ExternalLink,
  Folder,
  FolderPlus,
  GitFork,
  Loader2,
  LogOut,
  MessageSquare,
  Monitor,
  Moon,
  Puzzle,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Settings,
  Smartphone,
  Square,
  Sun,
  Terminal,
  Trash2,
  User,
  X,
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
import { usePanelStore } from "@/src/stores/panel-store"
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
import type { FolderInfo, SessionInfo } from "@shared/chat"
import { useMessageQueueStore, startMessageScheduler } from "@/src/stores/message-queue-store"
import { useSessionStore } from "@/src/stores/session-store"
import { useSettingsUi } from "@/src/stores/settings-ui"
import { SettingsDialog } from "@/src/components/settings-dialog"
import { ConnectAppDialog } from "@/components/connect-app-dialog"

type MenuItem = { icon: React.ReactNode; label: string; onSelect: () => void; separator?: boolean; destructive?: boolean }

/** Modo de seleção em lote — ativado pela opção "Selecionar" do menu de ações.
 *  Disponibiliza toggle de ids (chats e pastas) e fica/levanta contexto via hook. */
interface SelectionContextValue {
  selectionMode: boolean
  selectedIds: Set<string>
  selectedFolderIds: Set<string>
  toggle: (id: string) => void
  toggleFolder: (id: string) => void
  enterSelectionMode: (initialId?: string, initialFolderId?: string) => void
  exitSelectionMode: () => void
  clearSelection: () => void
}
const SelectionContext = createContext<SelectionContextValue>({
  selectionMode: false,
  selectedIds: new Set<string>(),
  selectedFolderIds: new Set<string>(),
  toggle: () => {},
  toggleFolder: () => {},
  enterSelectionMode: () => {},
  exitSelectionMode: () => {},
  clearSelection: () => {},
})
const useSelection = () => useContext(SelectionContext)

function SelectionProvider({ children }: { children: React.ReactNode }) {
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(new Set())

  const toggle = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleFolder = useCallback((id: string) => {
    setSelectedFolderIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const enterSelectionMode = useCallback((initialId?: string, initialFolderId?: string) => {
    setSelectionMode(true)
    if (initialId) {
      setSelectedIds(new Set([initialId]))
    }
    if (initialFolderId) {
      setSelectedFolderIds(new Set([initialFolderId]))
    }
  }, [])

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false)
    setSelectedIds(new Set())
    setSelectedFolderIds(new Set())
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
    setSelectedFolderIds(new Set())
  }, [])

  // Auto-exit selection mode when nothing is selected
  useEffect(() => {
    if (selectionMode && selectedIds.size === 0 && selectedFolderIds.size === 0) {
      setSelectionMode(false)
    }
  }, [selectedIds.size, selectedFolderIds.size, selectionMode])

  return (
    <SelectionContext.Provider
      value={{
        selectionMode,
        selectedIds,
        selectedFolderIds,
        toggle,
        toggleFolder,
        enterSelectionMode,
        exitSelectionMode,
        clearSelection,
      }}
    >
      {children}
    </SelectionContext.Provider>
  )
}

function NewChatButton() {
  const { t } = useTranslation()
  const { mode, setView, setFolders } = useWorkspace()
  const selectSession = useSessionStore((s) => s.selectSession)
  return (
    <Button
      variant="outline"
      className="w-full justify-start gap-2 text-sm"
      onClick={() => {
        setView("chat")
        // Nova sessão herda as pastas de trabalho do último chat do modo
        if (mode === "code") {
          const last = [...useSessionStore.getState().sessions]
            .filter((s) => s.mode === "code" && !s.archived && !s.parentId && !!s.directory)
            .sort((a, b) => b.updatedAt - a.updatedAt)[0]
          if (last) setFolders([last.directory!, ...(last.extraDirectories ?? [])])
        }
        void selectSession(mode, null)
      }}
    >
      <Plus className="size-4" />
      {mode === "chat" ? t("sidebar.newChat") : t("sidebar.newSession")}
    </Button>
  )
}

function MemoriesButton() {
  const { t } = useTranslation()
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
      {t("sidebar.memories")}
    </Button>
  )
}

function ModelsButton() {
  const { view, setView } = useWorkspace()
  const active = view === "models"
  return (
    <Button
      variant="ghost"
      className={cn(
        "w-full justify-start gap-2 text-sm",
        active && "bg-sidebar-accent text-sidebar-accent-foreground",
      )}
      onClick={() => setView(active ? "chat" : "models")}
    >
      <Boxes className="size-4" />
      Models
    </Button>
  )
}

function McpSkillsButton() {
  const { t } = useTranslation()
  const { mode } = useWorkspace()
  const openSettings = useSettingsUi((s) => s.openSettings)
  if (mode !== "code") return null
  return (
    <Button
      variant="ghost"
      className="w-full justify-start gap-2 text-sm"
      onClick={() => openSettings("mcp-skills")}
    >
      <Puzzle className="size-4" />
      {t("sidebar.tools")}
    </Button>
  )
}

function UsageButton() {
  const { t } = useTranslation()
  const openSettings = useSettingsUi((s) => s.openSettings)
  return (
    <Button
      variant="ghost"
      className="w-full justify-start gap-2 text-sm"
      onClick={() => openSettings("analytics")}
    >
      <BarChart3 className="size-4" />
      {t("sidebar.usage")}
    </Button>
  )
}

function ModeTabs() {
  const { t } = useTranslation()
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
          {t("sidebar.code")}
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
  const { t } = useTranslation()
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
        <span className="sr-only">{t("sidebar.options")}</span>
      </button>
      {menuOpen && createPortal(
        <div
          ref={menuRef}
          className="fixed z-50 w-48 rounded-lg border bg-popover/70 p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 backdrop-blur-2xl backdrop-saturate-150"
          style={{ top: menuPos.top, left: menuPos.left }}
        >
          {items.map((item, i) => (
            item.separator ? (
              <div key={i} className="my-1 border-t border-foreground/10" />
            ) : (
              <div
                key={i}
                className={cn(
                  "flex min-h-7 cursor-default items-center gap-2 rounded-md px-2 py-1 text-xs outline-hidden select-none hover:bg-foreground/10",
                  item.destructive && "text-red-500 hover:bg-red-500/10",
                )}
                onClick={() => {
                  setMenuOpen(false)
                  item.onSelect()
                }}
              >
                {item.icon}
                {item.label}
              </div>
            )
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
  const { t } = useTranslation()
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
      <DialogContent className="sm:max-w-sm" showCloseButton={false}>
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
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button onClick={submit}>{t("common.save")}</Button>
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
  const { t } = useTranslation()
  const folders = useSessionStore((s) => s.folders).filter((f) => f.mode === session.mode)
  const moveToFolder = useSessionStore((s) => s.moveToFolder)
  const createFolder = useSessionStore((s) => s.createFolder)
  const [newName, setNewName] = useState("")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("sidebar.folder.addToFolder")}</DialogTitle>
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
              {t("sidebar.folder.removeFromCurrent")}
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Input
            value={newName}
            placeholder={t("sidebar.folder.newFolderPlaceholder")}
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
            {t("sidebar.create")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Chave do localStorage que guarda quais pastas ficam abertas (id → aberta). */
const FOLDER_EXPANDED_KEY = "orbit.sidebar.folder-expanded"

function loadExpandedFolders(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(FOLDER_EXPANDED_KEY)
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

function persistExpandedFolder(id: string, expanded: boolean) {
  try {
    const map = loadExpandedFolders()
    map[id] = expanded
    localStorage.setItem(FOLDER_EXPANDED_KEY, JSON.stringify(map))
  } catch {
    // localStorage indisponível — ignora silenciosamente
  }
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
  const { t } = useTranslation()
  const { mode, setMode, setView } = useWorkspace()
  const selectSession = useSessionStore((s) => s.selectSession)
  const activeId = useSessionStore((s) => s.activeIds[mode])
  const unreadCounts = useSessionStore((s) => s.unreadCounts)
  const togglePin = useSessionStore((s) => s.togglePin)
  const toggleArchive = useSessionStore((s) => s.toggleArchive)
  const deleteSession = useSessionStore((s) => s.deleteSession)
  const renameSession = useSessionStore((s) => s.renameSession)
  const forkSession = useSessionStore((s) => s.forkSession)
  const { selectionMode, selectedIds, toggle, enterSelectionMode } = useSelection()

  const isSelected = selectedIds.has(session.id)

  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: session.id,
    data: { sessionId: session.id, title: session.title },
    disabled: selectionMode,
  })

  const [confirmDelete, setConfirmDelete] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [movingToFolder, setMovingToFolder] = useState(false)

  const menuItems: MenuItem[] = [
    {
      icon: session.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />,
      label: session.pinned ? t("sidebar.session.unpin") : t("sidebar.session.pin"),
      onSelect: () => togglePin(session.id),
    },
    {
      icon: <Folder className="size-4" />,
      label: t("sidebar.folder.addToFolder"),
      onSelect: () => setMovingToFolder(true),
    },
    { icon: <Pencil className="size-4" />, label: t("sidebar.session.rename"), onSelect: () => setRenaming(true) },
    {
      icon: <GitFork className="size-4" />,
      label: t("sidebar.session.fork"),
      onSelect: () => {
        void forkSession(session.id).then((fork) => {
          if (!fork) return
          if (fork.mode !== mode) setMode(fork.mode)
          setView("chat")
          void selectSession(fork.mode, fork.id)
        })
      },
    },
    {
      icon: <ExternalLink className="size-4" />,
      label: t("sidebar.session.openBeside"),
      onSelect: () => usePanelStore.getState().openChatTab(session.id, session.title),
    },
    {
      icon: session.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />,
      label: session.archived ? t("sidebar.session.unarchive") : t("sidebar.session.archive"),
      onSelect: () => toggleArchive(session.id),
    },
    { icon: <CheckSquare className="size-4" />, label: t("sidebar.session.select"), onSelect: () => enterSelectionMode(session.id) },
    { separator: true, icon: <></>, label: "", onSelect: () => {} },
    { icon: <Trash2 className="size-4" />, label: t("sidebar.session.delete"), onSelect: () => setConfirmDelete(true), destructive: true },
  ]

  const handleClick = () => {
    if (selectionMode) {
      toggle(session.id)
    } else {
      if (session.mode !== mode) setMode(session.mode)
      setView("chat")
      void selectSession(session.mode, session.id)
    }
  }

  return (
    <div ref={setNodeRef} className={cn("group/menu-row relative min-w-0", isDragging && "opacity-50")}>
      <ButtonComponent
        isActive={activeId === session.id}
        onClick={handleClick}
        {...(!selectionMode ? { ...listeners, ...attributes } : {})}
        className={cn(
          "group-hover/menu-row:bg-sidebar-accent group-hover/menu-row:text-sidebar-accent-foreground",
          "text-xs",
          session.pinned ? "group-hover/menu-row:pr-10" : "group-hover/menu-row:pr-8",
          buttonClassName,
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 truncate">
          {selectionMode ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                toggle(session.id)
              }}
              className="flex size-4 shrink-0 items-center justify-center rounded border border-sidebar-border hover:bg-sidebar-accent transition-colors"
            >
              {isSelected && <Check className="size-3 text-primary" />}
            </button>
) : (
            <Icon className="size-4 shrink-0" />
          )}
          <span className="truncate">{session.title}</span>
          {(statusDot === "submitted" || statusDot === "streaming") && (
            <Loader2 className="size-3 shrink-0 animate-spin text-primary" />
          )}
          {statusDot === "error" && (
            <span className="size-1.5 shrink-0 rounded-full bg-destructive" />
          )}
          {statusDot !== "submitted" && statusDot !== "streaming" && unreadCounts[session.id] > 0 && activeId !== session.id && (
            <span className="size-2 shrink-0 rounded-full bg-primary" />
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
        title={t("sidebar.session.deleteTitle")}
        description={t("sidebar.session.deleteDescription", { title: session.title })}
        confirmLabel={t("sidebar.session.confirmDelete")}
        destructive
        onConfirm={() => void deleteSession(session.id)}
      />
      <PromptDialog
        open={renaming}
        onOpenChange={setRenaming}
        title={t("sidebar.session.renameTitle")}
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
                icon={Bot}
                statusDot={statusMap[child.id]}
              />
            </SidebarMenuSubItem>
          ))}
        </SidebarMenuSub>
      )}
    </SidebarMenuItem>
  )
}

function SessionRowWithChildren({ session, childSessions, hasChildren }: {
  session: SessionInfo
  childSessions: SessionInfo[]
  hasChildren: boolean
}) {
  const [childExpanded, setChildExpanded] = useState(true)
  const statusMap = useSessionStore((s) => s.status)

  return (
    <>
      <SessionRow
        button={SidebarMenuSubButton}
        actionButtonClassName="top-1"
        session={session}
        statusDot={statusMap[session.id]}
        trailing={
          hasChildren ? (
            <span
              role="button"
              tabIndex={0}
              className="flex size-4 shrink-0 items-center justify-center rounded hover:bg-sidebar-foreground/10"
              onClick={(e) => {
                e.stopPropagation()
                setChildExpanded((prev) => !prev)
              }}
            >
              <ChevronDown className={cn("size-3 transition-transform", !childExpanded && "-rotate-90")} />
            </span>
          ) : undefined
        }
      />
      {hasChildren && childExpanded && (
        <div className="ml-3 border-l border-sidebar-border pl-2">
          {childSessions.map((child) => (
            <div key={child.id} className="py-0.5">
              <SessionRow
                button={SidebarMenuSubButton}
                actionButtonClassName="top-1"
                session={child}
                icon={Bot}
                statusDot={statusMap[child.id]}
              />
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function FolderItem({ folder, sessions, childrenByParent = {} }: {
  folder: FolderInfo
  sessions: SessionInfo[]
  childrenByParent?: Record<string, SessionInfo[]>
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(() => loadExpandedFolders()[folder.id] ?? false)
  const { mode, setFolders } = useWorkspace()
  const renameFolder = useSessionStore((s) => s.renameFolder)
  const toggleFolderPin = useSessionStore((s) => s.toggleFolderPin)
  const deleteFolder = useSessionStore((s) => s.deleteFolder)
  const { selectionMode, selectedFolderIds, toggleFolder, enterSelectionMode } = useSelection()

  const [confirmDelete, setConfirmDelete] = useState(false)
  const [renaming, setRenaming] = useState(false)

  const isSelected = selectedFolderIds.has(folder.id)

  const handleClick = (e: React.MouseEvent) => {
    if (selectionMode) {
      e.stopPropagation()
      toggleFolder(folder.id)
} else {
      setExpanded((prev) => {
        const next = !prev
        persistExpandedFolder(folder.id, next)
        return next
      })
    }
  }

  return (
    <SidebarMenuItem>
      <div className="group/menu-row relative min-w-0">
        <SidebarMenuButton
          className={cn(
            "group-hover/menu-row:bg-sidebar-accent group-hover/menu-row:text-sidebar-accent-foreground",
            "text-xs",
            folder.pinned ? "group-hover/menu-row:pr-14" : "group-hover/menu-row:pr-12",
          )}
          onClick={handleClick}
        >
          {selectionMode ? (
            <button
              onClick={(e) => {
                e.stopPropagation()
                toggleFolder(folder.id)
              }}
              className="flex size-4 items-center justify-center rounded border border-sidebar-border bg-background shrink-0 hover:bg-sidebar-accent transition-colors"
              aria-label={isSelected ? t("sidebar.folder.unmark") : t("sidebar.folder.mark")}
            >
              {isSelected ? <Check className="size-3 text-primary" /> : <Square className="size-3 text-sidebar-foreground/40" />}
            </button>
          ) : (
            <Folder className="size-4 shrink-0" />
          )}
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
            <span className="truncate">{folder.name}</span>
            {!selectionMode && <ChevronDown className={cn("size-3 shrink-0 transition-transform", !expanded && "-rotate-90")} />}
          </div>
          {folder.pinned && <Pin className="!size-3 shrink-0 text-sidebar-foreground/40" />}
        </SidebarMenuButton>

        {!selectionMode && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              // Novo chat na pasta: a sessão só é criada ao enviar a 1ª mensagem.
              // Herda as pastas de trabalho do chat mais recente da pasta e guarda
              // a pasta para a criação futura (evita a "Nova sessão de código" em branco).
              const mostRecent = sessions.reduce<SessionInfo | undefined>(
                (best, s) => (best && s.updatedAt <= best.updatedAt ? best : s),
                undefined,
              )
              if (mostRecent?.directory) {
                setFolders([mostRecent.directory, ...(mostRecent.extraDirectories ?? [])])
              }
              const store = useSessionStore.getState()
              void store.selectSession(mode, null)
              store.setPendingFolder(folder.id)
            }}
            className="absolute right-7 top-1.5 flex h-5 w-0 items-center justify-center overflow-hidden rounded-[calc(var(--radius-sm)-2px)] p-0 text-sidebar-foreground transition-all duration-200 group-hover/menu-row:w-5 group-hover/menu-row:text-sidebar-accent-foreground [&>svg]:size-4 [&>svg]:shrink-0"
          >
            <Plus className="size-4 shrink-0" />
            <span className="sr-only">{t("sidebar.folder.add")}</span>
          </button>
        )}

        <EllipsisMenu
          groupClass="group-hover/menu-row:opacity-100"
          buttonClassName="w-0 overflow-hidden group-hover/menu-row:w-5"
          items={[
            { icon: <Pencil className="size-4" />, label: t("sidebar.session.rename"), onSelect: () => setRenaming(true) },
            {
              icon: folder.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />,
              label: folder.pinned ? t("sidebar.session.unpin") : t("sidebar.session.pin"),
              onSelect: () => toggleFolderPin(folder.id),
            },
            { icon: <Trash2 className="size-4" />, label: t("sidebar.folder.remove"), onSelect: () => setConfirmDelete(true) },
            selectionMode
              ? null
              : { icon: <CheckSquare className="size-4" />, label: t("sidebar.session.select"), onSelect: () => enterSelectionMode(undefined, folder.id) },
          ].filter(Boolean) as MenuItem[]}
        />
      </div>

      {expanded && sessions.length > 0 && (
        <SidebarMenuSub className="mr-0">
          {sessions.map((session) => {
            const childSessions = childrenByParent[session.id]
            const hasChildren = childSessions?.length > 0
            return (
              <SidebarMenuSubItem key={session.id}>
                <SessionRowWithChildren
                  session={session}
                  childSessions={childSessions ?? []}
                  hasChildren={hasChildren}
                />
              </SidebarMenuSubItem>
            )
          })}
        </SidebarMenuSub>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("sidebar.folder.deleteTitle")}
        description={t("sidebar.folder.deleteDescription", { name: folder.name })}
        confirmLabel={t("sidebar.folder.remove")}
        destructive
        onConfirm={() => deleteFolder(folder.id)}
      />
      <PromptDialog
        open={renaming}
        onOpenChange={setRenaming}
        title={t("sidebar.folder.rename")}
        initialValue={folder.name}
        onSubmit={(name) => renameFolder(folder.id, name)}
      />
    </SidebarMenuItem>
  )
}

function ChatHistory() {
  const { t } = useTranslation()
  const { mode } = useWorkspace()
  const sessions = useSessionStore((s) => s.sessions)
  const folders = useSessionStore((s) => s.folders)
  const createFolder = useSessionStore((s) => s.createFolder)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const { selectionMode, selectedIds, selectedFolderIds, exitSelectionMode } = useSelection()
  const deleteSessions = useSessionStore((s) => s.deleteSessions)
  const deleteFolder = useSessionStore((s) => s.deleteFolder)

  const totalSelected = selectedIds.size + selectedFolderIds.size

  const handleBulkDelete = async () => {
    if (selectedIds.size > 0) {
      await deleteSessions(Array.from(selectedIds))
    }
    if (selectedFolderIds.size > 0) {
      for (const id of selectedFolderIds) {
        deleteFolder(id)
      }
    }
    exitSelectionMode()
  }

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
      {selectionMode && totalSelected > 0 && (
        <div className="flex items-center justify-between gap-2 px-3 pb-1 pt-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={exitSelectionMode}
              className="flex size-4 items-center justify-center rounded hover:bg-sidebar-foreground/10 transition-colors"
              aria-label={t("sidebar.selection.exit")}
            >
              <X className="size-3" />
            </button>
            <span className="text-xs font-medium text-sidebar-foreground">
              {t("sidebar.selection.selectedCount", { count: totalSelected })}
            </span>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={handleBulkDelete} className="text-red-500 hover:text-red-400 hover:bg-red-500/10" aria-label={t("sidebar.selection.deleteSelected")}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      )}

      <AccordionGroup
        label={t("sidebar.groups.folders")}
        action={
          !selectionMode && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setCreatingFolder(true)
              }}
              className="flex size-4 items-center justify-center rounded"
              title={t("sidebar.folder.newFolderTitle")}
            >
              <FolderPlus className="size-3" />
            </button>
          )
        }
      >
        <SidebarMenu>
          {sortedFolders.map((folder) => (
            <FolderItem
              key={folder.id}
              folder={folder}
              sessions={active.filter((s) => s.folderId === folder.id)}
              childrenByParent={childrenByParent}
            />
          ))}
          {sortedFolders.length === 0 && (
            <div className="px-3 py-1 text-xs text-sidebar-foreground/50">{t("sidebar.folder.none")}</div>
          )}
        </SidebarMenu>
      </AccordionGroup>

      <AccordionGroup label={t("sidebar.groups.chats")}>
        <SidebarMenu>
          {pinned.map((session) => (
            <SessionItem key={session.id} session={session} childSessions={childrenByParent[session.id]} />
          ))}
          {recent.map((session) => (
            <SessionItem key={session.id} session={session} childSessions={childrenByParent[session.id]} />
          ))}
          {pinned.length === 0 && recent.length === 0 && (
            <div className="px-3 py-1 text-xs text-sidebar-foreground/50">{t("sidebar.groups.noChats")}</div>
          )}
        </SidebarMenu>
      </AccordionGroup>

      {archived.length > 0 && (
        <AccordionGroup label={t("sidebar.groups.archived")} defaultExpanded={false}>
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
        title={t("sidebar.folder.newFolderTitle")}
        placeholder={t("sidebar.folder.folderNamePlaceholder")}
        onSubmit={(name) => createFolder(mode, name)}
      />
    </>
  )
}

function AccountDropdown({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useTranslation()
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
          <span className="truncate text-sidebar-foreground/60">{t("sidebar.account.localAssistant")}</span>
        </div>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        className="w-56"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t("sidebar.account.myAccount")}</DropdownMenuLabel>
          <DropdownMenuItem>
            <User className="size-4" />
            {t("sidebar.account.profile")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onOpenSettings}>
            <Settings className="size-4" />
            {t("sidebar.account.settings")}
          </DropdownMenuItem>
          <DropdownMenuSub open={themeOpen} onOpenChange={setThemeOpen}>
            <DropdownMenuSubTrigger
              onMouseEnter={openTheme}
              onMouseLeave={closeTheme}
            >
              <Sun className="size-4" />
              {t("sidebar.account.changeTheme")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent
              onMouseEnter={openTheme}
              onMouseLeave={closeTheme}
            >
              <DropdownMenuItem onClick={() => setTheme("light")}>
                <Sun className="size-4" />
                {t("sidebar.account.light")}
                {theme === "light" && <span className="ml-auto text-xs">✓</span>}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setTheme("dark")}>
                <Moon className="size-4" />
                {t("sidebar.account.dark")}
                {theme === "dark" && <span className="ml-auto text-xs">✓</span>}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setTheme("system")}>
                <Monitor className="size-4" />
                {t("sidebar.account.system")}
                {theme === "system" && <span className="ml-auto text-xs">✓</span>}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem>
          <LogOut className="size-4" />
          {t("sidebar.account.logout")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function AppSidebar() {
  const initialize = useSessionStore((s) => s.initialize)
  const initQueue = useMessageQueueStore((s) => s.initialize)
  const settingsOpen = useSettingsUi((s) => s.open)
  const settingsTab = useSettingsUi((s) => s.tab)
  const setSettingsOpen = useSettingsUi((s) => s.setOpen)
  const openSettings = useSettingsUi((s) => s.openSettings)

  useEffect(() => {
    void initialize()
    void initQueue()
    startMessageScheduler()
  }, [initialize, initQueue])

  return (
    <SelectionProvider>
      <Sidebar variant="floating" collapsible="offcanvas">
        <SidebarHeader>
          <ModeTabs />
        </SidebarHeader>
        <SidebarContent>
          <div className="flex min-w-0 flex-col overflow-x-hidden select-none">
            <div className="px-2 py-2">
              <NewChatButton />
            </div>
            <div className="space-y-1 px-2 pb-2">
              <MemoriesButton />
              <ModelsButton />
              <UsageButton />
              <McpSkillsButton />
            </div>
            <SidebarSeparator className="mx-3" />
            <ChatHistory />
          </div>
        </SidebarContent>
        <SidebarFooter className="p-0">
          <AccountSection onOpenSettings={() => openSettings()} />
        </SidebarFooter>
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} initialTab={settingsTab} />
      </Sidebar>
    </SelectionProvider>
  )
}

function AccountSection({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useTranslation()
  const [connectOpen, setConnectOpen] = useState(false)

  return (
    <>
      <ConnectAppDialog open={connectOpen} onOpenChange={setConnectOpen} />
      <div className="flex flex-col gap-1 px-2 py-2">
        <Button
          variant="ghost"
          onClick={() => setConnectOpen(true)}
          className="w-full justify-start gap-2 text-xs font-normal text-muted-foreground hover:text-foreground rounded-sm p-2"
        >
          <Smartphone className="size-4" />
          {t("sidebar.account.connectApp")}
        </Button>
        <SidebarSeparator className="my-1" />
        <AccountDropdown onOpenSettings={onOpenSettings} />
      </div>
    </>
  )
}
