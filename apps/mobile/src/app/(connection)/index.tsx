import { useState, useCallback, useEffect } from 'react'
import {
  View,
  Text,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  useWindowDimensions,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ArrowRight, History, Loader2, Monitor, ScanLine, X } from 'lucide-react-native'
import type { ConnectionConfig } from '@orbit/companion-client'
import { useConnectionStore } from '~/stores/connection-store'
import { useRecentConnectionsStore, type RecentConnection } from '~/stores/recent-connections-store'
import { useDesktopDiscovery } from '~/hooks/useDesktopDiscovery'
import { Button } from '~/components/ui/button'
import { Card } from '~/components/ui/card'
import { ConnectionStatus } from '~/components/connection/ConnectionStatus'
import { QRScannerWrapper } from '~/components/connection/QRScannerWrapper'
import { UrlAccordion } from '~/components/connection/UrlAccordion'
import { Persona, type PersonaState } from '~/components/ai/Persona'

const canUseCamera = Platform.OS === 'ios' || Platform.OS === 'android'

export default function ConnectionScreen() {
  const { connection, config: savedConfig, disconnect } = useConnectionStore()
  const { recent, loadRecent, removeRecent } = useRecentConnectionsStore()
  const { status: discoveryStatus, found } = useDesktopDiscovery()
  const [showQr, setShowQr] = useState(false)
  const [prefill, setPrefill] = useState<{ host: string; port: number } | undefined>(undefined)
  const { width } = useWindowDimensions()
  const isWide = width >= 768

  const isAutoReconnecting = !!savedConfig && connection.status !== 'disconnected'

  const personaState: PersonaState =
    connection.status === 'connected'
      ? 'speaking'
      : connection.status === 'connecting' || connection.status === 'authenticating'
        ? 'listening'
        : connection.error
          ? 'asleep'
          : 'idle'

  useEffect(() => { loadRecent() }, [loadRecent])

  const handleQrScanned = useCallback((config: Omit<ConnectionConfig, 'pin'>) => {
    setPrefill({ host: config.host, port: config.port })
    setShowQr(false)
  }, [])

  const handlePrefill = useCallback((host: string, port: number) => {
    setPrefill({ host, port })
  }, [])

  // ─── Reconectando (config salva) ───────────────────────────────────────

  if (isAutoReconnecting) {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center gap-5 px-6">
          <Persona state="listening" size={120} />
          <View className="items-center gap-1">
            <Text className="text-lg font-semibold text-foreground">Reconectando</Text>
            <Text className="text-sm text-muted-foreground">
              {savedConfig?.host}:{savedConfig?.port}
            </Text>
          </View>
          <ConnectionStatus state={connection} />
          <Button variant="outline" onPress={disconnect}>
            Cancelar
          </Button>
        </View>
      </SafeAreaView>
    )
  }

  // ─── Blocos reutilizados entre os layouts ──────────────────────────────

  const header = (
    <View className={isWide ? 'items-start gap-4' : 'items-center gap-4'}>
      <Persona state={personaState} size={isWide ? 160 : 140} />
      <View className={isWide ? 'gap-1' : 'items-center gap-1'}>
        <Text className="text-2xl font-bold text-foreground">Orbit</Text>
        <Text className={`text-sm text-muted-foreground ${isWide ? '' : 'text-center'}`}>
          Conecte-se ao Orbit Desktop para{'\n'}acompanhar e controlar suas sessões
        </Text>
      </View>
    </View>
  )

  const facilitator =
    discoveryStatus === 'found' && found ? (
      <Pressable
        onPress={() => handlePrefill(found.host, found.wsPort)}
        className="w-full flex-row items-center gap-3 rounded-xl border border-primary/30 bg-primary/10 px-4 py-3.5 active:bg-primary/15"
      >
        <View className="h-10 w-10 items-center justify-center rounded-md bg-primary/15">
          <Monitor size={18} className="text-primary" />
        </View>
        <View className="flex-1">
          <Text className="text-sm font-semibold text-foreground">
            Desktop encontrado{found.name ? ` — ${found.name}` : ''}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {found.host}:{found.wsPort} · toque para conectar
          </Text>
        </View>
        <ArrowRight size={16} className="text-primary" />
      </Pressable>
    ) : discoveryStatus === 'checking' ? (
      <View className="w-full flex-row items-center justify-center gap-2 py-2">
        <Loader2 size={12} className="animate-spin text-muted-foreground" />
        <Text className="text-xs text-muted-foreground">Procurando Orbit Desktop na rede…</Text>
      </View>
    ) : null

  const recents =
    recent.length > 0 ? (
      <View className="w-full gap-2">
        <View className="flex-row items-center gap-2 px-1">
          <History size={13} className="text-muted-foreground" />
          <Text className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Recentes
          </Text>
        </View>
        {recent.map((rc: RecentConnection) => (
          <Pressable
            key={`${rc.host}:${rc.port}`}
            onPress={() => handlePrefill(rc.host, rc.port)}
            className="flex-row items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 active:bg-accent"
          >
            <View className="h-9 w-9 items-center justify-center rounded-md bg-secondary">
              <Monitor size={16} className="text-muted-foreground" />
            </View>
            <View className="flex-1">
              <Text className="text-sm font-medium text-foreground">
                {rc.deviceName ?? rc.host}
              </Text>
              <Text className="text-xs text-muted-foreground">
                {rc.host}:{rc.port}
              </Text>
            </View>
            <Pressable
              onPress={() => void removeRecent(rc.host, rc.port)}
              hitSlop={8}
              className="h-7 w-7 items-center justify-center rounded-md active:bg-muted"
            >
              <X size={14} className="text-muted-foreground" />
            </Pressable>
          </Pressable>
        ))}
      </View>
    ) : null

  const qrButton = canUseCamera ? (
    showQr ? (
      <Card className="overflow-hidden p-3">
        <View className="mb-2 flex-row items-center justify-between">
          <Text className="text-sm font-medium text-foreground">Escanear QR Code</Text>
          <Button variant="ghost" size="sm" onPress={() => setShowQr(false)}>
            Cancelar
          </Button>
        </View>
        <View className="h-64 overflow-hidden rounded-lg bg-black">
          <QRScannerWrapper onScanned={handleQrScanned} />
        </View>
      </Card>
    ) : (
      <Button onPress={() => setShowQr(true)} size="lg" className="w-full flex-row gap-2">
        <ScanLine size={18} className="text-primary-foreground" />
        Escanear QR Code
      </Button>
    )
  ) : null

  const manualConnect = (
    <UrlAccordion prefill={prefill} defaultExpanded={isWide} />
  )

  const statusAndHint = (
    <>
      <ConnectionStatus state={connection} detailed />
      <View className="rounded-xl bg-muted/50 px-4 py-3">
        <Text className="text-xs leading-5 text-muted-foreground">
          <Text className="font-semibold">Dica:</Text> use{' '}
          <Text className="font-semibold">Tailscale</Text> para acessar seu desktop de
          qualquer lugar, sem configurar a rede.
        </Text>
      </View>
    </>
  )

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1"
      >
        <ScrollView
          className="flex-1"
          contentContainerStyle={{ flexGrow: 1, paddingBottom: 40 }}
          keyboardShouldPersistTaps="handled"
        >
          {isWide ? (
            // ─── Web / telas largas: duas colunas centralizadas ─────────
            <View className="flex-1 justify-center px-8 lg:px-16">
              <View className="mx-auto w-full max-w-4xl flex-row gap-12">
                <View className="flex-1 gap-6">
                  {header}
                  {facilitator}
                  {recents}
                </View>
                <View className="flex-1 gap-4">
                  {manualConnect}
                  {qrButton}
                  {statusAndHint}
                </View>
              </View>
            </View>
          ) : (
            // ─── Mobile: coluna única, persona no centro ────────────────
            <View className="flex-1 gap-6 px-5 pt-10">
              {header}
              {facilitator}
              {qrButton}
              {manualConnect}
              {recents}
              {statusAndHint}
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}
