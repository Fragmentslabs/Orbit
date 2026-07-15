import { useMemo, useCallback } from 'react'
import { View, Text, Pressable } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { Menu, ChevronDown, MessageCircle } from 'lucide-react-native'
import { useSessionStore } from '~/stores/session-store'
import { useChatStore } from '~/stores/chat-store'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { MessageList } from '~/components/chat/MessageList'
import { ChatInput } from '~/components/chat/ChatInput'
import { AskCard } from '~/components/chat/AskCard'
import { EmptyState } from '~/components/layout/EmptyState'
import { ResponsiveContainer } from '~/components/layout/ResponsiveContainer'

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const openSidebar = useWorkspaceStore((s) => s.openSidebar)

  const sessions = useSessionStore((s) => s.sessions)
  const messages = useSessionStore((s) => s.messages)
  const status = useSessionStore((s) => s.status)
  const selectSession = useSessionStore((s) => s.selectSession)
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const abortChat = useSessionStore((s) => s.abortChat)
  const pendingAsks = useChatStore((s) => s.pendingAsks)
  const replyToAsk = useChatStore((s) => s.replyToAsk)

  // Ensure session is selected
  const session = useMemo(() => sessions.find((s) => s.id === id), [sessions, id])
  const activeMessages = messages[id] ?? []
  const activeStatus = status[id]
  const isStreaming = activeStatus === 'streaming' || activeStatus === 'submitted'
  const activeAsks = pendingAsks[id] ?? []

  // Select session if not already active
  useMemo(() => {
    if (id) selectSession(id)
  }, [id])

  const handleSend = useCallback(
    (text: string) => {
      sendMessage(text)
    },
    [sendMessage],
  )

  const handleAbort = useCallback(() => {
    if (id) abortChat(id)
  }, [id, abortChat])

  if (!session) {
    return (
      <SafeAreaView className="flex-1 bg-background" edges={['top']}>
        <View className="flex-row items-center px-4 py-3 border-b border-border">
          <Pressable onPress={() => router.back()} className="p-1 -ml-1">
            <Text className="text-sm text-primary">Voltar</Text>
          </Pressable>
        </View>
        <EmptyState
          icon={MessageCircle}
          title="Sessão não encontrada"
          description="Esta sessão pode ter sido removida."
        />
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header with hamburger + title + actions */}
      <View className="flex-row items-center px-4 py-3 border-b border-border">
        <Pressable onPress={openSidebar} className="p-1 -ml-1">
          <Menu size={22} className="text-foreground" />
        </Pressable>

        <View className="flex-1 mx-3">
          <Text className="text-sm font-semibold text-foreground text-center" numberOfLines={1}>
            {session.title}
          </Text>
        </View>

        <Pressable className="p-1 -mr-1">
          <ChevronDown size={20} className="text-muted-foreground" />
        </Pressable>
      </View>

      <ResponsiveContainer maxWidth="max-w-3xl" mobilePadding={false} className="flex-1">
        {activeAsks.map((ask) => (
          <AskCard
            key={ask.requestId}
            ask={ask}
            onReply={(value) => replyToAsk(ask.requestId, value)}
          />
        ))}

        <MessageList messages={activeMessages} isStreaming={isStreaming} />

        <ChatInput
          onSend={handleSend}
          onAbort={handleAbort}
          isStreaming={isStreaming}
        />
      </ResponsiveContainer>
    </SafeAreaView>
  )
}
