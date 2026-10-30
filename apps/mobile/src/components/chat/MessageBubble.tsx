import { memo, useCallback } from 'react'
import { ChatAssistantMessage } from '~/components/chat/ChatAssistantMessage'
import type { ChatMessage } from '@orbit/shared'

interface MessageBubbleProps {
  message: ChatMessage
  isLast?: boolean
  isBusy?: boolean
  /** Receives the id instead of a closure per row: with `() => onRevert(id)` the
   *  prop was new on every render of the list and the memo below never held. */
  onRevert?: (messageId: string) => void
  onReply?: (message: ChatMessage) => void
}

// memo: during streaming only the message being updated changes identity —
// the other bubbles (and their markdown parses) cannot re-render on every
// delta flush, otherwise the JS thread saturates and the stream "freezes".
export const MessageBubble = memo(function MessageBubble({ message, isLast, isBusy, onRevert, onReply }: MessageBubbleProps) {
  const handleRevert = useCallback(() => onRevert?.(message.id), [onRevert, message.id])
  return (
    <ChatAssistantMessage
      message={message}
      isLast={isLast}
      isBusy={isBusy}
      onRevert={onRevert ? handleRevert : undefined}
      onReply={onReply}
    />
  )
})
