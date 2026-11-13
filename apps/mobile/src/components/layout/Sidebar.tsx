import { useEffect, useMemo, useState, useCallback, useRef, memo } from 'react'
import type { ReactElement } from 'react'
import { View, Text, Pressable, Alert, Dimensions, SectionList } from 'react-native'
import type { GestureResponderEvent, SectionListData, SectionListRenderItemInfo } from 'react-native'
import Animated, {
  runOnJS,
  runOnUI,
  useAnimatedReaction,
  useAnimatedStyle,
} from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import {
  MessageSquare,
  MessagesSquare,
  Terminal,
  BrainCircuit,
  BarChart3,
  Bot,
  Puzzle,
  Images,
  Settings,
  LogOut,
  Plus,
  Folder,
  Loader2,
  Check,
  Square,
  X,
  Trash2,
  Pencil,
  Pin,
  PinOff,
  Archive,
  ArchiveRestore,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Search,
  CalendarClock,
  Layers,
  Wand2,
} from 'lucide-react-native'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { useConnectionStore } from '~/stores/connection-store'
import { useSessionStore } from '~/stores/session-store'
import { useDraftFolders } from '~/stores/draft-folders-store'
import { Storage } from '~/lib/storage'
import { Spin } from '~/components/ui/spin'
import { ActionMenu, type ActionMenuItem } from '~/components/ui/action-menu'
import { useConfirm } from '~/components/ui/confirm-dialog'
import { RenamePrompt } from '~/components/ui/rename-prompt'
import { cn } from '~/lib/utils'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import type { ThemeTokens } from '~/lib/theme-tokens'
import { sessionActivityMap, type SessionInfo, type FolderInfo } from '@orbit/shared'
import {
  DRAWER_WIDTH,
  animateDrawer,
  backdropOpacity,
  drawerTranslateX,
} from '~/components/layout/sidebar-anim'

/** Same key as the desktop (app-sidebar) — open/closed folders persisted. */
const FOLDER_EXPANDED_KEY = 'orbit.sidebar.folder-expanded'

/** Sentinel items for empty sections — SectionList does not call renderItem
 *  for sections with empty data, so the empty-state text is an item. */
const EMPTY_CHATS_ITEM = { __empty: 'chats-empty' as const }
const EMPTY_FOLDERS_ITEM = { __empty: 'folders-empty' as const }

/** Stable empty array — a fixed identity avoids breaking the memo of SessionRow. */
const EMPTY_CHILDREN: SessionInfo[] = []

type EmptyItem = { __empty: 'chats-empty' | 'folders-empty' }
type ChatListItem = SessionInfo | FolderInfo | EmptyItem

/** Sections of the virtualized list: group headers (accordion), folders
 *  (collapsed + expanded), chats (pinned at the top, as on the desktop) and
 *  archived. */
type ChatListSection = SectionListData<ChatListItem> & {
  kind:
    | 'folders-group'
    | 'folders'
    | 'folders-empty'
    | 'folder'
    | 'chats-group'
    | 'chats'
    | 'chats-empty'
    | 'routines-group'
    | 'routines'
    | 'archived-group'
    | 'archived'
    /** ACTIVE folder that holds archived chats — read-only grouping. */
    | 'archived-folder'
  folder?: FolderInfo
}

type NavItem = {
  label: string
  icon: typeof MessageSquare
  view?: string
  codeOnly?: boolean
  action?: () => void
}

export function Sidebar() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const router = useRouter()
  const sidebarOpen = useWorkspaceStore((s) => s.sidebarOpen)
  const mode = useWorkspaceStore((s) => s.mode)
  const closeSidebar = useWorkspaceStore((s) => s.closeSidebar)
  const setMode = useWorkspaceStore((s) => s.setMode)
  const disconnect = useConnectionStore((s) => s.disconnect)
  const clearSavedConfig = useConnectionStore((s) => s.clearSavedConfig)
  const insets = useSafeAreaInsets()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const sessions = useSessionStore((s) => s.sessions)
  const folders = useSessionStore((s) => s.folders)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const status = useSessionStore((s) => s.status)
  const unreadCounts = useSessionStore((s) => s.unreadCounts)
  const renameSession = useSessionStore((s) => s.renameSession)
  const setPinned = useSessionStore((s) => s.setPinned)
  const setArchived = useSessionStore((s) => s.setArchived)
  const deleteSession = useSessionStore((s) => s.deleteSession)
  const renameFolder = useSessionStore((s) => s.renameFolder)
  const setFolderPinned = useSessionStore((s) => s.setFolderPinned)
  const setFolderArchived = useSessionStore((s) => s.setFolderArchived)
  const deleteFolder = useSessionStore((s) => s.deleteFolder)
  const organizeSidebar = useSessionStore((s) => s.organizeSidebar)

  // Drawer position lives in the animation module — the swipe gesture
  // (useSidebarSwipe) drags the same values during the touch.
  // Whether the drawer is actually on screen — the backdrop only takes touches
  // while it is. Tied to the ANIMATION, not to the store: if the two ever
  // disagree, an invisible backdrop over the content would eat every tap and
  // every scroll of the chat.
  const [drawerVisible, setDrawerVisible] = useState(false)
  useAnimatedReaction(
    () => {
      'worklet'
      return drawerTranslateX.value > -DRAWER_WIDTH + 0.5
    },
    (visible, previous) => {
      'worklet'
      if (visible !== previous) runOnJS(setDrawerVisible)(visible)
    }
  )

  useEffect(() => {
    // On the UI runtime, the same place the gesture creates the animation: the
    // hamburger and the swipe can never end up on different paths.
    runOnUI(animateDrawer)(sidebarOpen)
  }, [sidebarOpen])

  // Both read the shared values on the UI thread: the drawer follows the finger
  // and settles without waiting for a render.
  const backdropStyle = useAnimatedStyle(() => ({ opacity: backdropOpacity.value }))
  const drawerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: drawerTranslateX.value }],
  }))

  // ─── Selection mode (chats and folders) ──────────────────────────────────
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(new Set())

  const enterSelectionMode = (id?: string, folderId?: string) => {
    setSelectionMode(true)
    if (id) setSelectedIds(new Set([id]))
    if (folderId) setSelectedFolderIds(new Set([folderId]))
  }

  const exitSelectionMode = () => {
    setSelectionMode(false)
    setSelectedIds(new Set())
    setSelectedFolderIds(new Set())
  }

  // Stable: a useCallback further down depends on it and was recreated on every
  // render because of this. It only uses the useState setter, which is already stable.
  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleSelectedFolder = (id: string) => {
    setSelectedFolderIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  useEffect(() => {
    if (selectionMode && selectedIds.size === 0 && selectedFolderIds.size === 0) {
      const timer = setTimeout(() => setSelectionMode(false), 0)
      return () => clearTimeout(timer)
    }
  }, [selectedIds.size, selectedFolderIds.size, selectionMode])

  // ─── Folders in accordion (same logic as the desktop: closed by default, state persisted) ──
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({})
  const expandedLoadedRef = useRef(false)

  useEffect(() => {
    let mounted = true
    void Storage.getItem(FOLDER_EXPANDED_KEY).then((raw) => {
      if (!mounted || expandedLoadedRef.current) return
      expandedLoadedRef.current = true
      try {
        setExpandedFolders(raw ? (JSON.parse(raw) as Record<string, boolean>) : {})
      } catch {
        setExpandedFolders({})
      }
    })
    return () => {
      mounted = false
    }
  }, [])

  const toggleFolderExpanded = useCallback((id: string) => {
    expandedLoadedRef.current = true
    setExpandedFolders((prev) => {
      const next = { ...prev, [id]: !prev[id] }
      void Storage.setItem(FOLDER_EXPANDED_KEY, JSON.stringify(next))
      return next
    })
  }, [])

  // ─── Accordion groupers (same logic as the desktop: Folders and Chats open
  // by default, Archived collapsed; state in memory only) ────────────────────
  const [groupsExpanded, setGroupsExpanded] = useState({ folders: true, chats: true, routines: true, archived: false })

  const toggleGroup = useCallback((key: 'folders' | 'chats' | 'routines' | 'archived') => {
    setGroupsExpanded((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  const totalSelected = selectedIds.size + selectedFolderIds.size

  const handleBulkDelete = async () => {
    const count = totalSelected
    const ok = await confirm({
      title: count > 1 ? t('sidebar.bulkDeleteTitle_other', { count }) : t('sidebar.bulkDeleteTitle_one', { count }),
      description: t('sidebar.bulkDeleteBody'),
      confirmLabel: t('sidebar.delete'),
      cancelLabel: t('sidebar.cancel'),
      destructive: true,
    })
    if (!ok) return
    await Promise.all([
      ...[...selectedIds].map((id) => deleteSession(id)),
      ...[...selectedFolderIds].map((id) => deleteFolder(id)),
    ])
    exitSelectionMode()
  }

  // ─── Action menu (long-press) ────────────────────────────────────────────
  const [sessionMenu, setSessionMenu] = useState<string | null>(null)
  const [folderMenu, setFolderMenu] = useState<string | null>(null)
  const [renamingSession, setRenamingSession] = useState<string | null>(null)
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null)
  const [menuY, setMenuY] = useState(0)
  const windowHeight = Dimensions.get('window').height
  const menuTop = Math.min(menuY + 8, windowHeight - 320)

  const openSessionMenu = useCallback((id: string, pageY: number) => {
    setMenuY(pageY)
    setSessionMenu(id)
  }, [])

  const openFolderMenu = useCallback((id: string, pageY: number) => {
    setMenuY(pageY)
    setFolderMenu(id)
  }, [])

  const sessionMenuTarget = sessions.find((s) => s.id === sessionMenu)
  const folderMenuTarget = folders.find((f) => f.id === folderMenu)
  const renamingSessionTarget = sessions.find((s) => s.id === renamingSession)
  const renamingFolderTarget = folders.find((f) => f.id === renamingFolder)

  const sessionMenuItems: ActionMenuItem[] = sessionMenuTarget
    ? [
        { icon: Pencil, label: t('sidebar.rename'), onPress: () => setRenamingSession(sessionMenuTarget.id) },
        {
          icon: sessionMenuTarget.pinned ? PinOff : Pin,
          label: sessionMenuTarget.pinned ? t('sidebar.unpin') : t('sidebar.pin'),
          onPress: () => void setPinned(sessionMenuTarget.id, !sessionMenuTarget.pinned),
        },
        {
          icon: sessionMenuTarget.archived ? ArchiveRestore : Archive,
          label: sessionMenuTarget.archived ? t('sidebar.unarchive') : t('sidebar.archive'),
          onPress: () => void setArchived(sessionMenuTarget.id, !sessionMenuTarget.archived),
        },
        {
          icon: CheckSquare,
          label: t('sidebar.select'),
          onPress: () => enterSelectionMode(sessionMenuTarget.id),
        },
        {
          icon: Trash2,
          label: t('sidebar.delete'),
          destructive: true,
          onPress: async () => {
            const ok = await confirm({
              title: t('sidebar.deleteConversationTitle'),
              description: t('sidebar.deleteConversationBody', { title: sessionMenuTarget.title }),
              confirmLabel: t('sidebar.delete'),
              cancelLabel: t('sidebar.cancel'),
              destructive: true,
            })
            if (ok) void deleteSession(sessionMenuTarget.id)
          },
        },
      ]
    : []

  const folderMenuItems: ActionMenuItem[] = folderMenuTarget
    ? [
        { icon: Pencil, label: t('sidebar.rename'), onPress: () => setRenamingFolder(folderMenuTarget.id) },
        {
          icon: folderMenuTarget.pinned ? PinOff : Pin,
          label: folderMenuTarget.pinned ? t('sidebar.unpin') : t('sidebar.pin'),
          onPress: () => void setFolderPinned(folderMenuTarget.id, !folderMenuTarget.pinned),
        },
        {
          icon: folderMenuTarget.archived ? ArchiveRestore : Archive,
          label: folderMenuTarget.archived ? t('sidebar.unarchiveFolder') : t('sidebar.archiveFolder'),
          onPress: () => void setFolderArchived(folderMenuTarget.id, !folderMenuTarget.archived),
        },
        {
          icon: CheckSquare,
          label: t('sidebar.select'),
          onPress: () => enterSelectionMode(undefined, folderMenuTarget.id),
        },
        {
          icon: Trash2,
          label: t('sidebar.removeFolder'),
          destructive: true,
          onPress: async () => {
            const ok = await confirm({
              title: t('sidebar.removeFolderTitle'),
              description: t('sidebar.removeFolderBody', { name: folderMenuTarget.name }),
              confirmLabel: t('sidebar.removeFolder'),
              cancelLabel: t('sidebar.cancel'),
              destructive: true,
            })
            if (ok) void deleteFolder(folderMenuTarget.id)
          },
        },
      ]
    : []

  const navigate = useCallback((path: string) => {
    closeSidebar()
    router.push(path as any)
  }, [closeSidebar, router])

  const handleDisconnect = useCallback(async () => {
    const ok = await confirm({
      title: t('sidebar.disconnectTitle'),
      description: t('sidebar.disconnectBody'),
      confirmLabel: t('sidebar.disconnect'),
      cancelLabel: t('sidebar.cancel'),
      destructive: true,
    })
    if (!ok) return
    disconnect()
    await clearSavedConfig()
    closeSidebar()
    router.replace('/connect')
  }, [confirm, t, disconnect, clearSavedConfig, closeSidebar, router])

  const handleNewChat = useCallback(() => {
    closeSidebar()
    router.push('/(main)')
  }, [closeSidebar, router])

  /** "+" of the folder: a new chat already pointing at the folder and at the workspace of
   *  its most recent chat — or, with the folder EMPTY, at the memory of the folder
   *  (`folder.workspace`, written by the first chat that entered it), as on the
   *  desktop. The session is only born on the 1st send — pendingFolder holds the
   *  destination until then. */
  const handleNewChatInFolder = useCallback((folder: FolderInfo) => {
    const mostRecent = sessions
      .filter((s) => s.folderId === folder.id)
      .reduce<SessionInfo | undefined>(
        (best, s) => (best && s.updatedAt <= best.updatedAt ? best : s),
        undefined,
      )
    const folders = mostRecent?.directory
      ? [mostRecent.directory, ...(mostRecent.extraDirectories ?? [])]
      : folder.workspace
    if (folders?.length) useDraftFolders.getState().setFolders(folders)
    useDraftFolders.getState().setPendingFolder(folder.id)
    if (folder.mode !== mode) setMode(folder.mode)
    closeSidebar()
    router.push('/(main)')
  }, [sessions, mode, setMode, closeSidebar, router])

  const handleOpenSession = useCallback((id: string) => {
    if (selectionMode) {
      toggleSelected(id)
      return
    }
    closeSidebar()
    router.push({ pathname: '/(main)/chat/[id]', params: { id } })
  }, [selectionMode, toggleSelected, closeSidebar, router])

  const topItems: NavItem[] = [
    // The pipeline only exists in code mode (tasks run phase by phase, no chat).
    { label: t('sidebar.pipeline'), icon: Layers, view: 'pipeline', codeOnly: true },
    // Routines exist in both modes — the screen lists/creates only the ones of
    // the active mode (same logic as the desktop pipeline/routines).
    { label: t('sidebar.routines'), icon: CalendarClock, view: 'routines' },
    { label: t('sidebar.memories'), icon: BrainCircuit, view: 'memories' },
    { label: t('sidebar.usage'), icon: BarChart3, view: 'usage' },
    { label: t('sidebar.media'), icon: Images, view: 'media' },
    { label: t('sidebar.tools'), icon: Puzzle, view: 'tools', codeOnly: true },
  ]

  const footerItems: NavItem[] = [
    { label: t('sidebar.settings'), icon: Settings, view: 'settings' },
    { label: t('sidebar.disconnect'), icon: LogOut, action: handleDisconnect },
  ]

  const filteredTopItems = topItems.filter((item) => !item.codeOnly || mode === 'code')

  // ─── Grouped chat list: pinned / folders / chats / routines / archived ─────
  const {
    pinned,
    folderGroups,
    recent,
    archivedFolderGroups,
    archivedMirrorGroups,
    archivedLoose,
    routineSessions,
  } = useMemo(() => {
    // Position of a chat = activity of its block (itself OR the most recent
    // nested sub-chat/worker) — same rule as the desktop's app-sidebar: moving
    // a side conversation brings the parent up with it, without depending only
    // on the main chat.
    const activity = sessionActivityMap(sessions)
    const activityOf = (s: SessionInfo) => activity.get(s.id) ?? s.updatedAt
    // Routine chats leave the normal listing: they live in the "Routines" group
    // right below, and would show up duplicated (and drown the recents) if they
    // also went into "Chats" or into the folders — same criterion as the
    // desktop's app-sidebar.
    const modeSessions = sessions.filter((s) => s.mode === mode && !s.parentId)
    // "Routines" group of the active mode: the session of each execution
    // inherits the routine's mode (scheduler.ts), so the chat sidebar lists only
    // the chat routines and the code one only the code ones. No archived filter:
    // routine chats do not go into the "Archived" group, so archiving one would
    // make it vanish from the whole sidebar.
    const routineSessions = modeSessions
      .filter((s) => !!s.routineId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
    const activeSessions = modeSessions.filter((s) => !s.archived && !s.routineId)
    const archivedSessions = modeSessions
      .filter((s) => s.archived && !s.routineId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
    const modeFolders = folders.filter((f) => f.mode === mode)
    // An archived folder leaves the "Folders" group and goes to "Archived" with
    // its chats — same split as the desktop's app-sidebar.
    const activeFolders = modeFolders.filter((f) => !f.archived)
    const archivedFolders = modeFolders.filter((f) => f.archived)
    const archivedFolderIds = new Set(archivedFolders.map((f) => f.id))
    // Only ACTIVE folders hold chats out of the root: an unarchived chat inside
    // an archived folder falls into the recents (the folder stays archived).
    const rootSessions = activeSessions.filter(
      (s) => !s.folderId || !activeFolders.some((f) => f.id === s.folderId),
    )
    const pinned = rootSessions.filter((s) => s.pinned).sort((a, b) => activityOf(b) - activityOf(a))
    const recent = rootSessions.filter((s) => !s.pinned).sort((a, b) => activityOf(b) - activityOf(a))
    // Folder order follows the desktop: pinned first, then by activity
    // (most recent session inside the folder) — among the pinned ones, the most recent
    // first.
    const folderActivity = (folderId: string) =>
      activeSessions
        .filter((s) => s.folderId === folderId)
        .reduce((latest, s) => Math.max(latest, activityOf(s)), 0)
    const sortedFolders = [...activeFolders].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return folderActivity(b.id) - folderActivity(a.id)
    })
    const folderGroups = sortedFolders.map((folder) => ({
      folder,
      sessions: activeSessions
        .filter((s) => s.folderId === folder.id)
        .sort((a, b) => activityOf(b) - activityOf(a)),
    }))

    // ── Archived ────
    // Archived folders bring their own chats; archived chats that still
    // belong to an ACTIVE folder get a mirror grouping (read-only)
    // right below — without it they would lose the reference to the source folder; the rest
    // stays loose.
    const archivedFolderGroups = [...archivedFolders]
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return b.createdAt - a.createdAt
      })
      .map((folder) => ({
        folder,
        sessions: archivedSessions.filter((s) => s.folderId === folder.id),
      }))
    const archivedInActiveFolders = archivedSessions.filter(
      (s) => s.folderId != null && !archivedFolderIds.has(s.folderId),
    )
    const archivedMirrorGroups = activeFolders
      .filter((f) => archivedInActiveFolders.some((s) => s.folderId === f.id))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((folder) => ({
        folder,
        sessions: archivedInActiveFolders.filter((s) => s.folderId === folder.id),
      }))
    // Loose = what did not fit into any grouping above (includes the rare case
    // of a folderId pointing to a folder that no longer exists).
    const grouped = new Set(
      [...archivedFolderGroups, ...archivedMirrorGroups].flatMap((g) => g.sessions.map((s) => s.id)),
    )
    const archivedLoose = archivedSessions.filter((s) => !grouped.has(s.id))

    return {
      pinned,
      folderGroups,
      recent,
      archivedFolderGroups,
      archivedMirrorGroups,
      archivedLoose,
      routineSessions,
    }
  }, [sessions, folders, mode])

  // ─── Subchats (workers/forks) — grouped under the parent chat, like the desktop
  // (childrenByParent in app-sidebar): the parent gets a chevron glued to the title
  // and the subchats stay indented with a vertical line. ────────────────────────────────────────────────
  const childrenByParent = useMemo(() => {
    const map: Record<string, SessionInfo[]> = {}
    for (const s of sessions) {
      if (s.parentId && !s.archived) (map[s.parentId] ??= []).push(s)
    }
    for (const children of Object.values(map)) children.sort((a, b) => b.updatedAt - a.updatedAt)
    return map
  }, [sessions])

  // Expansion of the folder mirrors in "Archived" — own state and in
  // memory only, like the useState(false) of ArchivedFolderGroup on the desktop.
  const [expandedMirrors, setExpandedMirrors] = useState<Record<string, boolean>>({})
  const toggleMirror = useCallback((id: string) => {
    setExpandedMirrors((prev) => ({ ...prev, [id]: !prev[id] }))
  }, [])

  // Subchats open by default (same as the desktop's useState(true)); state
  // in memory only.
  const [childrenExpanded, setChildrenExpanded] = useState<Record<string, boolean>>({})
  const toggleChildren = useCallback((id: string) => {
    setChildrenExpanded((prev) => ({ ...prev, [id]: !(prev[id] ?? true) }))
  }, [])

  // Sections of the SectionList. Each grouper (Folders/Chats/Archived) opens with
  // a header-only section (the accordion); the content of each group only enters the
  // list when the group is open. Inside "Folders" the order of
  // `folderGroups` is preserved: collapsed folders become items of a "Folders"
  // section and open folders become sections of their own (header = folder row,
  // data = its sessions) inserted AT THE POSITION of the folder — so expanding/
  // collapsing does not move the folder around. Each row of the list is virtualized,
  // so switching mode mounts only ~12 cells at once.
  const sections = useMemo<ChatListSection[]>(() => {
    const out: ChatListSection[] = []

    // ── "Folders" (accordion) ──────
    out.push({ kind: 'folders-group', data: [] })
    if (groupsExpanded.folders) {
      if (folderGroups.length > 0) {
        // Runs at a time: contiguous blocks of collapsed folders form one
        // section; each open folder becomes a section of its own along the way.
        let collapsedRun: FolderInfo[] = []
        for (const g of folderGroups) {
          if (expandedFolders[g.folder.id]) {
            if (collapsedRun.length > 0) {
              out.push({ kind: 'folders', data: collapsedRun })
              collapsedRun = []
            }
            out.push({ kind: 'folder', folder: g.folder, data: g.sessions })
          } else {
            collapsedRun.push(g.folder)
          }
        }
        if (collapsedRun.length > 0) out.push({ kind: 'folders', data: collapsedRun })
      } else {
        out.push({ kind: 'folders-empty', data: [EMPTY_FOLDERS_ITEM] })
      }
    }

    // ── "Chats" group (accordion) — pinned at the top of its own section, as on the
    // desktop (no "Pinned" sub-section; each pinned one shows the pin icon) ──
    out.push({ kind: 'chats-group', data: [] })
    if (groupsExpanded.chats) {
      if (pinned.length > 0 || recent.length > 0) {
        out.push({ kind: 'chats', data: [...pinned, ...recent] })
      } else {
        out.push({ kind: 'chats-empty', data: [EMPTY_CHATS_ITEM] })
      }
    }

    // ── "Routines" group of the active mode (accordion, only when it has content) ──
    if (routineSessions.length > 0) {
      out.push({ kind: 'routines-group', data: [] })
      if (groupsExpanded.routines) {
        out.push({ kind: 'routines', data: routineSessions })
      }
    }

    // ── "Archived" group (accordion, only when there is content) ──
    if (
      archivedFolderGroups.length > 0 ||
      archivedMirrorGroups.length > 0 ||
      archivedLoose.length > 0
    ) {
      out.push({ kind: 'archived-group', data: [] })
      if (groupsExpanded.archived) {
        // Archived folders first — real folder rows (with an unarchive menu),
        // in the same runs used in the "Folders" group.
        let collapsedRun: FolderInfo[] = []
        for (const g of archivedFolderGroups) {
          if (expandedFolders[g.folder.id]) {
            if (collapsedRun.length > 0) {
              out.push({ kind: 'folders', data: collapsedRun })
              collapsedRun = []
            }
            out.push({ kind: 'folder', folder: g.folder, data: g.sessions })
          } else {
            collapsedRun.push(g.folder)
          }
        }
        if (collapsedRun.length > 0) out.push({ kind: 'folders', data: collapsedRun })

        // Then the mirrors of the active folders. The expansion has its own state:
        // sharing the one of the "Folders" group would open both at once.
        for (const g of archivedMirrorGroups) {
          out.push({
            kind: 'archived-folder',
            folder: g.folder,
            data: expandedMirrors[g.folder.id] ? g.sessions : [],
          })
        }

        if (archivedLoose.length > 0) out.push({ kind: 'archived', data: archivedLoose })
      }
    }

    return out
  }, [
    pinned,
    folderGroups,
    recent,
    archivedFolderGroups,
    archivedMirrorGroups,
    archivedLoose,
    routineSessions,
    expandedFolders,
    expandedMirrors,
    groupsExpanded,
  ])

  // Child row of the chat — worker keeps the Bot (it is an agent), subchat
  // uses MessagesSquare (the two nested bubbles say "conversation open from here"),
  // same as the desktop.
  const renderChildRow = useCallback(
    (child: SessionInfo) => (
      <SessionRow
        key={child.id}
        title={child.title}
        active={child.id === activeSessionId}
        streaming={status[child.id] === 'streaming' || status[child.id] === 'submitted'}
        error={status[child.id] === 'error'}
        unread={unreadCounts[child.id] > 0}
        pinned={child.pinned}
        icon={child.orchestration?.role === 'worker' ? Bot : MessagesSquare}
        selectionMode={selectionMode}
        selected={selectedIds.has(child.id)}
        onPress={() => handleOpenSession(child.id)}
        onLongPress={(e) => openSessionMenu(child.id, e.nativeEvent.pageY)}
        tokens={tokens}
      />
    ),
    [activeSessionId, status, unreadCounts, selectionMode, selectedIds, handleOpenSession, openSessionMenu, tokens],
  )

  const keyExtractor = (item: ChatListItem) => {
    if ('__empty' in item) return item.__empty
    if ('title' in item) return `session:${item.id}`
    return `folder:${item.id}`
  }

  const renderFolderRow = (folder: FolderInfo, expanded: boolean) => (
    <FolderRow
      folder={folder}
      expanded={expanded}
      selectionMode={selectionMode}
      selected={selectedFolderIds.has(folder.id)}
      onToggle={() => {
        if (selectionMode) toggleSelectedFolder(folder.id)
        else toggleFolderExpanded(folder.id)
      }}
      onLongPress={(e) => openFolderMenu(folder.id, e.nativeEvent.pageY)}
      onNewChat={() => handleNewChatInFolder(folder)}
      newChatLabel={t('sidebar.newChatInFolder')}
      tokens={tokens}
    />
  )

  const renderItem = ({ item, section }: SectionListRenderItemInfo<ChatListItem>) => {
    const listSection = section as ChatListSection
    if (listSection.kind === 'chats-empty') {
      return (
        <Text className="px-4 py-2 text-sm" style={{ color: tokens.mutedForeground }}>
          {t('sidebar.noRecentChats')}
        </Text>
      )
    }
    if (listSection.kind === 'folders-empty') {
      return (
        <Text className="px-4 py-2 text-sm" style={{ color: tokens.mutedForeground }}>
          {t('sidebar.noFolders')}
        </Text>
      )
    }
    if (listSection.kind === 'folders') {
      return renderFolderRow(item as FolderInfo, false)
    }
    const session = item as SessionInfo
    // Subchats appear nested under the parent — except in Archived, which follows the
    // desktop (archived renders SessionItem without childSessions).
    const children =
      listSection.kind === 'archived' || listSection.kind === 'archived-folder'
        ? EMPTY_CHILDREN
        : (childrenByParent[session.id] ?? EMPTY_CHILDREN)
    return (
      <SessionRow
        title={session.title}
        active={session.id === activeSessionId}
        streaming={status[session.id] === 'streaming' || status[session.id] === 'submitted'}
        error={status[session.id] === 'error'}
        unread={unreadCounts[session.id] > 0}
        indented={listSection.kind === 'folder' || listSection.kind === 'archived-folder'}
        pinned={session.pinned}
        selectionMode={selectionMode}
        selected={selectedIds.has(session.id)}
        childSessions={children}
        childrenExpanded={childrenExpanded[session.id] ?? true}
        childrenParentId={session.id}
        onToggleChildren={toggleChildren}
        renderChild={children.length > 0 ? renderChildRow : undefined}
        onPress={() => handleOpenSession(session.id)}
        onLongPress={(e) => openSessionMenu(session.id, e.nativeEvent.pageY)}
        tokens={tokens}
      />
    )
  }

  const renderSectionHeader = ({ section }: { section: SectionListData<ChatListItem> }) => {
    const listSection = section as ChatListSection
    if (listSection.kind === 'folders-group') {
      return (
        <AccordionHeader
          label={t('sidebar.folders')}
          expanded={groupsExpanded.folders}
          onToggle={() => toggleGroup('folders')}
          tokens={tokens}
          actions={[
            // Same button as the desktop: merges duplicate folders of the project and
            // pulls the loose code chats into their folder.
            {
              icon: Wand2,
              label: t('sidebar.organize'),
              onPress: () => {
                void organizeSidebar().then((ok) => {
                  if (!ok) Alert.alert(t('sidebar.organize'), t('sidebar.organizeUnavailable'))
                })
              },
            },
            {
              icon: Search,
              label: t('sidebar.searchChats'),
              onPress: () => {
                closeSidebar()
                router.push('/(main)/search')
              },
            },
          ]}
        />
      )
    }
    if (listSection.kind === 'chats-group') {
      return (
        <AccordionHeader
          label={t('sidebar.chats')}
          expanded={groupsExpanded.chats}
          onToggle={() => toggleGroup('chats')}
          tokens={tokens}
        />
      )
    }
    if (listSection.kind === 'routines-group') {
      return (
        <AccordionHeader
          label={t('sidebar.routines')}
          expanded={groupsExpanded.routines}
          onToggle={() => toggleGroup('routines')}
          tokens={tokens}
        />
      )
    }
    if (listSection.kind === 'archived-group') {
      return (
        <AccordionHeader
          label={t('sidebar.archived')}
          expanded={groupsExpanded.archived}
          onToggle={() => toggleGroup('archived')}
          tokens={tokens}
        />
      )
    }
    if (listSection.kind === 'folder' && listSection.folder) {
      return renderFolderRow(listSection.folder, true)
    }
    if (listSection.kind === 'archived-folder' && listSection.folder) {
      const folder = listSection.folder
      return (
        <ArchivedFolderRow
          folder={folder}
          count={archivedMirrorGroups.find((g) => g.folder.id === folder.id)?.sessions.length ?? 0}
          expanded={!!expandedMirrors[folder.id]}
          onToggle={() => toggleMirror(folder.id)}
          tokens={tokens}
        />
      )
    }
    return null
  }

  return (
    <>
      {/* Backdrop */}
      <Animated.View
        pointerEvents={drawerVisible ? 'auto' : 'none'}
        style={[
          {
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.4)',
            zIndex: 50,
          },
          backdropStyle,
        ]}
      >
        <Pressable style={{ flex: 1 }} onPress={closeSidebar} />
      </Animated.View>

      {/* Drawer */}
      <Animated.View
        style={[
          {
            position: 'absolute',
            top: 0,
            left: 0,
            bottom: 0,
            width: DRAWER_WIDTH,
            backgroundColor: tokens.background,
            borderRightWidth: 1,
            borderRightColor: tokens.border,
            zIndex: 51,
            elevation: 10,
          },
          drawerStyle,
        ]}
      >
        <View style={{ flex: 1, paddingTop: insets.top, paddingBottom: insets.bottom }}>
          {/* Mode Tabs */}
          <View className="px-3 pt-3 pb-2">
            <View className="flex-row rounded-xl p-1" style={{ backgroundColor: tokens.muted }}>
              <ModeTab
                icon={MessageSquare}
                label={t('sidebar.modeChat')}
                active={mode === 'chat'}
                onPress={() => setMode('chat')}
                tokens={tokens}
              />
              <ModeTab
                icon={Terminal}
                label={t('sidebar.modeCode')}
                active={mode === 'code'}
                onPress={() => setMode('code')}
                tokens={tokens}
              />
            </View>
          </View>

          {/* Selection bar */}
          {selectionMode && (
            <View className="flex-row items-center justify-between px-4 py-2" style={{ borderBottomWidth: 1, borderBottomColor: tokens.border }}>
              <View className="flex-row items-center gap-2">
                <Pressable onPress={exitSelectionMode} className="p-1">
                  <X size={16} color={tokens.mutedForeground} />
                </Pressable>
                <Text className="text-sm font-medium" style={{ color: tokens.foreground }}>
                  {t('sidebar.selected', { count: totalSelected })}
                </Text>
              </View>
              <Pressable onPress={() => void handleBulkDelete()} className="p-1.5" disabled={totalSelected === 0}>
                <Trash2 size={18} color={tokens.destructive} />
              </Pressable>
            </View>
          )}

          {/* Chat list — virtualized SectionList: switching mode mounts
              only the visible cells (~12 per batch), like the model picker */}
          <SectionList
            className="flex-1"
            sections={sections}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            renderSectionHeader={renderSectionHeader}
            stickySectionHeadersEnabled={false}
            initialNumToRender={12}
            maxToRenderPerBatch={12}
            windowSize={7}
            updateCellsBatchingPeriod={40}
            contentContainerStyle={{ paddingBottom: 8 }}
            ListHeaderComponent={
              <View>
                {/* New chat */}
                <View className="px-3 pt-2 pb-1">
                  <Pressable
                    onPress={handleNewChat}
                    className="flex-row items-center justify-center gap-2 rounded-xl py-3"
                    style={{ borderWidth: 1, borderColor: tokens.border }}
                  >
                    <Plus size={18} color={tokens.foreground} />
                    <Text className="text-sm font-medium" style={{ color: tokens.foreground }}>
                      {mode === 'chat' ? t('sidebar.newChat') : t('sidebar.newSession')}
                    </Text>
                  </Pressable>
                </View>

                {/* Fixed actions */}
                <View className="pt-1">
                  {filteredTopItems.map((item) => (
                    <SidebarItem
                      key={item.label}
                      icon={item.icon}
                      label={item.label}
                      onPress={() => {
                        if (item.action) {
                          item.action()
                        } else if (item.view) {
                          navigate(`/(main)/${item.view}`)
                        }
                      }}
                      tokens={tokens}
                    />
                  ))}
                </View>

                {/* Divider between the fixed actions and the chat list */}
                <View className="mt-2 pt-2" style={{ borderTopWidth: 1, borderTopColor: tokens.border }} />
              </View>
            }
            ListEmptyComponent={
              <Text className="px-4 py-2 text-sm" style={{ color: tokens.mutedForeground }}>
                {t('sidebar.noConversations')}
              </Text>
            }
          />

          {/* Footer */}
          <View className="pt-2 pb-2" style={{ borderTopWidth: 1, borderTopColor: tokens.border }}>
            {footerItems.map((item) => (
              <SidebarItem
                key={item.label}
                icon={item.icon}
                label={item.label}
                onPress={() => {
                  if (item.action) {
                    item.action()
                  } else if (item.view) {
                    navigate(`/(main)/${item.view}`)
                  }
                }}
                destructive={item.action === handleDisconnect}
                tokens={tokens}
              />
            ))}
          </View>
        </View>
      </Animated.View>

      <ActionMenu
        visible={sessionMenu !== null}
        onClose={() => setSessionMenu(null)}
        items={sessionMenuItems}
        anchor={{ top: menuTop, left: 24 }}
      />
      <ActionMenu
        visible={folderMenu !== null}
        onClose={() => setFolderMenu(null)}
        items={folderMenuItems}
        anchor={{ top: menuTop, left: 24 }}
      />
      <RenamePrompt
        visible={renamingSession !== null}
        title={t('sidebar.renameConversation')}
        initialValue={renamingSessionTarget?.title ?? ''}
        onClose={() => setRenamingSession(null)}
        onSubmit={(title) => renamingSessionTarget && void renameSession(renamingSessionTarget.id, title)}
      />
      <RenamePrompt
        visible={renamingFolder !== null}
        title={t('sidebar.renameFolderTitle')}
        initialValue={renamingFolderTarget?.name ?? ''}
        onClose={() => setRenamingFolder(null)}
        onSubmit={(name) => renamingFolderTarget && void renameFolder(renamingFolderTarget.id, name)}
      />
    </>
  )
}

const ModeTab = memo(function ModeTab({
  icon: Icon,
  label,
  active,
  onPress,
  tokens,
}: {
  icon: typeof MessageSquare
  label: string
  active: boolean
  onPress: () => void
  tokens: ThemeTokens
}) {
  return (
    <Pressable
      onPress={onPress}
      className="flex-1 flex-row items-center justify-center gap-1.5 rounded-lg py-2.5"
      style={
        active
          ? { backgroundColor: tokens.background, borderWidth: 1, borderColor: tokens.border }
          : { borderWidth: 1, borderColor: 'transparent' }
      }
    >
      <Icon size={15} color={active ? tokens.primary : tokens.mutedForeground} />
      <Text
        className="text-sm font-medium"
        style={{ color: active ? tokens.foreground : tokens.mutedForeground }}
      >
        {label}
      </Text>
    </Pressable>
  )
})

const SidebarItem = memo(function SidebarItem({
  icon: Icon,
  label,
  onPress,
  destructive,
  tokens,
}: {
  icon: typeof MessageSquare
  label: string
  onPress: () => void
  destructive?: boolean
  tokens: ThemeTokens
}) {
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-4 px-4 py-3.5"
    >
      <Icon size={22} color={destructive ? tokens.destructive : tokens.mutedForeground} />
      <Text
        className="text-base"
        style={{ color: destructive ? tokens.destructive : tokens.foreground, fontWeight: destructive ? '600' : '400' }}
      >
        {label}
      </Text>
    </Pressable>
  )
})

/** Header of an accordion grouper (Folders/Chats/Archived) — replicates the
 *  AccordionGroup of the desktop: clickable label with chevron (right collapsed /
 *  down open). Layout same as the desktop: label with flex-1 and chevron at the
 *  right edge ("between"), with the action (e.g. search magnifier) between the
 *  label and the chevron. The action is a nested Pressable — the RN responder gives
 *  the touch to the child, so tapping the magnifier does not toggle the accordion (equivalent
 *  to the stopPropagation of the desktop). In RN the lucide rotate disappears in some
 *  versions, so we swap the icon instead of rotating it. */
const AccordionHeader = memo(function AccordionHeader({
  label,
  expanded,
  onToggle,
  actions,
  tokens,
}: {
  label: string
  expanded: boolean
  onToggle: () => void
  actions?: {
    icon: typeof Search
    label: string
    onPress: () => void
  }[]
  tokens: ThemeTokens
}) {
  return (
    <View className="flex-row items-center px-4 pb-2 pt-3">
      <Pressable
        onPress={onToggle}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded }}
        className="min-w-0 flex-1 flex-row items-center gap-1.5 py-0.5"
      >
        <Text
          className="flex-1 text-xs font-medium uppercase tracking-wide"
          numberOfLines={1}
          style={{ color: tokens.mutedForeground }}
        >
          {label}
        </Text>
        {actions?.map(({ icon: ActionIcon, label: actionLabel, onPress }) => (
          <Pressable
            key={actionLabel}
            onPress={onPress}
            hitSlop={10}
            accessibilityLabel={actionLabel}
            className="h-7 w-7 shrink-0 items-center justify-center rounded-md active:opacity-70"
          >
            <ActionIcon size={16} color={tokens.mutedForeground} />
          </Pressable>
        ))}
        {expanded ? (
          <ChevronDown size={14} color={tokens.mutedForeground} />
        ) : (
          <ChevronRight size={14} color={tokens.mutedForeground} />
        )}
      </Pressable>
    </View>
  )
})

const FolderRow = memo(function FolderRow({
  folder,
  expanded,
  selectionMode,
  selected,
  onToggle,
  onLongPress,
  onNewChat,
  newChatLabel,
  tokens,
}: {
  folder: FolderInfo
  expanded: boolean
  selectionMode?: boolean
  selected?: boolean
  onToggle: () => void
  onLongPress?: (e: GestureResponderEvent) => void
  onNewChat?: () => void
  newChatLabel?: string
  tokens: ThemeTokens
}) {
  return (
    <Pressable
      onLongPress={onLongPress}
      onPress={onToggle}
      className="mx-3 flex-row items-center gap-2 rounded-lg px-3 py-2"
      style={selected ? { backgroundColor: tokens.accent } : undefined}
    >
      {selectionMode && (
        <View className="mr-0.5">
          {selected ? (
            <Check size={14} color={tokens.primary} />
          ) : (
            <Square size={14} color={tokens.mutedForeground} />
          )}
        </View>
      )}
      <Folder size={14} color={tokens.mutedForeground} />
      {/* Desktop: chevron glued to the folder text (gap-1, no between); the pin
          stays outside the flex-1 container, at the right edge of the row. */}
      <View className="min-w-0 flex-1 flex-row items-center gap-1">
        <Text className="shrink text-sm font-medium" numberOfLines={1} style={{ color: tokens.foreground }}>
          {folder.name}
        </Text>
        {!selectionMode &&
          (expanded ? (
            <ChevronDown size={14} color={tokens.mutedForeground} style={{ flexShrink: 0 }} />
          ) : (
            <ChevronRight size={14} color={tokens.mutedForeground} style={{ flexShrink: 0 }} />
          ))}
      </View>
      {folder.pinned && <Pin size={14} color={tokens.mutedForeground} />}
      {/* New chat already inside the folder, like the "+" of the folder row on the desktop
          (there it shows on hover; here it is fixed, which is what can be tapped). */}
      {!selectionMode && onNewChat && (
        <Pressable
          onPress={(e) => {
            e.stopPropagation()
            onNewChat()
          }}
          hitSlop={8}
          accessibilityLabel={newChatLabel}
        >
          <Plus size={15} color={tokens.mutedForeground} />
        </Pressable>
      )}
    </Pressable>
  )
}, (prev, next) =>
  prev.folder === next.folder &&
  prev.expanded === next.expanded &&
  prev.selectionMode === next.selectionMode &&
  prev.selected === next.selected &&
  prev.tokens === next.tokens &&
  prev.onToggle === next.onToggle &&
  prev.onNewChat === next.onNewChat
)

/** ACTIVE folder that still holds archived chats, shown inside
 *  "Archived". Ports the ArchivedFolderGroup of the desktop: it is read-only on
 *  purpose — reusing the normal row would make the folder expand together with the one of
 *  the "Folders" group and would offer to rename/archive/delete the real folder
 *  from here. No mirror folder is created in storage: the chat
 *  keeps the folderId, so it goes back on its own to the place when unarchived. */
const ArchivedFolderRow = memo(function ArchivedFolderRow({
  folder,
  count,
  expanded,
  onToggle,
  tokens,
}: {
  folder: FolderInfo
  count: number
  expanded: boolean
  onToggle: () => void
  tokens: ThemeTokens
}) {
  return (
    <Pressable onPress={onToggle} className="mx-3 flex-row items-center gap-2 rounded-lg px-3 py-2">
      <Folder size={14} color={tokens.mutedForeground} />
      <View className="min-w-0 flex-1 flex-row items-center gap-1">
        <Text className="shrink text-sm" numberOfLines={1} style={{ color: tokens.mutedForeground }}>
          {folder.name}
        </Text>
        <Text className="text-[10px]" style={{ color: tokens.mutedForeground, opacity: 0.6 }}>
          {count}
        </Text>
        {expanded ? (
          <ChevronDown size={14} color={tokens.mutedForeground} style={{ flexShrink: 0 }} />
        ) : (
          <ChevronRight size={14} color={tokens.mutedForeground} style={{ flexShrink: 0 }} />
        )}
      </View>
    </Pressable>
  )
})

const SessionRow = memo(function SessionRow({
  title,
  active,
  streaming,
  error,
  unread,
  indented,
  pinned,
  selectionMode,
  selected,
  icon = MessageSquare,
  childSessions,
  childrenExpanded,
  childrenParentId,
  onToggleChildren,
  renderChild,
  onPress: _onPress,
  onLongPress: _onLongPress,
  tokens,
}: {
  title: string
  active: boolean
  streaming?: boolean
  error?: boolean
  unread?: boolean
  indented?: boolean
  pinned?: boolean
  selectionMode?: boolean
  selected?: boolean
  icon?: typeof MessageSquare
  /** Subchats (workers/forks) nested under the parent chat, as on the desktop
   *  (SessionItem / SessionRowWithChildren). */
  childSessions?: SessionInfo[]
  childrenExpanded?: boolean
  childrenParentId?: string
  onToggleChildren?: (id: string) => void
  renderChild?: (child: SessionInfo) => ReactElement
  onPress: () => void
  onLongPress?: (e: GestureResponderEvent) => void
  tokens: ThemeTokens
}) {
  const Icon = icon
  const childrenList = childSessions ?? EMPTY_CHILDREN
  const hasChildren = childrenList.length > 0
  const subExpanded = childrenExpanded ?? true

  const card = (
    <Pressable
      onPress={_onPress}
      onLongPress={_onLongPress}
      className={cn(
        'flex-row items-center gap-3 rounded-lg px-3 py-2.5',
        !indented && 'mx-3 mb-0.5',
      )}
      style={(active || selected) ? { backgroundColor: tokens.accent } : undefined}
    >
      {selectionMode ? (
        selected ? (
          <Check size={16} color={tokens.primary} />
        ) : (
          <Square size={16} color={tokens.mutedForeground} />
        )
      ) : (
        <Icon size={16} color={active ? tokens.foreground : tokens.mutedForeground} />
      )}
      {/* Desktop: title + indicators + subchat chevron in the trailing (glued to the
          text, inside the flex-1 container); pin outside, at the edge. */}
      <View className="min-w-0 flex-1 flex-row items-center gap-2">
        <Text
          className={cn('shrink text-sm', active && 'font-medium')}
          numberOfLines={1}
          style={{ color: tokens.foreground }}
        >
          {title}
        </Text>
        {streaming && (
          <Spin>
            <Loader2 size={14} color={tokens.primary} />
          </Spin>
        )}
        {error && (
          <View className="size-2 rounded-full" style={{ backgroundColor: tokens.destructive }} />
        )}
        {!streaming && !active && unread && (
          <View className="size-2.5 rounded-full" style={{ backgroundColor: tokens.primary }} />
        )}
        {hasChildren && (
          <Pressable
            hitSlop={8}
            accessibilityRole="button"
            onPress={() => onToggleChildren?.(childrenParentId ?? '')}
            className="shrink-0 p-0.5"
          >
            {subExpanded ? (
              <ChevronDown size={14} color={tokens.mutedForeground} />
            ) : (
              <ChevronRight size={14} color={tokens.mutedForeground} />
            )}
          </Pressable>
        )}
      </View>
      {pinned && <Pin size={14} color={tokens.mutedForeground} />}
    </Pressable>
  )

  // Subchats: row aligned with the icon of the parent chat (+8px of slack, same
  // pattern as the folder row). Loose chats start from the edge of the drawer
  // (ml-8 = 24 + 8); inside a folder the content already starts after the folder
  // row + pl-2.5, so ml-5 = parent icon + 8.
  const content = (
    <View>
      {card}
      {hasChildren && subExpanded && renderChild && (
        <View
          className={cn('border-l py-0.5 pl-2.5', indented ? 'ml-5' : 'ml-8')}
          style={{ borderColor: tokens.border }}
        >
          {childrenList.map((child) => renderChild(child))}
        </View>
      )}
    </View>
  )

  // Sessions inside a folder are indented with a vertical line on the left.
  // The line stays aligned with the folder icon in the parent card (mx-3 + px-3 = 24px)
  // with 8px of slack: ml-8 = 32px; in selection mode the checkbox adds 16px
  // (ml-12 = 48px). The border covers the whole vertical padding of the cell (including
  // the subchats), so the line keeps going without breaking between the cards.
  if (indented) {
    return (
      <View
        className={cn('border-l py-0.5 pl-2.5', selectionMode ? 'ml-12' : 'ml-8')}
        style={{ borderColor: tokens.border }}
      >
        {content}
      </View>
    )
  }
  return content
}, (prev, next) =>
  prev.title === next.title &&
  prev.active === next.active &&
  prev.streaming === next.streaming &&
  prev.error === next.error &&
  prev.unread === next.unread &&
  prev.indented === next.indented &&
  prev.pinned === next.pinned &&
  prev.selectionMode === next.selectionMode &&
  prev.selected === next.selected &&
  prev.icon === next.icon &&
  prev.childSessions === next.childSessions &&
  prev.childrenExpanded === next.childrenExpanded &&
  prev.childrenParentId === next.childrenParentId &&
  prev.onToggleChildren === next.onToggleChildren &&
  prev.renderChild === next.renderChild &&
  prev.tokens === next.tokens
)
