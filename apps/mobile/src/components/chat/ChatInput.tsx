import { memo } from 'react'
import { PromptInput } from './PromptInput'
import type { SendMessageOptions, FilePart, SessionInfo } from '@orbit/shared'

interface ChatInputProps {
  onSend: (text: string, options?: SendMessageOptions, files?: FilePart[]) => void
  onAbort: () => void
  isStreaming?: boolean
  sessionId?: string
  disabled?: boolean
  sendDisabled?: boolean
  onCreateSession?: () => Promise<SessionInfo | null>
  onNavigateToSession?: (sessionId: string) => void
}

// memo: the input (with model picker, bottom sheet etc.) does not need to
// re-render on every delta flush of the conversation streaming.
export const ChatInput = memo(function ChatInput({ onSend, onAbort, isStreaming, sessionId, disabled, sendDisabled, onCreateSession, onNavigateToSession }: ChatInputProps) {
  return (
    <PromptInput
      onSend={(text, options, files) => {
        onSend(text, options, files)
      }}
      onAbort={onAbort}
      isStreaming={isStreaming}
      sessionId={sessionId}
      disabled={disabled}
      sendDisabled={sendDisabled}
      onCreateSession={onCreateSession}
      onNavigateToSession={onNavigateToSession}
    />
  )
})
