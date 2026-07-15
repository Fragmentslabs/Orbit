import { useRef, useEffect } from 'react'
import { View, FlatList } from 'react-native'
import { MessageBubble } from '~/components/chat/MessageBubble'
import { StreamingIndicator } from '~/components/chat/StreamingIndicator'
import { cn } from '~/lib/utils'
import type { ChatMessage } from '@orbit/shared'

interface MessageListProps {
  messages: ChatMessage[]
  isStreaming?: boolean
}

export function MessageList({ messages, isStreaming }: MessageListProps) {
  const listRef = useRef<FlatList<ChatMessage>>(null)

  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100)
    }
  }, [messages.length])

  return (
    <View className="flex-1">
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <View className={cn('px-4', 'md:px-6')}>
            <MessageBubble message={item} />
          </View>
        )}
        contentContainerStyle={{ paddingVertical: 8 }}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
      />

      {isStreaming && (
        <View className="px-4 md:px-6 py-2">
          <StreamingIndicator />
        </View>
      )}
    </View>
  )
}
