import { View, Text, FlatList, Pressable, RefreshControl } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useCallback, useEffect, useState } from 'react'
import { MessageSquare, Clock, Loader2, Search } from 'lucide-react-native'
import { useRouter } from 'expo-router'
import { useSessionStore } from '~/stores/session-store'
import { useChatStore } from '~/stores/chat-store'
import { AppHeader } from '~/components/layout/AppHeader'
import { EmptyState } from '~/components/layout/EmptyState'
import { ResponsiveContainer } from '~/components/layout/ResponsiveContainer'
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

export default function SessionsScreen() {
  const router = useRouter()
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const selectSession = useSessionStore((s) => s.selectSession)
  const fetchSessions = useSessionStore((s) => s.fetchSessions)
  const status = useSessionStore((s) => s.status)
  const pendingAsks = useChatStore((s) => s.pendingAsks)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    fetchSessions()
  }, [])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    await fetchSessions()
    setRefreshing(false)
  }, [])

  const handleSelectSession = useCallback((id: string) => {
    selectSession(id)
    router.push('/(app)')
  }, [])

  const renderSession = useCallback(({ item }: { item: typeof sessions[number] }) => {
    const isActive = item.id === activeSessionId
    const sessionStatus = status[item.id]
    const askCount = pendingAsks[item.id]?.length ?? 0

    return (
      <Pressable
        onPress={() => handleSelectSession(item.id)}
        className={cn(
          'flex-row items-center gap-3 px-4 py-3 rounded-lg border',
          'md:mx-0 mx-4 mb-2',
          isActive
            ? 'bg-accent border-primary/30'
            : 'bg-card border-border',
        )}
      >
        <View className="flex-shrink-0">
          {sessionStatus === 'streaming' || sessionStatus === 'submitted' ? (
            <Loader2 size={20} className="text-primary animate-spin" />
          ) : (
            <MessageSquare size={20} className="text-muted-foreground" />
          )}
        </View>

        <View className="flex-1 min-w-0">
          <Text
            className="text-sm font-medium text-foreground truncate"
            numberOfLines={1}
          >
            {item.title}
          </Text>
          <View className="flex-row items-center gap-2 mt-0.5">
            <Clock size={10} className="text-muted-foreground" />
            <Text className="text-xs text-muted-foreground">
              {formatRelativeTime(item.updatedAt)}
            </Text>
            {item.mode && (
              <Badge variant="secondary" className="px-1 py-0">
                <Text className="text-[10px]">{item.mode}</Text>
              </Badge>
            )}
          </View>
        </View>

        {askCount > 0 && (
          <Badge variant="destructive">
            <Text className="text-xs">{askCount}</Text>
          </Badge>
        )}
      </Pressable>
    )
  }, [activeSessionId, status, pendingAsks])

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <AppHeader title="Sessões" />

      <ResponsiveContainer maxWidth="max-w-4xl" className="flex-1">
        {sessions.length === 0 ? (
          <EmptyState
            icon={Search}
            title="Nenhuma sessão"
            description="As sessões do desktop aparecerão aqui."
            action={
              <Pressable onPress={fetchSessions} className="px-4 py-2 rounded-lg bg-primary">
                <Text className="text-sm text-primary-foreground">Carregar sessões</Text>
              </Pressable>
            }
          />
        ) : (
          <FlatList
            data={sessions}
            keyExtractor={(item) => item.id}
            renderItem={renderSession}
            contentContainerStyle={{ paddingVertical: 8 }}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
            }
          />
        )}
      </ResponsiveContainer>
    </SafeAreaView>
  )
}
