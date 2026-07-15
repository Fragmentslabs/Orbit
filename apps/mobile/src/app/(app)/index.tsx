import { SafeAreaView } from 'react-native-safe-area-context'
import { MessageCircle } from 'lucide-react-native'
import { useSessionStore } from '~/stores/session-store'
import { useChatStore } from '~/stores/chat-store'
import { AppHeader } from '~/components/layout/AppHeader'
import { EmptyState } from '~/components/layout/EmptyState'
import { ResponsiveContainer } from '~/components/layout/ResponsiveContainer'
import { MessageList } from '~/components/chat/MessageList'
import { ChatInput } from '~/components/chat/ChatInput'
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
        {activeAsks.map((ask) => (
          <AskCard
            key={ask.requestId}
            ask={ask}
            onReply={(value) => replyToAsk(ask.requestId, value)}
          />
        ))}

        <MessageList messages={activeMessages} isStreaming={isStreaming} />

        <ChatInput
          onSend={sendMessage}
          onAbort={() => activeSessionId && abortChat(activeSessionId)}
          isStreaming={isStreaming}
        />
      </ResponsiveContainer>
    </SafeAreaView>
  )
}
