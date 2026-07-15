import { View, Text } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useConnectionStore } from '~/stores/connection-store'
import { ConnectionStatus } from '~/components/connection/ConnectionStatus'
import { Button } from '~/components/ui/button'

export default function AppIndex() {
  const { connection, disconnect } = useConnectionStore()

  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-1 items-center justify-center gap-4 px-6">
        <Text className="text-2xl font-bold text-foreground">
          Orbit Mobile
        </Text>
        <Text className="text-sm text-muted-foreground">
          Conectado com sucesso!
        </Text>
        <ConnectionStatus state={connection} detailed />
        <Button variant="outline" onPress={disconnect}>
          Desconectar
        </Button>
      </View>
    </SafeAreaView>
  )
}
