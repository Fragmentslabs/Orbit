import { useRef, useEffect } from 'react'
import { View, FlatList } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { MessageCircle } from 'lucide-react-native'
import { useSessionStore } from '~/stores/session-store'
import { useChatStore } from '~/stores/chat-store'
import { AppHeader } from '~/components/layout/AppHeader'
import { EmptyState } from '~/components/layout/EmptyState'
import { ResponsiveContainer } from '~/components/layout/ResponsiveContainer'
import { MessageBubble } from '~/components/chat/MessageBubble'
import { ChatInput } from '~/components/chat/ChatInput'
import { StreamingIndicator } from '~/components/chat/StreamingIndicator'
import { AskCard } from '~/components/chat/AskCard'
import { cn } from '~/lib/utils'

export default function ChatScreen() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const messages = useSessionStore((s) => s.messages)
  const status = useSessionStore((s) => s.status)
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const abortChat = useSessionStore((s) => s.abortChat)
  const pendingAsks = useChatStore((s) => s.pendingAsks)
  const replyToAsk = useChatStore((s) => s.replyToAsk)
  const listRef = useRef<FlatList>(null)

  const activeMessages = activeSessionId ? messages[activeSessionId] ?? [] : []
  const activeStatus = activeSessionId ? status[activeSessionId] : undefined
  const activeAsks = activeSessionId ? pendingAsks[activeSessionId] ?? [] : []
  const isStreaming = activeStatus === 'streaming' || activeStatus === 'submitted'

  useEffect(() => {
    if (activeMessages.length > 0) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100)
    }
  }, [activeMessages.length])

  if (!activeSessionId) {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <AppHeader title="Chat" />
        <ResponsiveContainer>
          <EmptyState
            icon={MessageCircle}
            title="Nenhuma sessão selecionada"
            description="Selecione uma sessão na aba Sessões para iniciar uma conversa."
          />
        </ResponsiveContainer>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <AppHeader title="Chat" />

      <ResponsiveContainer
        maxWidth="max-w-3xl"
        mobilePadding={false}
        className="flex-1"
      >
        <View className="flex-1">
          {/* Pending asks */}
          {activeAsks.map((ask) => (
            <AskCard
              key={ask.requestId}
              ask={ask}
              onReply={(value) => replyToAsk(ask.requestId, value)}
            />
          ))}

          {/* Messages */}
          <FlatList
            ref={listRef}
            data={activeMessages}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <View className={cn('px-4', 'md:px-6')}>
                <MessageBubble message={item} />
              </View>
            )}
            contentContainerStyle={{ paddingVertical: 8 }}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
          />

          {/* Streaming indicator */}
          {isStreaming && (
            <View className="px-4 md:px-6 py-2">
              <StreamingIndicator />
            </View>
          )}

          {/* Input */}
          <View className="px-4 md:px-6 pb-4">
            <ChatInput
              onSend={sendMessage}
              onAbort={() => activeSessionId && abortChat(activeSessionId)}
              isStreaming={isStreaming}
            />
          </View>
        </View>
      </ResponsiveContainer>
    </SafeAreaView>
  )
}
