import { View, Pressable } from 'react-native'
import { Send, Square, ArrowUp } from 'lucide-react-native'
import { cn } from '~/lib/utils'

interface SendButtonGroupProps {
  onSend: () => void
  onAbort: () => void
  isStreaming: boolean
  hasText: boolean
  disabled?: boolean
}

export function SendButtonGroup({
  onSend,
  onAbort,
  isStreaming,
  hasText,
  disabled,
}: SendButtonGroupProps) {
  if (isStreaming) {
    return (
      <Pressable
        onPress={onAbort}
        className="h-8 w-8 rounded-full bg-destructive items-center justify-center"
      >
        <Square size={12} className="text-destructive-foreground" fill="currentColor" />
      </Pressable>
    )
  }

  return (
    <Pressable
      onPress={onSend}
      disabled={!hasText || disabled}
      className={cn(
        'h-8 w-8 rounded-full items-center justify-center',
        hasText && !disabled ? 'bg-primary' : 'bg-muted',
      )}
    >
      <ArrowUp
        size={16}
        className={cn(
          hasText && !disabled ? 'text-primary-foreground' : 'text-muted-foreground',
        )}
      />
    </Pressable>
  )
}
