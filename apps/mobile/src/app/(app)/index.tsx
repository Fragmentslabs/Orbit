import { View, FlatList } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { MessageCircle } from 'lucide-react-native'
import { useSessionStore } from '~/stores/session-store'
import { useChatStore } from '~/stores/chat-store'
import { AppHeader } from '~/components/layout/AppHeader'
import { EmptyState } from '~/components/layout/EmptyState'
import { MessageBubble } from '~/components/chat/MessageBubble'
import { ChatInput } from '~/components/chat/ChatInput'
import { StreamingIndicator } from '~/components/chat/StreamingIndicator'
import { AskCard } from '~/components/chat/AskCard'

export default function ChatScreen() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const messages = useSessionStore((s) => s.messages)
  const status = useSessionStore((s) => s.status)
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const abortChat = useSessionStore((s) => s.abortChat)
  const pendingAsks = useChatStore((s) => s.pendingAsks)
  const replyToAsk = useChatStore((s) => s.replyToAsk)

  const activeMessages = activeSessionId ? messages[activeSessionId] ?? [] : []
  const activeStatus = activeSessionId ? status[activeSessionId] : undefined
  const activeAsks = activeSessionId ? pendingAsks[activeSessionId] ?? [] : []
  const isStreaming = activeStatus === 'streaming' || activeStatus === 'submitted'

  if (!activeSessionId) {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <AppHeader title="Chat" />
        <EmptyState
          icon={MessageCircle}
          title="Nenhuma sessão selecionada"
          description="Selecione uma sessão na aba Sessões para iniciar uma conversa."
        />
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <AppHeader title="Chat" />

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
        data={activeMessages}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <MessageBubble message={item} />}
        contentContainerStyle={{ paddingVertical: 8 }}
        inverted={false}
      />

      {/* Streaming indicator */}
      {isStreaming && (
        <View className="px-4 py-2">
          <StreamingIndicator />
        </View>
      )}

      {/* Input */}
      <ChatInput
        onSend={sendMessage}
        onAbort={() => activeSessionId && abortChat(activeSessionId)}
        isStreaming={isStreaming}
      />
    </SafeAreaView>
  )
}
