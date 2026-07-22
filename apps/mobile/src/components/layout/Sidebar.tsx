import { useEffect, useMemo, useState, useCallback, memo } from 'react'
import { View, Text, Pressable, Animated, ScrollView, Alert, Dimensions } from 'react-native'
import type { GestureResponderEvent } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import {
  MessageSquare,
  Terminal,
  BrainCircuit,
  BarChart3,
  Puzzle,
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
  Search,
} from 'lucide-react-native'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { useConnectionStore } from '~/stores/connection-store'
import { useSessionStore } from '~/stores/session-store'
import { Spin } from '~/components/ui/spin'
import { ActionMenu, type ActionMenuItem } from '~/components/ui/action-menu'
import { RenamePrompt } from '~/components/ui/rename-prompt'
import { cn } from '~/lib/utils'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import type { ThemeTokens } from '~/lib/theme-tokens'

const DRAWER_WIDTH = 308

type NavItem = {
  label: string
  icon: typeof MessageSquare
  view?: string
  codeOnly?: boolean
  action?: () => void
}

export function Sidebar() {
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
  const deleteFolder = useSessionStore((s) => s.deleteFolder)

  const [slideAnim] = useState(() => new Animated.Value(-DRAWER_WIDTH))
  const [backdropAnim] = useState(() => new Animated.Value(0))

  useEffect(() => {
    Animated.parallel([
      Animated.timing(slideAnim, {
        toValue: sidebarOpen ? 0 : -DRAWER_WIDTH,
        duration: 250,
        useNativeDriver: true,
      }),
      Animated.timing(backdropAnim, {
        toValue: sidebarOpen ? 1 : 0,
        duration: 250,
        useNativeDriver: true,
      }),
    ]).start()
  }, [sidebarOpen, slideAnim, backdropAnim])

  // ─── Modo de seleção (chats e pastas) ────────────────────────────────────
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

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

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
      setSelectionMode(false)
    }
  }, [selectedIds.size, selectedFolderIds.size, selectionMode])

  const totalSelected = selectedIds.size + selectedFolderIds.size

  const handleBulkDelete = () => {
    const count = totalSelected
    Alert.alert(
      count > 1 ? `Excluir ${count} itens?` : 'Excluir?',
      'Os chats selecionados serão excluídos permanentemente. Pastas removidas mantêm os chats (voltam pra raiz).',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Excluir',
          style: 'destructive',
          onPress: async () => {
            await Promise.all([
              ...[...selectedIds].map((id) => deleteSession(id)),
              ...[...selectedFolderIds].map((id) => deleteFolder(id)),
            ])
            exitSelectionMode()
          },
        },
      ],
    )
  }

  // ─── Menu de ações (long-press) ──────────────────────────────────────────
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
        { icon: Pencil, label: 'Renomear', onPress: () => setRenamingSession(sessionMenuTarget.id) },
        {
          icon: sessionMenuTarget.pinned ? PinOff : Pin,
          label: sessionMenuTarget.pinned ? 'Desafixar' : 'Fixar',
          onPress: () => void setPinned(sessionMenuTarget.id, !sessionMenuTarget.pinned),
        },
        {
          icon: sessionMenuTarget.archived ? ArchiveRestore : Archive,
          label: sessionMenuTarget.archived ? 'Desarquivar' : 'Arquivar',
          onPress: () => void setArchived(sessionMenuTarget.id, !sessionMenuTarget.archived),
        },
        {
          icon: CheckSquare,
          label: 'Selecionar',
          onPress: () => enterSelectionMode(sessionMenuTarget.id),
        },
        {
          icon: Trash2,
          label: 'Excluir',
          destructive: true,
          onPress: () =>
            Alert.alert('Excluir conversa?', `"${sessionMenuTarget.title}" será excluída permanentemente.`, [
              { text: 'Cancelar', style: 'cancel' },
              { text: 'Excluir', style: 'destructive', onPress: () => void deleteSession(sessionMenuTarget.id) },
            ]),
        },
      ]
    : []

  const folderMenuItems: ActionMenuItem[] = folderMenuTarget
    ? [
        { icon: Pencil, label: 'Renomear', onPress: () => setRenamingFolder(folderMenuTarget.id) },
        {
          icon: folderMenuTarget.pinned ? PinOff : Pin,
          label: folderMenuTarget.pinned ? 'Desafixar' : 'Fixar',
          onPress: () => void setFolderPinned(folderMenuTarget.id, !folderMenuTarget.pinned),
        },
        {
          icon: CheckSquare,
          label: 'Selecionar',
          onPress: () => enterSelectionMode(undefined, folderMenuTarget.id),
        },
        {
          icon: Trash2,
          label: 'Remover pasta',
          destructive: true,
          onPress: () =>
            Alert.alert('Remover pasta?', `Os chats de "${folderMenuTarget.name}" voltam pra raiz.`, [
              { text: 'Cancelar', style: 'cancel' },
              { text: 'Remover', style: 'destructive', onPress: () => void deleteFolder(folderMenuTarget.id) },
            ]),
        },
      ]
    : []

  const navigate = useCallback((path: string) => {
    closeSidebar()
    router.push(path as any)
  }, [closeSidebar, router])

  const handleDisconnect = useCallback(async () => {
    disconnect()
    await clearSavedConfig()
    closeSidebar()
    router.replace('/(connection)')
  }, [disconnect, clearSavedConfig, closeSidebar, router])

  const handleNewChat = useCallback(() => {
    closeSidebar()
    router.push('/(main)')
  }, [closeSidebar, router])

  const handleOpenSession = useCallback((id: string) => {
    if (selectionMode) {
      toggleSelected(id)
      return
    }
    closeSidebar()
    router.push({ pathname: '/(main)/chat/[id]', params: { id } })
  }, [selectionMode, toggleSelected, closeSidebar, router])

  const topItems: NavItem[] = [
    { label: 'Memórias', icon: BrainCircuit, view: 'memories' },
    { label: 'Uso e Limites', icon: BarChart3, view: 'usage' },
    { label: 'Ferramentas', icon: Puzzle, view: 'tools', codeOnly: true },
  ]

  const footerItems: NavItem[] = [
    { label: 'Configurações', icon: Settings, view: 'settings' },
    { label: 'Desconectar', icon: LogOut, action: handleDisconnect },
  ]

  const filteredTopItems = topItems.filter((item) => !item.codeOnly || mode === 'code')

  // ─── Lista de chats agrupada: fixados / pastas / chats ───────────────────
  const { pinned, folderGroups, recent } = useMemo(() => {
    const modeSessions = sessions.filter((s) => s.mode === mode && !s.parentId && !s.archived)
    const modeFolders = folders.filter((f) => f.mode === mode)
    const rootSessions = modeSessions.filter(
      (s) => !s.folderId || !modeFolders.some((f) => f.id === s.folderId),
    )
    const pinned = rootSessions.filter((s) => s.pinned).sort((a, b) => b.updatedAt - a.updatedAt)
    const recent = rootSessions.filter((s) => !s.pinned).sort((a, b) => b.updatedAt - a.updatedAt)
    const sortedFolders = [...modeFolders.filter((f) => f.pinned), ...modeFolders.filter((f) => !f.pinned)]
    const folderGroups = sortedFolders.map((folder) => ({
      folder,
      sessions: modeSessions
        .filter((s) => s.folderId === folder.id)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    }))
    return { pinned, folderGroups, recent }
  }, [sessions, folders, mode])

  return (
    <>
      {/* Backdrop */}
      <Animated.View
        pointerEvents={sidebarOpen ? 'auto' : 'none'}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.4)',
          opacity: backdropAnim,
          zIndex: 50,
        }}
      >
        <Pressable style={{ flex: 1 }} onPress={closeSidebar} />
      </Animated.View>

      {/* Drawer */}
      <Animated.View
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          bottom: 0,
          width: DRAWER_WIDTH,
          backgroundColor: tokens.background,
          borderRightWidth: 1,
          borderRightColor: tokens.border,
          transform: [{ translateX: slideAnim }],
          zIndex: 51,
          elevation: 10,
        }}
      >
        <View style={{ flex: 1, paddingTop: insets.top, paddingBottom: insets.bottom }}>
          {/* Mode Tabs */}
          <View className="px-3 pt-3 pb-2">
            <View className="flex-row rounded-xl p-1" style={{ backgroundColor: tokens.muted }}>
              <ModeTab
                icon={MessageSquare}
                label="Chat"
                active={mode === 'chat'}
                onPress={() => setMode('chat')}
                tokens={tokens}
              />
              <ModeTab
                icon={Terminal}
                label="Código"
                active={mode === 'code'}
                onPress={() => setMode('code')}
                tokens={tokens}
              />
            </View>
          </View>

          {/* Barra de seleção */}
          {selectionMode && (
            <View className="flex-row items-center justify-between px-4 py-2" style={{ borderBottomWidth: 1, borderBottomColor: tokens.border }}>
              <View className="flex-row items-center gap-2">
                <Pressable onPress={exitSelectionMode} className="p-1">
                  <X size={16} color={tokens.mutedForeground} />
                </Pressable>
                <Text className="text-sm font-medium" style={{ color: tokens.foreground }}>
                  {totalSelected} selecionado{totalSelected !== 1 ? 's' : ''}
                </Text>
              </View>
              <Pressable onPress={handleBulkDelete} className="p-1.5" disabled={totalSelected === 0}>
                <Trash2 size={18} color={tokens.destructive} />
              </Pressable>
            </View>
          )}

          <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 8 }}>
            {/* Novo chat */}
            <View className="px-3 pt-2 pb-1">
              <Pressable
                onPress={handleNewChat}
                className="flex-row items-center justify-center gap-2 rounded-xl py-3"
                style={{ borderWidth: 1, borderColor: tokens.border }}
              >
                <Plus size={18} color={tokens.foreground} />
                <Text className="text-sm font-medium" style={{ color: tokens.foreground }}>
                  {mode === 'chat' ? 'Novo Chat' : 'Nova Sessão'}
                </Text>
              </Pressable>
            </View>

            {/* Ações fixas */}
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

            {/* Lista de chats */}
            <View className="mt-2 pt-2" style={{ borderTopWidth: 1, borderTopColor: tokens.border }}>
              {pinned.length > 0 && (
                <SessionGroup label="Fixados" tokens={tokens}>
                  {pinned.map((s) => (
                    <SessionRow
                      key={s.id}
                      title={s.title}
                      active={s.id === activeSessionId}
                      streaming={status[s.id] === 'streaming' || status[s.id] === 'submitted'}
                      unread={unreadCounts[s.id] > 0}
                      selectionMode={selectionMode}
                      selected={selectedIds.has(s.id)}
                      onPress={() => handleOpenSession(s.id)}
                      onLongPress={(e) => openSessionMenu(s.id, e.nativeEvent.pageY)}
                      tokens={tokens}
                    />
                  ))}
                </SessionGroup>
              )}

              {folderGroups.length > 0 && (
                <SessionGroup label="Pastas" tokens={tokens}>
                  {folderGroups.map(({ folder, sessions: folderSessions }) => (
                    <View key={folder.id}>
                      <Pressable
                        onLongPress={(e) => openFolderMenu(folder.id, e.nativeEvent.pageY)}
                        onPress={() => selectionMode && toggleSelectedFolder(folder.id)}
                        className="mx-3 flex-row items-center gap-2 rounded-lg px-3 py-2"
                        style={selectedFolderIds.has(folder.id) ? { backgroundColor: tokens.accent } : undefined}
                      >
                        {selectionMode && (
                          <View className="mr-0.5">
                            {selectedFolderIds.has(folder.id) ? (
                              <Check size={14} color={tokens.primary} />
                            ) : (
                              <Square size={14} color={tokens.mutedForeground} />
                            )}
                          </View>
                        )}
                        <Folder size={14} color={tokens.mutedForeground} />
                        <Text className="text-sm font-medium" numberOfLines={1} style={{ color: tokens.foreground }}>
                          {folder.name}
                        </Text>
                      </Pressable>
                      {folderSessions.map((s) => (
                        <SessionRow
                          key={s.id}
                          title={s.title}
                          indented
                          active={s.id === activeSessionId}
                          streaming={status[s.id] === 'streaming' || status[s.id] === 'submitted'}
                          unread={unreadCounts[s.id] > 0}
                          selectionMode={selectionMode}
                          selected={selectedIds.has(s.id)}
                          onPress={() => handleOpenSession(s.id)}
                          onLongPress={(e) => openSessionMenu(s.id, e.nativeEvent.pageY)}
                          tokens={tokens}
                        />
                      ))}
                    </View>
                  ))}
                </SessionGroup>
              )}

              <SessionGroup
                label="Chats"
                tokens={tokens}
                action={{
                  icon: Search,
                  label: 'Buscar conversas',
                  onPress: () => {
                    closeSidebar()
                    router.push('/(main)/search')
                  },
                }}
              >
                {recent.length === 0 ? (
                  <Text className="px-4 py-2 text-sm" style={{ color: tokens.mutedForeground }}>
                    {pinned.length === 0 && folderGroups.length === 0
                      ? 'Nenhuma conversa ainda'
                      : 'Nenhum chat recente'}
                  </Text>
                ) : (
                  recent.map((s) => (
                    <SessionRow
                      key={s.id}
                      title={s.title}
                      active={s.id === activeSessionId}
                      streaming={status[s.id] === 'streaming' || status[s.id] === 'submitted'}
                      unread={unreadCounts[s.id] > 0}
                      selectionMode={selectionMode}
                      selected={selectedIds.has(s.id)}
                      onPress={() => handleOpenSession(s.id)}
                      onLongPress={(e) => openSessionMenu(s.id, e.nativeEvent.pageY)}
                      tokens={tokens}
                    />
                  ))
                )}
              </SessionGroup>
            </View>
          </ScrollView>

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
                destructive={item.label === 'Desconectar'}
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
        title="Renomear conversa"
        initialValue={renamingSessionTarget?.title ?? ''}
        onClose={() => setRenamingSession(null)}
        onSubmit={(title) => renamingSessionTarget && void renameSession(renamingSessionTarget.id, title)}
      />
      <RenamePrompt
        visible={renamingFolder !== null}
        title="Renomear pasta"
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

const SessionGroup = memo(function SessionGroup({
  label,
  children,
  tokens,
  action,
}: {
  label: string
  children: React.ReactNode
  tokens: ThemeTokens
  action?: {
    icon: typeof Search
    label: string
    onPress: () => void
  }
}) {
  const ActionIcon = action?.icon
  return (
    <View className="mb-2">
      <View className="flex-row items-center justify-between px-4 pb-3">
        <Text className="text-xs font-medium uppercase tracking-wide" style={{ color: tokens.mutedForeground }}>
          {label}
        </Text>
        {action && ActionIcon && (
          <Pressable
            onPress={action.onPress}
            hitSlop={10}
            accessibilityLabel={action.label}
            className="h-7 w-7 items-center justify-center rounded-md active:opacity-70"
          >
            <ActionIcon size={16} color={tokens.mutedForeground} />
          </Pressable>
        )}
      </View>
      {children}
    </View>
  )
})

const SessionRow = memo(function SessionRow({
  title,
  active,
  streaming,
  unread,
  indented,
  selectionMode,
  selected,
  onPress: _onPress,
  onLongPress: _onLongPress,
  tokens,
}: {
  title: string
  active: boolean
  streaming?: boolean
  unread?: boolean
  indented?: boolean
  selectionMode?: boolean
  selected?: boolean
  onPress: () => void
  onLongPress?: (e: GestureResponderEvent) => void
  tokens: ThemeTokens
}) {
  return (
    <Pressable
      onPress={_onPress}
      onLongPress={_onLongPress}
      className={cn(
        'mx-3 mb-0.5 flex-row items-center gap-3 rounded-lg px-3 py-2.5',
        indented && 'ml-6',
      )}
      style={(active || selected) ? { backgroundColor: tokens.accent } : undefined}
    >
      {selectionMode ? (
        selected ? (
          <Check size={16} color={tokens.primary} />
        ) : (
          <Square size={16} color={tokens.mutedForeground} />
        )
      ) : streaming ? (
        <Spin><Loader2 size={16} color={tokens.primary} /></Spin>
      ) : unread ? (
        <View className="size-4 items-center justify-center">
          <View className="size-2.5 rounded-full" style={{ backgroundColor: tokens.primary }} />
        </View>
      ) : (
        <MessageSquare size={16} color={active ? tokens.foreground : tokens.mutedForeground} />
      )}
      <Text
        className={cn('flex-1 text-sm', active && 'font-medium')}
        numberOfLines={1}
        style={{ color: tokens.foreground }}
      >
        {title}
      </Text>
    </Pressable>
  )
}, (prev, next) =>
  prev.title === next.title &&
  prev.active === next.active &&
  prev.streaming === next.streaming &&
  prev.unread === next.unread &&
  prev.indented === next.indented &&
  prev.selectionMode === next.selectionMode &&
  prev.selected === next.selected &&
  prev.tokens === next.tokens
)
