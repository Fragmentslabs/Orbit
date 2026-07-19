import { memo } from 'react'
import { PromptInput } from './PromptInput'
import type { SendMessageOptions, FilePart, SessionInfo } from '@orbit/shared'

interface ChatInputProps {
  onSend: (text: string, options?: SendMessageOptions, files?: FilePart[]) => void
  onAbort: () => void
  isStreaming?: boolean
  sessionId?: string
  disabled?: boolean
  onCreateSession?: () => Promise<SessionInfo | null>
  onNavigateToSession?: (sessionId: string) => void
}

// memo: o input (com picker de modelo, bottom sheet etc.) não precisa
// re-renderizar a cada flush de delta do streaming da conversa.
export const ChatInput = memo(function ChatInput({ onSend, onAbort, isStreaming, sessionId, disabled, onCreateSession, onNavigateToSession }: ChatInputProps) {
  return (
    <PromptInput
      onSend={(text, options, files) => {
        onSend(text, options, files)
      }}
      onAbort={onAbort}
      isStreaming={isStreaming}
      sessionId={sessionId}
      disabled={disabled}
      onCreateSession={onCreateSession}
      onNavigateToSession={onNavigateToSession}
    />
  )
})
