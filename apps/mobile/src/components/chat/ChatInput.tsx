import { View, TextInput, Pressable } from 'react-native'
import { useState, useRef, useCallback } from 'react'
import { Send, Square } from 'lucide-react-native'
import { cn } from '~/lib/utils'

interface ChatInputProps {
  onSend: (text: string) => void
  onAbort: () => void
  isStreaming?: boolean
  disabled?: boolean
}

export function ChatInput({ onSend, onAbort, isStreaming, disabled }: ChatInputProps) {
  const [text, setText] = useState('')
  const inputRef = useRef<TextInput>(null)

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed || isStreaming || disabled) return
    onSend(trimmed)
    setText('')
  }, [text, isStreaming, disabled, onSend])

  return (
    <View className="flex-row items-end gap-2 px-4 py-3 border-t border-border bg-background">
      <TextInput
        ref={inputRef}
        value={text}
        onChangeText={setText}
        placeholder="Enviar mensagem..."
        placeholderTextColor="hsl(240, 4%, 46%)"
        multiline
        maxLength={4096}
        editable={!isStreaming && !disabled}
        className="flex-1 px-4 py-2.5 rounded-2xl bg-card border border-border text-sm text-foreground max-h-32"
        style={{ textAlignVertical: 'center' }}
      />

      {isStreaming ? (
        <Pressable
          onPress={onAbort}
          className="h-10 w-10 rounded-full bg-destructive items-center justify-center"
        >
          <Square size={16} className="text-destructive-foreground" fill="currentColor" />
        </Pressable>
      ) : (
        <Pressable
          onPress={handleSend}
          disabled={!text.trim() || disabled}
          className={cn(
            'h-10 w-10 rounded-full items-center justify-center',
            text.trim() && !disabled
              ? 'bg-primary'
              : 'bg-muted',
          )}
        >
          <Send
            size={16}
            className={cn(
              text.trim() && !disabled
                ? 'text-primary-foreground'
                : 'text-muted-foreground',
            )}
          />
        </Pressable>
      )}
    </View>
  )
}
