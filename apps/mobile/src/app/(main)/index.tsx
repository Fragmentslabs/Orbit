import { useState, useCallback, useMemo, useEffect } from 'react'
import {
  View,
  Text,
  FlatList,
  Pressable,
  TextInput,
  RefreshControl,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import {
  MessageSquare,
  Clock,
  Loader2,
  Search,
  X,
  Trash2,
  Menu,
} from 'lucide-react-native'
import { useRouter } from 'expo-router'
import { useSessionStore } from '~/stores/session-store'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { useChatStore } from '~/stores/chat-store'
import { EmptyState } from '~/components/layout/EmptyState'
import { Badge } from '~/components/ui/badge'
import { cn } from '~/lib/utils'

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) return 'agora'
  if (minutes < 60) return `${minutes}m`
  if (hours < 24) return `${hours}h`
  return `${days}d`
}

export default function HomeScreen() {
  const router = useRouter()
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const selectSession = useSessionStore((s) => s.selectSession)
  const fetchSessions = useSessionStore((s) => s.fetchSessions)
  const status = useSessionStore((s) => s.status)
  const pendingAsks = useChatStore((s) => s.pendingAsks)
  const mode = useWorkspaceStore((s) => s.mode)
  const setMode = useWorkspaceStore((s) => s.setMode)
  const openSidebar = useWorkspaceStore((s) => s.openSidebar)

  const [search, setSearch] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    fetchSessions()
  }, [])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    await fetchSessions()
    setRefreshing(false)
  }, [])

  const filteredSessions = useMemo(() => {
    let list = [...sessions]

    list.sort((a, b) => b.updatedAt - a.updatedAt)

    if (mode === 'chat') {
      list = list.filter((s) => s.mode === 'chat')
    } else {
      list = list.filter((s) => s.mode === 'code')
    }

    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter((s) => s.title.toLowerCase().includes(q))
    }

    return list
  }, [sessions, mode, search])

  const handleSelectSession = useCallback((id: string) => {
    selectSession(id)
    router.push({ pathname: '/(main)/chat/[id]', params: { id } })
  }, [])

  const enterSelectionMode = useCallback((id: string) => {
    setSelectionMode(true)
    setSelectedIds(new Set([id]))
  }, [])

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      if (next.size === 0) {
        setSelectionMode(false)
      }
      return next
    })
  }, [])

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false)
    setSelectedIds(new Set())
  }, [])

  const handleDeleteSelected = useCallback(() => {
    // Placeholder: delete sessions via WS
    exitSelectionMode()
  }, [])

  const handleLongPress = useCallback((id: string) => {
    enterSelectionMode(id)
  }, [])

  const handlePress = useCallback(
    (id: string) => {
      if (selectionMode) {
        toggleSelected(id)
      } else {
        handleSelectSession(id)
      }
    },
    [selectionMode, handleSelectSession, toggleSelected],
  )

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      {/* Header with hamburger */}
      <View className="flex-row items-center justify-between px-4 py-3 border-b border-border">
        <Pressable onPress={openSidebar} className="p-1 -ml-1">
          <Menu size={22} className="text-foreground" />
        </Pressable>
        {selectionMode ? (
          <View className="flex-row items-center gap-2">
            <Text className="text-sm font-medium text-foreground">
              {selectedIds.size} selecionado{selectedIds.size !== 1 ? 's' : ''}
            </Text>
            <Pressable onPress={exitSelectionMode} className="p-1">
              <X size={18} className="text-muted-foreground" />
            </Pressable>
          </View>
        ) : (
          <Text className="text-base font-semibold text-foreground">
            {mode === 'chat' ? 'Chats' : 'Sessões'}
          </Text>
        )}
        <View className="w-8" />
      </View>

      {/* Mode Tabs */}
      <View className="flex-row border-b border-border">
        <Pressable
          onPress={() => setMode('chat')}
          className={cn(
            'flex-1 py-3 items-center',
            mode === 'chat' ? 'border-b-2 border-primary' : 'border-b-2 border-transparent',
          )}
        >
          <Text
            className={cn(
              'text-sm font-medium',
              mode === 'chat' ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            Chat
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setMode('code')}
          className={cn(
            'flex-1 py-3 items-center',
            mode === 'code' ? 'border-b-2 border-primary' : 'border-b-2 border-transparent',
          )}
        >
          <Text
            className={cn(
              'text-sm font-medium',
              mode === 'code' ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            Código
          </Text>
        </Pressable>
      </View>

      {/* Search */}
      <View className="px-4 py-2">
        <View className="flex-row items-center gap-2 px-3 py-2 rounded-lg bg-muted">
          <Search size={16} className="text-muted-foreground" />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder={mode === 'chat' ? 'Buscar chats...' : 'Buscar sessões...'}
            placeholderTextColor="hsl(240, 4%, 46%)"
            className="flex-1 text-sm text-foreground"
            autoCapitalize="none"
            autoCorrect={false}
          />
          {search ? (
            <Pressable onPress={() => setSearch('')} className="p-1">
              <X size={14} className="text-muted-foreground" />
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* Session List */}
      {filteredSessions.length === 0 ? (
        <EmptyState
          icon={Search}
          title={search ? 'Nenhum resultado' : mode === 'chat' ? 'Nenhum chat' : 'Nenhuma sessão'}
          description={
            search
              ? 'Tente buscar por outro termo.'
              : mode === 'chat'
                ? 'Os chats do desktop aparecerão aqui.'
                : 'As sessões de código do desktop aparecerão aqui.'
          }
          action={
            !search ? (
              <Pressable onPress={fetchSessions} className="px-4 py-2 rounded-lg bg-primary">
                <Text className="text-sm text-primary-foreground">Carregar</Text>
              </Pressable>
            ) : undefined
          }
        />
      ) : (
        <FlatList
          data={filteredSessions}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => {
            const isActive = item.id === activeSessionId
            const sessionStatus = status[item.id]
            const askCount = pendingAsks[item.id]?.length ?? 0
            const isSelected = selectedIds.has(item.id)

            return (
              <Pressable
                onPress={() => handlePress(item.id)}
                onLongPress={() => handleLongPress(item.id)}
                className={cn(
                  'flex-row items-center gap-3 px-4 py-3 border-b border-border',
                  isActive && 'bg-accent',
                  isSelected && 'bg-primary/10',
                )}
              >
                {/* Checkbox (selection mode) */}
                {selectionMode && (
                  <View
                    className={cn(
                      'h-5 w-5 rounded border items-center justify-center',
                      isSelected
                        ? 'bg-primary border-primary'
                        : 'border-muted-foreground',
                    )}
                  >
                    {isSelected && <Text className="text-xs text-primary-foreground font-bold">✓</Text>}
                  </View>
                )}

                {/* Icon */}
                <View className="flex-shrink-0">
                  {sessionStatus === 'streaming' || sessionStatus === 'submitted' ? (
                    <Loader2 size={18} className="text-primary animate-spin" />
                  ) : (
                    <MessageSquare size={18} className="text-muted-foreground" />
                  )}
                </View>

                {/* Info */}
                <View className="flex-1 min-w-0">
                  <Text className="text-sm font-medium text-foreground truncate" numberOfLines={1}>
                    {item.title}
                  </Text>
                  <View className="flex-row items-center gap-2 mt-0.5">
                    <Clock size={10} className="text-muted-foreground" />
                    <Text className="text-xs text-muted-foreground">
                      {formatRelativeTime(item.updatedAt)}
                    </Text>
                    {item.mode && (
                      <Badge variant="secondary" className="px-1 py-0">
                        <Text className="text-[10px]">
                          {item.mode === 'chat' ? 'Chat' : 'Código'}
                        </Text>
                      </Badge>
                    )}
                  </View>
                </View>

                {/* Ask badge */}
                {askCount > 0 && (
                  <Badge variant="destructive">
                    <Text className="text-xs">{askCount}</Text>
                  </Badge>
                )}
              </Pressable>
            )
          }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          contentContainerStyle={{ paddingBottom: 16 }}
        />
      )}

      {/* Batch action bar */}
      {selectionMode && selectedIds.size > 0 && (
        <View className="flex-row items-center justify-between px-4 py-3 border-t border-border bg-background">
          <Text className="text-sm text-muted-foreground">
            {selectedIds.size} selecionado{selectedIds.size !== 1 ? 's' : ''}
          </Text>
          <Pressable
            onPress={handleDeleteSelected}
            className="flex-row items-center gap-2 px-4 py-2 rounded-lg bg-destructive"
          >
            <Trash2 size={16} className="text-destructive-foreground" />
            <Text className="text-sm font-medium text-destructive-foreground">Excluir</Text>
          </Pressable>
        </View>
      )}
    </SafeAreaView>
  )
}
