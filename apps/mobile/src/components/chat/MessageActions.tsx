import { View, Text, Pressable } from 'react-native'
import { Copy, RotateCcw, Clock } from 'lucide-react-native'
import { cn } from '~/lib/utils'
import type { ChatMessage } from '@orbit/shared'

interface MessageActionsProps {
  message: ChatMessage
  onCopy?: () => void
  onRevert?: () => void
  compact?: boolean
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

export function MessageActions({ message, onCopy, onRevert, compact }: MessageActionsProps) {
  return (
    <View className={cn('flex-row items-center gap-2 mt-1', compact ? 'opacity-50' : 'opacity-40')}>
      {onCopy && (
        <Pressable onPress={onCopy} className="p-0.5">
          <Copy size={12} className="text-muted-foreground" />
        </Pressable>
      )}
      {onRevert && message.snapshot && (
        <Pressable onPress={onRevert} className="p-0.5">
          <RotateCcw size={12} className="text-muted-foreground" />
        </Pressable>
      )}
      <View className="flex-row items-center gap-1">
        <Clock size={10} className="text-muted-foreground" />
        <Text className="text-[10px] text-muted-foreground">
          {formatTime(message.createdAt)}
        </Text>
      </View>
    </View>
  )
}
