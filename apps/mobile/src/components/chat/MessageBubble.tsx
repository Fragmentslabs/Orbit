import { memo } from 'react'
import { ChatAssistantMessage } from '~/components/chat/ChatAssistantMessage'
import type { ChatMessage } from '@orbit/shared'

interface MessageBubbleProps {
  message: ChatMessage
  isLast?: boolean
  isBusy?: boolean
  onRevert?: () => void
}

// memo: durante o streaming só a mensagem em atualização troca de identidade —
// as demais bolhas (e seus parses de markdown) não podem re-renderizar a cada
// flush de delta, senão a thread JS satura e o stream "congela".
export const MessageBubble = memo(function MessageBubble({ message, isLast, isBusy, onRevert }: MessageBubbleProps) {
  return <ChatAssistantMessage message={message} isLast={isLast} isBusy={isBusy} onRevert={onRevert} />
})
