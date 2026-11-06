import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { createPortal } from "react-dom"
import { useDraggable } from "@dnd-kit/core"
import {
  Archive,
  ArchiveRestore,
  BarChart3,
  Bot,
  BrainCircuit,
  CalendarClock,
  Layers,
  Check,
  CheckSquare,
  ChevronDown,
  Ellipsis,
  ExternalLink,
  Folder,
  FolderPlus,
  GitFork,
  Heart,
  Loader2,
  MessageSquare,
  MessagesSquare,
  Monitor,
  Moon,
  Puzzle,
  Pencil,
  Phone,
  Pin,
  PinOff,
  Plus,
  Settings,
  Smartphone,
  Square,
  Sun,
  Terminal,
  Trash2,
  Wand2,
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
import { DeleteChatDialog } from "@/src/components/delete-chat-dialog"
import { NewFolderDialog } from "@/src/components/new-folder-dialog"
import { usePanelStore } from "@/src/stores/panel-store"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
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
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { sessionActivityMap, type FolderInfo, type SessionInfo } from "@shared/chat"
import { useMessageQueueStore, startMessageScheduler } from "@/src/stores/message-queue-store"
import { useSessionStore } from "@/src/stores/session-store"
import { useVoiceActivity } from "@/src/stores/voice-activity"
import { useSettingsUi } from "@/src/stores/settings-ui"
import { KO_FI_URL } from "@/src/lib/appLinks"
import {
  useDraggedMovableSession,
  useSidebarDropTarget,
  type SessionDragData,
  type SidebarDropTarget,
} from "@/src/components/session-drag"
import { ConnectAppDialog } from "@/components/connect-app-dialog"
import { EnvironmentSelector } from "@/src/components/peers/environment-selector"
import { RunningElsewhere } from "@/src/components/peers/running-elsewhere"
import { RemoteSessionList } from "@/src/components/peers/remote-session-list"
import { startPeersMirror, usePeersStore } from "@/src/stores/peers-store"
import { Truncate } from "@/components/ui/truncated-text"

type MenuItem = { icon: React.ReactNode; label: string; onSelect: () => void; separator?: boolean; destructive?: boolean }

/** Batch selection mode — activated by the "Select" option of the actions menu.
 *  It provides the toggle of ids (chats and folders) and sets/lifts context through the hook. */
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
    // Chats of the folder that appear under it (archiving state equal to the
    // folder's) follow the selection — the user can uncheck them later.
    const { folders, sessions } = useSessionStore.getState()
    const folderArchived = folders.find((f) => f.id === id)?.archived ?? false
    const chatIds = sessions
      .filter((s) => s.folderId === id && s.archived === folderArchived)
      .map((s) => s.id)
    setSelectedFolderIds((prev) => {
      const next = new Set(prev)
      const selecting = !next.has(id)
      if (selecting) next.add(id)
      else next.delete(id)
      setSelectedIds((prevIds) => {
        const nextIds = new Set(prevIds)
        for (const cid of chatIds) {
          if (selecting) nextIds.add(cid)
          else nextIds.delete(cid)
        }
        return nextIds
      })
      return next
    })
  }, [])

  const enterSelectionMode = useCallback((initialId?: string, initialFolderId?: string) => {
    setSelectionMode(true)
    if (initialFolderId) {
      const { folders, sessions } = useSessionStore.getState()
      const folderArchived = folders.find((f) => f.id === initialFolderId)?.archived ?? false
      setSelectedIds(
        new Set(
          sessions
            .filter((s) => s.folderId === initialFolderId && s.archived === folderArchived)
            .map((s) => s.id),
        ),
      )
    } else if (initialId) {
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
        // New session inherits the working folders of the last chat of the mode
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

/**
 * Pipeline: a page of code mode, right below "new session". It is not an input
 * toggle — it is another way of working (a task pipeline, without a chat), so it
 * lives in the navigation, not among the modes of a conversation.
 */
function PipelineButton() {
  const { t } = useTranslation()
  const { mode, view, setView } = useWorkspace()
  const active = view === "pipeline"
  if (mode !== "code") return null
  return (
    <SidebarMenuButton isActive={active} onClick={() => setView(active ? "chat" : "pipeline")}>
      <Layers className="size-4" />
      {t("pipeline.title")}
    </SidebarMenuButton>
  )
}

/** Routines: scheduled chats, from both chat and code modes. The page inherits
 *  the active mode (the chat one only lists/creates chat routines), so the
 *  button exists in both modes — same navigation logic as the pipeline. */
function RoutinesButton() {
  const { t } = useTranslation()
  const { view, setView } = useWorkspace()
  const active = view === "routines"
  return (
    <SidebarMenuButton isActive={active} onClick={() => setView(active ? "chat" : "routines")}>
      <CalendarClock className="size-4" />
      {t("routines.title")}
    </SidebarMenuButton>
  )
}

function MemoriesButton() {
  const { t } = useTranslation()
  const { view, setView } = useWorkspace()
  const active = view === "memories"
  return (
    <SidebarMenuButton isActive={active} onClick={() => setView(active ? "chat" : "memories")}>
      <BrainCircuit className="size-4" />
      {t("sidebar.memories")}
    </SidebarMenuButton>
  )
}

function McpSkillsButton() {
  const { t } = useTranslation()
  const { mode, view, setView } = useWorkspace()
  if (mode !== "code") return null
  const active = view === "tools"
  return (
    <SidebarMenuButton isActive={active} onClick={() => setView(active ? "chat" : "tools")}>
      <Puzzle className="size-4" />
      {t("sidebar.tools")}
    </SidebarMenuButton>
  )
}

function UsageButton() {
  const { t } = useTranslation()
  const { view, setView } = useWorkspace()
  const active = view === "analytics"
  return (
    <SidebarMenuButton isActive={active} onClick={() => setView(active ? "chat" : "analytics")}>
      <BarChart3 className="size-4" />
      {t("sidebar.usage")}
    </SidebarMenuButton>
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

/** Area that receives a dragged conversation; it lights up only when dropping
 *  there changes something. */
function DropArea({ target, className, children }: {
  target: SidebarDropTarget
  className?: string
  children: React.ReactNode
}) {
  const { setNodeRef, highlighted } = useSidebarDropTarget(target)
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "rounded-lg transition-colors duration-150",
        highlighted && "bg-sidebar-accent/60 ring-1 ring-inset ring-primary/40",
        className,
      )}
    >
      {children}
    </div>
  )
}

function AccordionGroup({ label, defaultExpanded = true, action, dropTarget, children }: {
  label: string
  defaultExpanded?: boolean
  action?: React.ReactNode
  /** The whole group (title included, even collapsed) accepts dropped conversations. */
  dropTarget?: SidebarDropTarget
  children: React.ReactNode
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  const group = (
    <SidebarGroup>
      <SidebarGroupLabel
        className="flex cursor-pointer items-center gap-2"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <Truncate text={label}>
          <span className="flex-1 truncate">{label}</span>
        </Truncate>
        {action}
        <ChevronDown className={cn("size-3 shrink-0 transition-transform", !expanded && "-rotate-90")} />
      </SidebarGroupLabel>
      {expanded && <SidebarGroupContent>{children}</SidebarGroupContent>}
    </SidebarGroup>
  )
  return dropTarget ? <DropArea target={dropTarget}>{group}</DropArea> : group
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

  // Card near the end of the sidebar: always opening downwards leaked the menu
  // outside the viewport, leaving the items (and sometimes the back button
  // behind it) unclickable. The menu is already mounted in the DOM at this point (the portal
  // renders in the same commit that opens `menuOpen`), so the real height
  // can be measured before deciding the side — without that we would have to open it "blind".
  useLayoutEffect(() => {
    if (!menuOpen || !buttonRef.current) return
    const rect = buttonRef.current.getBoundingClientRect()
    const menuHeight = menuRef.current?.offsetHeight ?? 0
    const spaceBelow = window.innerHeight - rect.bottom
    const spaceAbove = rect.top
    // Prefers opening downwards; it only flips upwards when it does not fit below AND
    // there is more room up there — it avoids trading a small leak for a bigger one.
    const opensUpward = spaceBelow < menuHeight + 4 && spaceAbove > spaceBelow
    const top = opensUpward ? rect.top - menuHeight - 4 : rect.bottom + 4
    // Same idea on the horizontal axis: near the right edge of the window (menu
    // opened in the right panel, for example) the menu cannot leak there.
    const menuWidth = menuRef.current?.offsetWidth ?? 192
    const left = Math.min(rect.left, window.innerWidth - menuWidth - 8)
    setMenuPos({ top: Math.max(4, top), left: Math.max(4, left) })
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
  const folders = useSessionStore((s) => s.folders).filter((f) => f.mode === session.mode && !f.archived)
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

/** localStorage key that stores which folders stay open (id → open). */
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
    // localStorage unavailable — ignores it silently
  }
}

function SessionRow({ session, button: ButtonComponent, buttonClassName, actionButtonClassName, icon: Icon = MessageSquare, statusDot, trailing }: {
  session: SessionInfo
  button: React.ElementType
  buttonClassName?: string
  actionButtonClassName?: string
  /** Icon on the left (default: chat bubble; worker uses Bot, subchat uses
   *  MessagesSquare — the two nested bubbles say "conversation opened from here",
   *  without looking like an agent) */
  icon?: React.ElementType
  /** Session status shown as a dot (orchestration workers) */
  statusDot?: string
  /** Extra node inside the button (e.g. the orchestrator's expand chevron) */
  trailing?: React.ReactNode
}) {
  const { t } = useTranslation()
  const { mode, setMode, setView } = useWorkspace()
  const selectSession = useSessionStore((s) => s.selectSession)
  const activeId = useSessionStore((s) => s.activeIds[mode])
  const unreadCounts = useSessionStore((s) => s.unreadCounts)
  const pendingAsks = useSessionStore((s) => s.pendingAsks)
  // Call in progress in THIS conversation: the phone stays lit on the row, so the
  // person can find their way back without depending on the floating card.
  const inCallHere = useVoiceActivity((s) => s.inCall && s.callSessionId === session.id)
  const togglePin = useSessionStore((s) => s.togglePin)
  const toggleArchive = useSessionStore((s) => s.toggleArchive)
  const renameSession = useSessionStore((s) => s.renameSession)
  const forkSession = useSessionStore((s) => s.forkSession)
  const { selectionMode, selectedIds, toggle, enterSelectionMode } = useSelection()

  const isSelected = selectedIds.has(session.id)

  // Questions/permissions awaiting the user's answer: the agent is stopped
  // waiting for input (it is not working) — the status stays "streaming",
  // but the UI must indicate "needs your answer", not an activity spinner.
  const hasPendingAsk = (pendingAsks[session.id]?.length ?? 0) > 0

  const dragData: SessionDragData = {
    kind: "session",
    sessionId: session.id,
    title: session.title,
    icon: Icon,
    movable: !session.parentId && !session.routineId,
  }
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: session.id,
    data: dragData,
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
      // Sub-chats (side panel discussion, workers) belong to the parent's
      // session: opening a child cannot switch the sidebar section to the
      // child's mode (a sub-chat of a code session stays in "code").
      const targetMode = session.parentId
        ? (useSessionStore.getState().sessions.find((s) => s.id === session.parentId)?.mode ?? session.mode)
        : session.mode
      if (targetMode !== mode) setMode(targetMode)
      setView("chat")
      void selectSession(targetMode, session.id)
    }
  }

  return (
    // Dragging: the row disappears, but the space stays — the one that follows the cursor is the
    // ghost of the DragOverlay (session-drag.tsx).
    <div ref={setNodeRef} className={cn("group/menu-row relative min-w-0 transition-opacity duration-150", isDragging && "opacity-0")}>
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
        
          <Truncate>
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
              ) : inCallHere ? (
                // Call in this conversation: the phone TAKES the place of the chat bubble
                // instead of adding yet another icon to the row.
                <Phone aria-label={t("voice.call.inCall")} className="size-4 shrink-0 text-primary" />
              ) : (
                <Icon className="size-4 shrink-0" />
              )}
              <TooltipProvider delay={600}>
                <Tooltip>
                  <TooltipTrigger render={<span className="truncate" />}>{session.title}</TooltipTrigger>
                  <TooltipContent side="right" align="start" sideOffset={6}>
                    {session.title}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              {/* Statuses anchored to the right edge of the row. Without the
                  `ml-auto` they followed the title, so a short one left the
                  spinner in the middle of the line. */}
              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                {(statusDot === "submitted" || statusDot === "streaming") && !hasPendingAsk && (
                  <Loader2 className="size-3 shrink-0 animate-spin text-primary" />
                )}
                {hasPendingAsk && (
                  <span className="size-2 shrink-0 rounded-full bg-primary" title={t("sidebar.awaitingInput")} />
                )}
                {statusDot === "error" && (
                  <span className="size-1.5 shrink-0 rounded-full bg-destructive" />
                )}
                {!hasPendingAsk && statusDot !== "submitted" && statusDot !== "streaming" && statusDot !== "error" && unreadCounts[session.id] > 0 && activeId !== session.id && (
                  <span className="size-2 shrink-0 rounded-full bg-primary" />
                )}
                {trailing}
              </div>
            </div>
          </Truncate>
        {session.pinned && <Pin className="!size-3 shrink-0 text-sidebar-foreground/40" />}
      </ButtonComponent>
      <EllipsisMenu
        groupClass="group-hover/menu-row:opacity-100"
        buttonClassName={cn("w-0 overflow-hidden group-hover/menu-row:w-5", actionButtonClassName)}
        items={menuItems}
      />
      <DeleteChatDialog session={session} open={confirmDelete} onOpenChange={setConfirmDelete} />
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
        statusDot={statusMap[session.id]}
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
                icon={child.orchestration?.role === "worker" ? Bot : MessagesSquare}
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
                icon={child.orchestration?.role === "worker" ? Bot : MessagesSquare}
                statusDot={statusMap[child.id]}
              />
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/**
 * ACTIVE folder showing up inside "Archived" only to group its chats
 * that were archived.
 *
 * It is read-only on purpose: reusing FolderItem would make the folder expand
 * together with the one in "Folders" (the state is stored by folder.id) and would offer
 * renaming/archiving/deleting the real folder from here.
 *
 * No mirror folder is created in the storage: the chat keeps the folderId,
 * so it comes back on its own to the place when unarchived, and when the original folder
 * is archived the chats join it without duplicating the name.
 */
function ArchivedFolderGroup({ folder, sessions }: {
  folder: FolderInfo
  sessions: SessionInfo[]
}) {
  const [expanded, setExpanded] = useState(false)
  if (sessions.length === 0) return null
  return (
    <DropArea target={{ type: "archived", folderId: folder.id }}>
      <SidebarMenuItem>
        <SidebarMenuButton
          className="text-sidebar-foreground/70"
          onClick={() => setExpanded((v) => !v)}
        >
          <Folder className="size-4 shrink-0" />
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
            <Truncate text={folder.name}>
              <span className="truncate">{folder.name}</span>
            </Truncate>
            <span className="shrink-0 text-[10px] text-sidebar-foreground/40">{sessions.length}</span>
            <ChevronDown className={cn("size-3 shrink-0 transition-transform", !expanded && "-rotate-90")} />
          </div>
        </SidebarMenuButton>
      </SidebarMenuItem>
      {expanded && (
        <div className="ml-3 border-l border-sidebar-border pl-1">
          {sessions.map((session) => (
            <SessionItem key={session.id} session={session} />
          ))}
        </div>
      )}
    </DropArea>
  )
}

function FolderItem({ folder, sessions, childrenByParent = {} }: {
  folder: FolderInfo
  sessions: SessionInfo[]
  childrenByParent?: Record<string, SessionInfo[]>
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(() => loadExpandedFolders()[folder.id] ?? false)
  const { mode, setFolders, setView } = useWorkspace()
  const renameFolder = useSessionStore((s) => s.renameFolder)
  const toggleFolderPin = useSessionStore((s) => s.toggleFolderPin)
  const toggleFolderArchive = useSessionStore((s) => s.toggleFolderArchive)
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
      <DropArea target={{ type: "folder", folderId: folder.id, archived: !!folder.archived }}>
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
            <Truncate text={folder.name}>
              <span className="truncate">{folder.name}</span>
            </Truncate>
            {!selectionMode && <ChevronDown className={cn("size-3 shrink-0 transition-transform", !expanded && "-rotate-90")} />}
          </div>
          {folder.pinned && <Pin className="!size-3 shrink-0 text-sidebar-foreground/40" />}
        </SidebarMenuButton>

        {!selectionMode && !folder.archived && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              // New chat in the folder: goes back to the conversation screen
              // (the "+" is also clickable outside the chat, e.g. on the Pipeline
              // page) and the session is only created when the 1st message is sent.
              setView("chat")
              const store = useSessionStore.getState()
              // The folders come from the FOLDER ITSELF (its most recent chat or the
              // project the automatic map still points to). Reading the workspace
              // here made the "+" of an empty folder inherit the repository of the
              // last opened chat — another project.
              const workspaceFolders = store.folderWorkspace(folder.id)
              if (workspaceFolders) setFolders(workspaceFolders)
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
            {
              icon: folder.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />,
              label: folder.archived ? t("sidebar.folder.unarchive") : t("sidebar.folder.archive"),
              onSelect: () => toggleFolderArchive(folder.id),
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
      </DropArea>

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

/**
 * Action icon in the header of a sidebar group (organize, new folder).
 *
 * `size-5` around a 14px icon: a 16px target is hard to hit with
 * the mouse. The hover did not exist — the button changed nothing on mouse
 * over, so it did not look clickable — and the `cursor-pointer` has to be said
 * (Tailwind v4 leaves `button` with the default cursor).
 */
const GROUP_ACTION_CLASS =
  "flex size-5 cursor-pointer items-center justify-center rounded text-sidebar-foreground/60 outline-hidden transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"

function ChatHistory() {
  const { t } = useTranslation()
  const { mode } = useWorkspace()
  const sessions = useSessionStore((s) => s.sessions)
  const folders = useSessionStore((s) => s.folders)
  const createFolder = useSessionStore((s) => s.createFolder)
  const organizeSidebar = useSessionStore((s) => s.organizeSidebar)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const { selectionMode, selectedIds, selectedFolderIds, exitSelectionMode } = useSelection()
  const deleteSessions = useSessionStore((s) => s.deleteSessions)
  const deleteFolder = useSessionStore((s) => s.deleteFolder)

  const totalSelected = selectedIds.size + selectedFolderIds.size
  // During the drag, "Pinned" and "Archived" appear even when empty to
  // serve as a destination.
  const draggingSession = !!useDraggedMovableSession()

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

  // Position of a chat in the sidebar = activity of its block: its own or the one of the
  // most recent nested sub-chat/worker (sessionActivityMap). Touching a
  // side conversation raises the parent along with it — the order does not depend only on the
  // main chat.
  const activity = useMemo(() => sessionActivityMap(sessions), [sessions])
  const activityOf = (session: SessionInfo) => activity.get(session.id) ?? session.updatedAt

  // Routine chats leave the normal listing: they live in the "Routines" group
  // right below, and would show up duplicated (drowning the recent ones) if
  // they also entered "Chats" or the folders.
  const modeSessions = useMemo(
    () =>
      sessions
        .filter((s) => s.mode === mode && !s.routineId)
        .sort((a, b) => (activity.get(b.id) ?? b.updatedAt) - (activity.get(a.id) ?? a.updatedAt)),
    [sessions, mode, activity],
  )
  // "Routines" group of the active mode: each run's session inherits the mode
  // of the routine (scheduler.ts), so the chat sidebar only lists chat routines
  // and the code one only the code routines. No archived filter: routine chats
  // do not enter the "Archived" group (which comes from modeSessions), so
  // archiving one would make it vanish from the whole sidebar.
  const routineSessions = useMemo(
    () =>
      sessions
        .filter((s) => s.mode === mode && !!s.routineId)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions, mode],
  )
  // Workers are grouped under the orchestrator (regardless of the worker's mode)
  const childrenByParent = useMemo(() => {
    const map: Record<string, SessionInfo[]> = {}
    for (const s of sessions) {
      if (s.parentId && !s.archived) (map[s.parentId] ??= []).push(s)
    }
    for (const children of Object.values(map)) children.sort((a, b) => b.updatedAt - a.updatedAt)
    return map
  }, [sessions])
  const active = modeSessions.filter((s) => !s.archived && !s.parentId)
  const archivedSessions = modeSessions.filter((s) => s.archived && !s.parentId)
  const modeFolders = folders.filter((f) => f.mode === mode)
  const activeFolders = modeFolders.filter((f) => !f.archived)
  const archivedFolders = modeFolders.filter((f) => f.archived)
  const archivedFolderIds = useMemo(() => new Set(archivedFolders.map((f) => f.id)), [archivedFolders])
  const folderActivity = (folderId: string) => active
    .filter((s) => s.folderId === folderId)
    .reduce((latest, s) => Math.max(latest, activityOf(s)), 0)
  const sortedFolders = [...activeFolders].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return folderActivity(b.id) - folderActivity(a.id)
  })
  const sortedArchivedFolders = [...archivedFolders].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return b.createdAt - a.createdAt
  })
  const rootSessions = active
    // Only active folders "hold" chats at the root: a chat unarchived inside
    // an archived folder falls into the recent ones (the folder stays archived)
    .filter((s) => !s.folderId || !activeFolders.some((f) => f.id === s.folderId))
    .sort((a, b) => activityOf(b) - activityOf(a))
  // Loose archived ones: those of an ARCHIVED folder appear inside it; those of an
  // ACTIVE folder get a grouping by name right below — before they fell loose here
  // and lost the reference of the folder they belong to.
  const archivedInActiveFolders = archivedSessions.filter(
    (s) => s.folderId != null && !archivedFolderIds.has(s.folderId),
  )
  const activeFoldersWithArchived = activeFolders
    .filter((f) => archivedInActiveFolders.some((s) => s.folderId === f.id))
    .sort((a, b) => a.name.localeCompare(b.name))
  const archived = archivedSessions.filter((s) => !s.folderId)
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
            <TooltipProvider delay={300}>
              <div className="flex items-center gap-1">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label={t("sidebar.folder.organize")}
                        onClick={(e) => {
                          e.stopPropagation()
                          organizeSidebar()
                        }}
                        className={GROUP_ACTION_CLASS}
                      />
                    }
                  >
                    <Wand2 className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipContent side="top">{t("sidebar.folder.organize")}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label={t("sidebar.folder.newFolderTitle")}
                        onClick={(e) => {
                          e.stopPropagation()
                          setCreatingFolder(true)
                        }}
                        className={GROUP_ACTION_CLASS}
                      />
                    }
                  >
                    <FolderPlus className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipContent side="top">{t("sidebar.folder.newFolderTitle")}</TooltipContent>
                </Tooltip>
              </div>
            </TooltipProvider>
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

      {(pinned.length > 0 || draggingSession) && (
        <AccordionGroup label={t("sidebar.groups.pinned")} dropTarget={{ type: "pinned" }}>
          <SidebarMenu>
            {pinned.map((session) => (
              <SessionItem key={session.id} session={session} childSessions={childrenByParent[session.id]} />
            ))}
            {pinned.length === 0 && (
              <div className="mx-2 rounded-md border border-dashed border-sidebar-border px-2 py-1.5 text-xs text-sidebar-foreground/50">
                {t("sidebar.groups.dropToPin")}
              </div>
            )}
          </SidebarMenu>
        </AccordionGroup>
      )}

      <AccordionGroup label={t("sidebar.groups.chats")} dropTarget={{ type: "chats" }}>
        <SidebarMenu>
          {recent.map((session) => (
            <SessionItem key={session.id} session={session} childSessions={childrenByParent[session.id]} />
          ))}
          {recent.length === 0 && (
            <div className="px-3 py-1 text-xs text-sidebar-foreground/50">{t("sidebar.groups.noChats")}</div>
          )}
        </SidebarMenu>
      </AccordionGroup>

      {/* Expanded by default: this is where the running spinner and the
          "finished and unread" / error dots appear — collapsed, a routine would
          run with no sign on screen. */}
      {routineSessions.length > 0 && (
        <AccordionGroup label={t("sidebar.groups.routines")}>
          <SidebarMenu>
            {routineSessions.map((session) => (
              <SessionItem
                key={session.id}
                session={session}
                childSessions={childrenByParent[session.id]}
              />
            ))}
          </SidebarMenu>
        </AccordionGroup>
      )}

      {(archived.length > 0 ||
        sortedArchivedFolders.length > 0 ||
        activeFoldersWithArchived.length > 0 ||
        draggingSession) && (
        <AccordionGroup label={t("sidebar.groups.archived")} defaultExpanded={false} dropTarget={{ type: "archived" }}>
          <SidebarMenu>
            {sortedArchivedFolders.map((folder) => (
              <FolderItem
                key={folder.id}
                folder={folder}
                sessions={archivedSessions.filter((s) => s.folderId === folder.id)}
                childrenByParent={childrenByParent}
              />
            ))}
            {activeFoldersWithArchived.map((folder) => (
              <ArchivedFolderGroup
                key={`arch:${folder.id}`}
                folder={folder}
                sessions={archivedInActiveFolders.filter((s) => s.folderId === folder.id)}
              />
            ))}
            {archived.map((session) => (
              <SessionItem key={session.id} session={session} />
            ))}
          </SidebarMenu>
        </AccordionGroup>
      )}

      <NewFolderDialog
        open={creatingFolder}
        onOpenChange={setCreatingFolder}
        mode={mode}
        onCreate={(name, workspace) => createFolder(mode, name, workspace)}
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
        
          <Truncate>
              <div className="flex flex-col truncate">
            
                <Truncate>
                    <span className="truncate font-medium">Orbit</span>
                </Truncate>
              <a
                href="https://fragmentslabs.com"
                target="_blank"
                rel="noreferrer"
                className="truncate text-sidebar-foreground/60 hover:text-sidebar-foreground hover:underline"
                onClick={(event) => event.stopPropagation()}
              >
                {t("sidebar.account.byFragmentsLabs")}
            </a>
          </div>
          </Truncate>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        className="w-56"
      >
        <DropdownMenuGroup>
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
        <DropdownMenuItem onClick={() => window.open(KO_FI_URL, "_blank")}>
          <Heart className="size-4 text-rose-400" />
          {t("sidebar.account.support")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function AppSidebar() {
  const initialize = useSessionStore((s) => s.initialize)
  const initQueue = useMessageQueueStore((s) => s.initialize)
  const openSettings = useSettingsUi((s) => s.openSettings)
  // Another desktop picked in the environment selector: the list is that machine's.
  const env = usePeersStore((s) => s.env)

  useEffect(() => {
    void initialize()
    void initQueue()
    startMessageScheduler()
    startPeersMirror()
  }, [initialize, initQueue])

  return (
    <SelectionProvider>
      <Sidebar variant="floating" collapsible="offcanvas">
        <SidebarHeader>
          <ModeTabs />
          <EnvironmentSelector />
        </SidebarHeader>
        <SidebarContent>
          {env !== "local" ? (
            <div className="flex min-w-0 flex-col overflow-x-hidden pt-2 select-none">
              <RunningElsewhere />
              <RemoteSessionList peerId={env} />
            </div>
          ) : (
          <div className="flex min-w-0 flex-col overflow-x-hidden select-none">
            <div className="px-2 py-2">
              <NewChatButton />
            </div>
            <div className="space-y-1 px-2 pb-2">
              <PipelineButton />
              <RoutinesButton />
              <MemoriesButton />
              <UsageButton />
              <McpSkillsButton />
            </div>
            <SidebarSeparator className="mx-3" />
            <div className="pt-2">
              <RunningElsewhere />
            </div>
            <ChatHistory />
          </div>
          )}
        </SidebarContent>
        <SidebarFooter className="p-0">
          <AccountSection onOpenSettings={() => openSettings()} />
        </SidebarFooter>
      </Sidebar>
    </SelectionProvider>
  )
}

function AccountSection({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useTranslation()
  // In the peers store: the environment selector opens the same modal.
  const connectOpen = usePeersStore((s) => s.connectOpen)
  const setConnectOpen = usePeersStore((s) => s.setConnectOpen)

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
