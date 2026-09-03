import { memo, useCallback } from 'react'
import { ChatAssistantMessage } from '~/components/chat/ChatAssistantMessage'
import type { ChatMessage } from '@orbit/shared'

interface MessageBubbleProps {
  message: ChatMessage
  isLast?: boolean
  isBusy?: boolean
  /** Recebe o id em vez de uma closure por linha: com `() => onRevert(id)` a
   *  prop era nova a cada render da lista e o memo abaixo nunca segurava. */
  onRevert?: (messageId: string) => void
}

// memo: durante o streaming só a mensagem em atualização troca de identidade —
// as demais bolhas (e seus parses de markdown) não podem re-renderizar a cada
// flush de delta, senão a thread JS satura e o stream "congela".
export const MessageBubble = memo(function MessageBubble({ message, isLast, isBusy, onRevert }: MessageBubbleProps) {
  const handleRevert = useCallback(() => onRevert?.(message.id), [onRevert, message.id])
  return (
    <ChatAssistantMessage
      message={message}
      isLast={isLast}
      isBusy={isBusy}
      onRevert={onRevert ? handleRevert : undefined}
    />
  )
})
