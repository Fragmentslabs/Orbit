import { useState, useCallback, useEffect } from 'react'
import { View, Text, ScrollView, KeyboardAvoidingView, Platform } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { QrCode, Keyboard, Wifi, Loader2 } from 'lucide-react-native'
import { parseConnectionPayload, isValidPin, type ConnectionConfig } from '@orbit/companion-client'
import { useConnectionStore } from '~/stores/connection-store'
import { cn } from '~/lib/utils'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '~/components/ui/card'
import { PinInput } from '~/components/connection/PinInput'
import { QRScanner } from '~/components/connection/QRScanner'
import { ConnectionStatus } from '~/components/connection/ConnectionStatus'

type ScreenMode = 'menu' | 'qr-scan' | 'manual-ip' | 'pin-entry'

export default function ConnectionScreen() {
  const { connection, connect, config: savedConfig } = useConnectionStore()
  const [mode, setMode] = useState<ScreenMode>('menu')
  const [ip, setIp] = useState('')
  const [port, setPort] = useState('3847')
  const [pendingConfig, setPendingConfig] = useState<Omit<ConnectionConfig, 'pin'> | null>(null)
  const [pinError, setPinError] = useState('')

  // Se já tem config salva e está conectando, mostrar loading
  const isAutoReconnecting = savedConfig && connection.status !== 'disconnected'

  const handleQrScanned = useCallback((config: Omit<ConnectionConfig, 'pin'>) => {
    setPendingConfig(config)
    setMode('pin-entry')
  }, [])

  const handleManualConnect = useCallback(() => {
    const host = ip.trim()
    const portNum = parseInt(port, 10)

    if (!host) return
    if (!portNum || portNum < 1 || portNum > 65535) return

    setPendingConfig({ host, port: portNum })
    setMode('pin-entry')
  }, [ip, port])

  const handlePinComplete = useCallback(
    (pin: string) => {
      if (!pendingConfig) return

      setPinError('')
      connect({
        ...pendingConfig,
        pin,
      })
    },
    [pendingConfig, connect],
  )

  const handleBack = useCallback(() => {
    setMode('menu')
    setPendingConfig(null)
    setPinError('')
  }, [])

  // Mostra loading se auto-reconectando
  if (isAutoReconnecting) {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center gap-4 px-6">
          <Loader2 size={32} className="animate-spin text-primary" />
          <Text className="text-lg font-semibold text-foreground">
            Reconectando...
          </Text>
          <Text className="text-sm text-muted-foreground">
            {savedConfig?.host}:{savedConfig?.port}
          </Text>
          <ConnectionStatus state={connection} />
        </View>
      </SafeAreaView>
    )
  }

  // ─── QR Code Scanning ──────────────────────────────────────────────────

  if (mode === 'qr-scan') {
    return (
      <SafeAreaView className="flex-1 bg-background" edges={['top']}>
        <View className="flex-1">
          <View className="flex-row items-center justify-between px-4 py-3">
            <Button variant="ghost" onPress={handleBack}>
              Cancelar
            </Button>
            <Text className="text-sm font-medium text-foreground">
              Escanear QR Code
            </Text>
            <View className="w-16" />
          </View>

          <QRScanner
            onScanned={handleQrScanned}
            className="mx-4 flex-1"
          />

          <View className="p-6">
            <Text className="text-center text-xs text-muted-foreground">
              Aponte a câmera para o QR code exibido no Orbit Desktop
            </Text>
          </View>
        </View>
      </SafeAreaView>
    )
  }

  // ─── Manual IP Entry ───────────────────────────────────────────────────

  if (mode === 'manual-ip') {
    return (
      <SafeAreaView className="flex-1 bg-background" edges={['top']}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          className="flex-1"
        >
          <ScrollView className="flex-1" contentContainerStyle={{ flexGrow: 1 }}>
            <View className="flex-row items-center px-4 py-3">
              <Button variant="ghost" onPress={handleBack}>
                Voltar
              </Button>
            </View>

            <View className="flex-1 justify-center px-6">
              <View className="gap-6">
                <View className="gap-2">
                  <Text className="text-lg font-semibold text-foreground">
                    Conectar manualmente
                  </Text>
                  <Text className="text-sm text-muted-foreground">
                    Informe o endereço IP e porta do desktop Orbit.
                    {'\n\n'}
                    Use este método quando estiver em outra rede (ex: Tailscale).
                  </Text>
                </View>

                <View className="gap-3">
                  <View className="gap-1.5">
                    <Text className="text-sm font-medium text-foreground">Endereço IP</Text>
                    <Input
                      placeholder="192.168.1.100"
                      value={ip}
                      onChangeText={setIp}
                      keyboardType="decimal-pad"
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                  </View>

                  <View className="gap-1.5">
                    <Text className="text-sm font-medium text-foreground">Porta</Text>
                    <Input
                      placeholder="3847"
                      value={port}
                      onChangeText={setPort}
                      keyboardType="number-pad"
                    />
                  </View>
                </View>

                <Button
                  onPress={handleManualConnect}
                  disabled={!ip.trim() || !port}
                  className="w-full"
                >
                  Continuar
                </Button>
              </View>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    )
  }

  // ─── PIN Entry ─────────────────────────────────────────────────────────

  if (mode === 'pin-entry') {
    return (
      <SafeAreaView className="flex-1 bg-background" edges={['top']}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          className="flex-1"
        >
          <ScrollView className="flex-1" contentContainerStyle={{ flexGrow: 1 }}>
            <View className="flex-row items-center px-4 py-3">
              <Button variant="ghost" onPress={handleBack}>
                Voltar
              </Button>
            </View>

            <View className="flex-1 justify-center px-6">
              <View className="gap-6">
                <View className="items-center gap-2">
                  <View className="h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                    <Wifi size={24} className="text-primary" />
                  </View>
                  <Text className="text-lg font-semibold text-foreground">
                    Digite o PIN
                  </Text>
                  <Text className="text-center text-sm text-muted-foreground">
                    Insira o PIN de 6 dígitos exibido no Orbit Desktop
                  </Text>
                  {pendingConfig && (
                    <Text className="text-xs text-muted-foreground">
                      {pendingConfig.host}:{pendingConfig.port}
                    </Text>
                  )}
                </View>

                <View className="items-center gap-4">
                  <PinInput
                    onComplete={handlePinComplete}
                    disabled={connection.status === 'connecting' || connection.status === 'authenticating'}
                    error={pinError}
                  />

                  {(connection.status === 'connecting' || connection.status === 'authenticating') && (
                    <View className="flex-row items-center gap-2">
                      <Loader2 size={14} className="animate-spin text-primary" />
                      <Text className="text-sm text-muted-foreground">
                        Conectando...
                      </Text>
                    </View>
                  )}

                  {connection.error && (
                    <Text className="text-sm text-destructive">
                      {connection.error}
                    </Text>
                  )}
                </View>
              </View>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    )
  }

  // ─── Menu Principal ────────────────────────────────────────────────────

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <ScrollView className="flex-1" contentContainerStyle={{ flexGrow: 1 }}>
        <View className="flex-1 justify-center px-6 py-12">
          <View className="gap-8">
            {/* Header */}
            <View className="items-center gap-3">
              <View className="h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
                <Text className="text-2xl font-bold text-primary">Ω</Text>
              </View>
              <View className="gap-1">
                <Text className="text-center text-2xl font-bold text-foreground">
                  Orbit Mobile
                </Text>
                <Text className="text-center text-sm text-muted-foreground">
                  Conecte-se ao seu Orbit Desktop
                </Text>
              </View>
            </View>

            {/* Opções de conexão */}
            <View className="gap-3">
              {/* QR Code */}
              <Card>
                <CardHeader>
                  <View className="flex-row items-center gap-3">
                    <View className="h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                      <QrCode size={20} className="text-primary" />
                    </View>
                    <View className="flex-1">
                      <CardTitle>Escanear QR Code</CardTitle>
                      <CardDescription>
                        A forma mais rápida de conectar
                      </CardDescription>
                    </View>
                  </View>
                </CardHeader>
                <CardContent>
                  <Button
                    onPress={() => setMode('qr-scan')}
                    className="w-full"
                  >
                    Abrir Câmera
                  </Button>
                </CardContent>
              </Card>

              {/* IP Manual */}
              <Card>
                <CardHeader>
                  <View className="flex-row items-center gap-3">
                    <View className="h-10 w-10 items-center justify-center rounded-lg bg-secondary/50">
                      <Keyboard size={20} className="text-secondary-foreground" />
                    </View>
                    <View className="flex-1">
                      <CardTitle>Inserir Endereço</CardTitle>
                      <CardDescription>
                        Para redes remotas ou Tailscale
                      </CardDescription>
                    </View>
                  </View>
                </CardHeader>
                <CardContent>
                  <Button
                    variant="outline"
                    onPress={() => setMode('manual-ip')}
                    className="w-full"
                  >
                    Conectar Manualmente
                  </Button>
                </CardContent>
              </Card>
            </View>

            {/* Dica Tailscale */}
            <View className="rounded-lg bg-muted/50 p-4">
              <Text className="text-center text-xs leading-5 text-muted-foreground">
                💡 <Text className="font-semibold">Dica:</Text> Use{' '}
                <Text className="font-semibold">Tailscale</Text> para acessar
                seu desktop de qualquer lugar, sem configuração de rede.
              </Text>
            </View>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}
