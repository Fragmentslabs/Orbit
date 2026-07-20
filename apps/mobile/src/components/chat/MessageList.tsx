import { useRef, useEffect, useCallback, useState } from 'react'
import { View, FlatList, Pressable, Keyboard } from 'react-native'
import { ChevronDown } from 'lucide-react-native'
import { MessageBubble } from '~/components/chat/MessageBubble'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import type { ChatMessage } from '@orbit/shared'

interface MessageListProps {
  messages: ChatMessage[]
  isStreaming?: boolean
  onRevert?: (messageId: string) => void
  ListFooterComponent?: React.ReactElement
}

export function MessageList({ messages, isStreaming, onRevert, ListFooterComponent }: MessageListProps) {
  const listRef = useRef<FlatList<ChatMessage>>(null)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const isUserScrolling = useRef(false)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  useEffect(() => {
    if (messages.length > 0 && isAtBottom) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50)
    }
  }, [messages.length, isAtBottom])

  const handleScroll = useCallback((event: any) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
    const atBottom = contentOffset.y + layoutMeasurement.height >= contentSize.height - 60
    setIsAtBottom(atBottom)
    if (atBottom) {
      isUserScrolling.current = false
    }
  }, [])

  const scrollToBottom = useCallback(() => {
    listRef.current?.scrollToEnd({ animated: true })
    setIsAtBottom(true)
    isUserScrolling.current = false
  }, [])

  // Auto-scroll quando o teclado abre (mantém últimas mensagens visíveis)
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => {
      if (isAtBottom) {
        setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100)
      }
    })
    return () => show.remove()
  }, [isAtBottom])

  return (
    <View className="flex-1 relative">
      <FlatList
        ref={listRef}
        style={{ flex: 1 }}
        data={messages}
        keyExtractor={(item) => item.id}
        renderItem={({ item, index }) => (
          <View className="py-1">
            <MessageBubble
              message={item}
              isLast={index === messages.length - 1}
              isBusy={isStreaming}
              onRevert={onRevert ? () => onRevert(item.id) : undefined}
            />
          </View>
        )}
        ListFooterComponent={ListFooterComponent}
        contentContainerStyle={{ paddingVertical: 8, paddingHorizontal: 16 }}
        onScroll={handleScroll}
        scrollEventThrottle={100}
        onContentSizeChange={() => {
          if (isAtBottom) {
            listRef.current?.scrollToEnd({ animated: false })
          }
        }}
      />

      {/* Scroll to bottom button */}
      {!isAtBottom && messages.length > 0 && (
        <Pressable
          onPress={scrollToBottom}
          className="absolute bottom-4 self-center h-8 w-8 rounded-full items-center justify-center"
          style={{ backgroundColor: tokens.card, borderWidth: 1, borderColor: tokens.border }}
        >
          <ChevronDown size={16} color={tokens.foreground} />
        </Pressable>
      )}
    </View>
  )
}
