import { View, Text } from 'react-native'
import { cn } from '~/lib/utils'

interface QueueIndicatorProps {
  count: number
}

export function QueueIndicator({ count }: QueueIndicatorProps) {
  if (count === 0) return null

  return (
    <View className="flex-row items-center gap-1 px-2 py-0.5 rounded-full bg-muted">
      <View className="h-1.5 w-1.5 rounded-full bg-primary" />
      <Text className="text-xs text-muted-foreground tabular-nums">{count}</Text>
    </View>
  )
}
