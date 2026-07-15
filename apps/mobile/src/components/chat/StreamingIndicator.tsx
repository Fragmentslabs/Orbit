import { View } from 'react-native'
import { cn } from '~/lib/utils'

export function StreamingIndicator({ className }: { className?: string }) {
  return (
    <View className={cn('flex-row items-center gap-1', className)}>
      <View className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
      <View className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse opacity-70" />
      <View className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse opacity-40" />
    </View>
  )
}
