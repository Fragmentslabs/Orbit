import { View, Text, ScrollView, Pressable } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useEffect, useState } from 'react'
import { useRouter } from 'expo-router'
import {
  Cpu,
  Shield,
  Brain,
  LogOut,
  Wifi,
  Monitor,
  ChevronRight,
  RefreshCw,
} from 'lucide-react-native'
import { useConnectionStore } from '~/stores/connection-store'
import { useSettingsStore } from '~/stores/settings-store'
import { AppHeader } from '~/components/layout/AppHeader'
import { ConnectionStatus } from '~/components/connection/ConnectionStatus'
import { Badge } from '~/components/ui/badge'
import { cn } from '~/lib/utils'

function SettingsRow({
  icon: Icon,
  label,
  value,
  onPress,
  destructive,
}: {
  icon: typeof Cpu
  label: string
  value?: string
  onPress?: () => void
  destructive?: boolean
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      className={cn(
        'flex-row items-center gap-3 px-4 py-3.5 border-b border-border',
        onPress && 'active:bg-accent',
      )}
    >
      <Icon size={18} className={destructive ? 'text-destructive' : 'text-muted-foreground'} />
      <View className="flex-1">
        <Text className={cn('text-sm', destructive ? 'text-destructive' : 'text-foreground')}>
          {label}
        </Text>
      </View>
      {value && (
        <Text className="text-xs text-muted-foreground mr-1" numberOfLines={1}>
          {value}
        </Text>
      )}
      {onPress && <ChevronRight size={14} className="text-muted-foreground" />}
    </Pressable>
  )
}

export default function SettingsScreen() {
  const router = useRouter()
  const connection = useConnectionStore((s) => s.connection)
  const config = useConnectionStore((s) => s.config)
  const disconnect = useConnectionStore((s) => s.disconnect)
  const clearSavedConfig = useConnectionStore((s) => s.clearSavedConfig)
  const selectedModel = useSettingsStore((s) => s.selectedModel)
  const preferences = useSettingsStore((s) => s.preferences)
  const fetchCatalog = useSettingsStore((s) => s.fetchCatalog)
  const fetchPreferences = useSettingsStore((s) => s.fetchPreferences)
  const fetchSelectedModel = useSettingsStore((s) => s.fetchSelectedModel)
  const loading = useSettingsStore((s) => s.loading)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    fetchCatalog()
    fetchPreferences()
    fetchSelectedModel()
  }, [])

  const handleRefresh = async () => {
    setRefreshing(true)
    await Promise.all([fetchCatalog(), fetchPreferences(), fetchSelectedModel()])
    setRefreshing(false)
  }

  const handleDisconnect = async () => {
    disconnect()
    await clearSavedConfig()
    router.replace('/(connection)')
  }

  const modelLabel = selectedModel
    ? `${selectedModel.providerId}/${selectedModel.modelId}`
    : 'Não definido'

  const permissionMode = (preferences as any)?.permissionMode ?? 'prompt'

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <AppHeader
        title="Configurações"
        rightAction={
          <Pressable onPress={handleRefresh} disabled={loading}>
            <RefreshCw
              size={18}
              className={cn('text-muted-foreground', loading && 'animate-spin')}
            />
          </Pressable>
        }
      />

      <ScrollView className="flex-1">
        {/* Connection Section */}
        <Text className="px-4 pt-4 pb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Conexão
        </Text>
        <View className="mx-4 rounded-lg border border-border bg-card overflow-hidden">
          <SettingsRow
            icon={Wifi}
            label="Status"
            value={connection.status === 'connected' ? 'Conectado' : 'Desconectado'}
          />
          <SettingsRow
            icon={Monitor}
            label="Desktop"
            value={config?.deviceName ?? config?.host ?? '—'}
          />
          <SettingsRow
            icon={LogOut}
            label="Desconectar"
            destructive
            onPress={handleDisconnect}
          />
        </View>

        {/* Model Section */}
        <Text className="px-4 pt-6 pb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Modelo
        </Text>
        <View className="mx-4 rounded-lg border border-border bg-card overflow-hidden">
          <SettingsRow
            icon={Cpu}
            label="Modelo ativo"
            value={modelLabel}
          />
        </View>

        {/* Preferences Section */}
        <Text className="px-4 pt-6 pb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Preferências
        </Text>
        <View className="mx-4 rounded-lg border border-border bg-card overflow-hidden">
          <SettingsRow
            icon={Shield}
            label="Modo de permissão"
            value={permissionMode}
          />
          <SettingsRow
            icon={Brain}
            label="Raciocínio"
            value={(preferences as any)?.reasoning ? 'Ativado' : 'Desativado'}
          />
        </View>

        {/* App Info */}
        <View className="items-center py-8">
          <Text className="text-xs text-muted-foreground">Orbit Mobile v1.0.0</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}
