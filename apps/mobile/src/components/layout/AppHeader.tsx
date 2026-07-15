import { View, Text } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useConnectionStore } from '~/stores/connection-store'
import { ConnectionStatus } from '~/components/connection/ConnectionStatus'
import { cn } from '~/lib/utils'

interface AppHeaderProps {
  title?: string
  rightAction?: React.ReactNode
  className?: string
}

export function AppHeader({ title, rightAction, className }: AppHeaderProps) {
  const connection = useConnectionStore((s) => s.connection)

  return (
    <SafeAreaView edges={['top']} className={cn('bg-background', className)}>
      <View className="flex-row items-center justify-between px-4 py-3 border-b border-border">
        <View className="flex-1">
          {title && (
            <Text className="text-lg font-bold text-foreground">
              {title}
            </Text>
          )}
          <ConnectionStatus state={connection} detailed />
        </View>
        {rightAction && (
          <View className="ml-4">
            {rightAction}
          </View>
        )}
      </View>
    </SafeAreaView>
  )
}
