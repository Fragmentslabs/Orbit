import { View, Text, StyleSheet } from 'react-native'
import { Wifi, WifiOff, Loader2 } from 'lucide-react-native'
import type { ConnectionState } from '@orbit/companion-client'
import { Badge } from '~/components/ui/badge'
import { Spin } from '~/components/ui/spin'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

interface ConnectionStatusProps {
  state: ConnectionState
  detailed?: boolean
}

const STATUS_CONFIG: Record<ConnectionState['status'], { label: string; variant: 'default' | 'secondary' | 'destructive'; Icon: typeof Wifi }> = {
  disconnected: { label: 'Desconectado', variant: 'destructive', Icon: WifiOff },
  connecting: { label: 'Conectando...', variant: 'secondary', Icon: Loader2 },
  authenticating: { label: 'Autenticando...', variant: 'secondary', Icon: Loader2 },
  connected: { label: 'Conectado', variant: 'default', Icon: Wifi },
}

export function ConnectionStatus({ state, detailed }: ConnectionStatusProps) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const config = STATUS_CONFIG[state.status]
  const { Icon } = config
  // Na tela de conexão o "Desconectado" é redundante (a tela inteira já diz
  // isso) — só mostra o badge quando há algo relevante a informar.
  const showBadge = state.status !== 'disconnected'

  return (
    <View style={s.row}>
      {showBadge && (
        <Badge variant={config.variant}>
          <View style={s.badgeInner}>
            <Spin active={state.status === 'connecting' || state.status === 'authenticating'}>
              <Icon size={12} />
            </Spin>
            <Text>{config.label}</Text>
          </View>
        </Badge>
      )}

      {detailed && state.status === 'connected' && (
        <>
          {state.deviceName ? <Text style={[s.detail, { color: tokens.mutedForeground }]}>{state.deviceName}</Text> : null}
          {state.latency != null ? <Text style={[s.detail, { color: tokens.mutedForeground }]}>{state.latency}ms</Text> : null}
        </>
      )}

      {detailed && state.error ? (
        <Text style={[s.error, { color: '#ff3344' }]} numberOfLines={1}>{state.error}</Text>
      ) : null}
    </View>
  )
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  badgeInner: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  detail: { fontSize: 12 },
  error: { fontSize: 12 },
})
