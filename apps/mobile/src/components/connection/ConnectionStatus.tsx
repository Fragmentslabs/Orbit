import { View, Text } from 'react-native'
import { Wifi, WifiOff, Loader2 } from 'lucide-react-native'
import type { ConnectionState } from '@orbit/companion-client'
import { cn } from '~/lib/utils'
import { Badge } from '~/components/ui/badge'

interface ConnectionStatusProps {
  state: ConnectionState
  /** Mostrar detalhes (latência, device name). */
  detailed?: boolean
  className?: string
}

const STATUS_CONFIG: Record<ConnectionState['status'], { label: string; variant: 'default' | 'secondary' | 'destructive'; Icon: typeof Wifi }> = {
  disconnected: { label: 'Desconectado', variant: 'destructive', Icon: WifiOff },
  connecting: { label: 'Conectando...', variant: 'secondary', Icon: Loader2 },
  authenticating: { label: 'Autenticando...', variant: 'secondary', Icon: Loader2 },
  connected: { label: 'Conectado', variant: 'default', Icon: Wifi },
}

export function ConnectionStatus({ state, detailed, className }: ConnectionStatusProps) {
  const config = STATUS_CONFIG[state.status]
  const { Icon } = config

  return (
    <View className={cn('flex-row items-center gap-2', className)}>
      <Badge variant={config.variant}>
        <View className="flex-row items-center gap-1.5">
          <Icon
            size={12}
            className={cn(
              state.status === 'connecting' || state.status === 'authenticating'
                ? 'animate-spin'
                : undefined,
            )}
          />
          <Text>{config.label}</Text>
        </View>
      </Badge>

      {detailed && state.status === 'connected' && (
        <>
          {state.deviceName && (
            <Text className="text-xs text-muted-foreground">
              {state.deviceName}
            </Text>
          )}
          {state.latency != null && (
            <Text className="text-xs text-muted-foreground">
              {state.latency}ms
            </Text>
          )}
        </>
      )}

      {detailed && state.error && (
        <Text className="text-xs text-destructive" numberOfLines={1}>
          {state.error}
        </Text>
      )}
    </View>
  )
}
