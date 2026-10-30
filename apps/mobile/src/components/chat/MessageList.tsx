import { useRef, useEffect, useCallback, useState, forwardRef, useImperativeHandle, memo } from 'react'
import { View, FlatList, Pressable, Keyboard } from 'react-native'
import { ChevronDown } from 'lucide-react-native'
import { MessageBubble } from '~/components/chat/MessageBubble'
import { SummaryCard } from '~/components/chat/SummaryCard'
import { DateSeparator, isNewDay } from '~/components/chat/DateSeparator'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import type { ChatMessage } from '@orbit/shared'

interface MessageListProps {
  messages: ChatMessage[]
  isStreaming?: boolean
  onRevert?: (messageId: string) => void
  onReply?: (message: ChatMessage) => void
  ListFooterComponent?: React.ReactElement
  onLoadOlder?: () => void
  /** Notifies when the list leaves/returns to the end — whoever shows the pending
   *  chip uses this to know whether the request card is out of view. It only fires
   *  on the CHANGE (the scroll is continuous and cannot re-render the screen). */
  onAtBottomChange?: (atBottom: boolean) => void
}

export interface MessageListHandle {
  scrollToMessageId: (id: string) => void
  scrollToEnd: () => void
}

// memo: the list cannot re-render when the chat/code mode changes (the
// delay of the tab switch was partly the whole FlatList reconciling). With
// stable props (messages by reference, footer via useMemo in ChatScreen),
// the memo holds and the list stays untouched.
export const MessageList = memo(
  forwardRef<MessageListHandle, MessageListProps>(function MessageList(
    { messages, isStreaming, onRevert, onReply, ListFooterComponent, onLoadOlder, onAtBottomChange },
    ref,
  ) {
    const listRef = useRef<FlatList<ChatMessage>>(null)
    const [isAtBottom, setIsAtBottom] = useState(true)
    const loadingOlderRef = useRef(false)
    // guides the autoscroll by the real growth of the content during streaming.
    const pinnedRef = useRef(true)
    /** Last value notified to the parent — avoids a setState per scroll event. */
    const lastAtBottomRef = useRef(true)
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
      // Going above the limit unanchors; reaching the bottom re-anchors.
      pinnedRef.current = atBottom
      if (atBottom !== lastAtBottomRef.current) {
        lastAtBottomRef.current = atBottom
        onAtBottomChange?.(atBottom)
      }
    }, [onAtBottomChange])

    const handleLoadOlder = useCallback(() => {
      if (loadingOlderRef.current || !onLoadOlder) return
      loadingOlderRef.current = true
      onLoadOlder()
      setTimeout(() => {
        loadingOlderRef.current = false
      }, 500)
    }, [onLoadOlder])

    const scrollToBottom = useCallback(() => {
      listRef.current?.scrollToEnd({ animated: true })
      setIsAtBottom(true)

    }, [])

    // Auto-scroll when the keyboard opens (keeps the last messages visible)
    useEffect(() => {
      const show = Keyboard.addListener('keyboardDidShow', () => {
        if (isAtBottom) {
          setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100)
        }
      })
      return () => show.remove()
    }, [isAtBottom])

    useImperativeHandle(ref, () => ({
      scrollToMessageId: (id: string) => {
        const index = messages.findIndex((m) => m.id === id)
        if (index === -1) return
        try {
          listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.35 })
        } catch {
          // ignore — item not measured yet, the fallback below covers that case
        }
      },
      scrollToEnd: () => {
        // Re-anchors before scrolling: without this the first scroll event
        // during the animation would unanchor again and the chip would not go away.
        pinnedRef.current = true
        setIsAtBottom(true)
        listRef.current?.scrollToEnd({ animated: true })
      },
    }), [messages])

    // stable renderItem: inline, it was recreated on every render of the list and the
    // props of the rows came in new along with it — the memo of MessageBubble held
    // nothing, so the WHOLE visible window re-rendered on every delta flush of the
    // streaming. `onRevert` receives the id, and not a closure per row.
    const renderItem = useCallback(
      ({ item, index }: { item: ChatMessage; index: number }) => (
        <View className="py-1">
          {isNewDay(messages[index - 1]?.createdAt, item.createdAt) && (
            <DateSeparator timestamp={item.createdAt} />
          )}
          {item.summary ? (
            <SummaryCard message={item} />
          ) : (
            <MessageBubble
              message={item}
              isLast={index === messages.length - 1}
              isBusy={isStreaming}
              onRevert={onRevert}
              onReply={onReply}
            />
          )}
        </View>
      ),
      [messages, isStreaming, onRevert, onReply],
    )

    return (
      <View className="flex-1 relative">
        <FlatList
          ref={listRef}
          style={{ flex: 1 }}
          data={messages}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          ListFooterComponent={ListFooterComponent}
          contentContainerStyle={{ paddingVertical: 8, paddingHorizontal: 16 }}
          initialNumToRender={8}
          maxToRenderPerBatch={6}
          windowSize={5}
          updateCellsBatchingPeriod={50}
          removeClippedSubviews
          onStartReached={handleLoadOlder}
          onStartReachedThreshold={0.2}
          onScroll={handleScroll}

          onContentSizeChange={(_width, height) => {
            // Uses the measured height of the content (== footer offset) instead of
            // scrollToEnd, which guesses the position and "jumps" wrongly during streaming.
            if (pinnedRef.current) {
              requestAnimationFrame(() => {
                listRef.current?.scrollToEnd({ animated: false })
              })
            }
          }}
          onScrollToIndexFailed={(info) => {
            setTimeout(() => {
              listRef.current?.scrollToIndex({ index: info.index, animated: true, viewPosition: 0.35 })
            }, 100)
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
  }),
)
