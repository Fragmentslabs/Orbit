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
  ListFooterComponent?: React.ReactElement
}

export interface MessageListHandle {
  scrollToMessageId: (id: string) => void
}

// memo: a lista não pode re-renderizar quando o modo chat/código troca (o
// delay da troca de aba era em parte o FlatList inteiro reconciliando). Com
// props estáveis (messages por referência, footer via useMemo no ChatScreen),
// o memo segura e a lista fica intocada.
export const MessageList = memo(
  forwardRef<MessageListHandle, MessageListProps>(function MessageList(
    { messages, isStreaming, onRevert, ListFooterComponent },
    ref,
  ) {
    const listRef = useRef<FlatList<ChatMessage>>(null)
    const [isAtBottom, setIsAtBottom] = useState(true)
    // `pinnedRef` é a fonte de verdade para "ancorado no rodapé" (sem re-render):
    // guia o autoscroll pelo crescimento real do conteúdo durante o streaming.
    const pinnedRef = useRef(true)
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
      // Subir acima do limite desancora; chegar no fundo re-ancora.
      pinnedRef.current = atBottom
    }, [])

    const scrollToBottom = useCallback(() => {
      listRef.current?.scrollToEnd({ animated: true })
      setIsAtBottom(true)
      pinnedRef.current = true
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

    useImperativeHandle(ref, () => ({
      scrollToMessageId: (id: string) => {
        const index = messages.findIndex((m) => m.id === id)
        if (index === -1) return
        try {
          listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.35 })
        } catch {
          // ignora — item ainda não medido, o fallback abaixo cobre esse caso
        }
      },
    }), [messages])

    return (
      <View className="flex-1 relative">
        <FlatList
          ref={listRef}
          style={{ flex: 1 }}
          data={messages}
          keyExtractor={(item) => item.id}
          renderItem={({ item, index }) => (
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
                  onRevert={onRevert ? () => onRevert(item.id) : undefined}
                />
              )}
            </View>
          )}
          ListFooterComponent={ListFooterComponent}
          contentContainerStyle={{ paddingVertical: 8, paddingHorizontal: 16 }}
          onScroll={handleScroll}
          scrollEventThrottle={100}
          onContentSizeChange={(_width, height) => {
            // Usa a altura medida do conteúdo (== offset do rodapé) em vez de
            // scrollToEnd, que adivinha a posição e "pula" errado no streaming.
            if (pinnedRef.current) {
              requestAnimationFrame(() => {
                listRef.current?.scrollToOffset({ offset: height, animated: false })
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
