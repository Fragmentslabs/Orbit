import { View, Text } from 'react-native'
import type { LucideIcon } from 'lucide-react-native'
import { cn } from '~/lib/utils'

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <View className={cn('flex-1 items-center justify-center gap-3 px-8', className)}>
      <View className="rounded-full bg-muted p-4">
        <Icon size={32} className="text-muted-foreground" />
      </View>
      <Text className="text-base font-semibold text-foreground text-center">
        {title}
      </Text>
      {description ? (
        <Text className="text-sm text-muted-foreground text-center leading-relaxed">
          {description}
        </Text>
      ) : null}
      {action ? <View className="mt-2">{action}</View> : null}
    </View>
  )
}
