import { useState, useCallback } from 'react'
import { View, Text, Pressable } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { parseConnectionPayload, type ConnectionConfig } from '@orbit/companion-client'
import { cn } from '~/lib/utils'
import { Button } from '~/components/ui/button'

interface QRScannerProps {
  /** Callback quando QR code é escaneado com sucesso. Retorna config (sem PIN). */
  onScanned: (config: Omit<ConnectionConfig, 'pin'>) => void
  /** Desabilita o scan (enquanto processa). */
  disabled?: boolean
  className?: string
}

export function QRScanner({ onScanned, disabled, className }: QRScannerProps) {
  const [permission, requestPermission] = useCameraPermissions()
  const [scanned, setScanned] = useState(false)

  const handleBarcodeScanned = useCallback(
    ({ data }: { data: string }) => {
      if (scanned || disabled) return

      const config = parseConnectionPayload(data)
      if (config) {
        setScanned(true)
        onScanned(config)
      }
    },
    [scanned, disabled, onScanned],
  )

  // Permissão não determinada — mostra request
  if (!permission) {
    return (
      <View className={cn('flex-1 items-center justify-center gap-4', className)}>
        <Text className="text-muted-foreground">Preparando câmera...</Text>
      </View>
    )
  }

  // Permissão negada — mostra botão para abrir configurações
  if (!permission.granted) {
    return (
      <View className={cn('flex-1 items-center justify-center gap-4 p-6', className)}>
        <Text className="text-center text-lg font-semibold text-foreground">
          Permissão de câmera necessária
        </Text>
        <Text className="text-center text-sm text-muted-foreground">
          O Orbit precisa de acesso à câmera para escanear o QR code de conexão.
        </Text>
        <Button onPress={requestPermission}>
          Conceder Permissão
        </Button>
      </View>
    )
  }

  // Câmera ativa — scan de QR code
  return (
    <View className={cn('overflow-hidden rounded-xl', className)}>
      <CameraView
        style={{ flex: 1, minHeight: 300 }}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={scanned ? undefined : handleBarcodeScanned}
      >
        {/* Overlay de scan */}
        <View className="flex-1 items-center justify-center">
          {/* Moldura de scan */}
          <View className="h-56 w-56 rounded-2xl border-2 border-white/60" />

          {scanned && (
            <View className="absolute bottom-8 rounded-full bg-black/60 px-4 py-2">
              <Text className="text-sm text-white">QR code detectado!</Text>
            </View>
          )}
        </View>
      </CameraView>

      {scanned && (
        <View className="absolute inset-0 items-center justify-center bg-black/30">
          <Pressable
            className="rounded-full bg-primary px-6 py-3"
            onPress={() => setScanned(false)}
          >
            <Text className="font-medium text-primary-foreground">Escanar novamente</Text>
          </Pressable>
        </View>
      )}
    </View>
  )
}
