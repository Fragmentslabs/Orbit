import { useState, useCallback } from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { parseConnectionPayload, type ConnectionConfig } from '@orbit/companion-client'
import { Button } from '~/components/ui/button'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

interface QRScannerProps {
  onScanned: (config: Omit<ConnectionConfig, 'pin'> & { pin?: string }) => void
  disabled?: boolean
}

export function QRScanner({ onScanned, disabled }: QRScannerProps) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
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

  if (!permission) {
    return (
      <View style={s.center}>
        <Text style={[s.mutedFg, { color: tokens.mutedForeground }]}>Preparando câmera...</Text>
      </View>
    )
  }

  if (!permission.granted) {
    return (
      <View style={[s.center, { padding: 24 }]}>
        <Text style={[s.permTitle, { color: tokens.foreground }]}>Permissão de câmera necessária</Text>
        <Text style={[s.permDesc, { color: tokens.mutedForeground }]}>
          O Orbit precisa de acesso à câmera para escanear o QR code de conexão.
        </Text>
        <Button onPress={requestPermission}>Conceder Permissão</Button>
      </View>
    )
  }

  return (
    <View style={s.scannerContainer}>
      <CameraView
        style={{ flex: 1, minHeight: 300 }}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={scanned ? undefined : handleBarcodeScanned}
      >
        <View style={s.overlay}>
          <View style={s.scanFrame} />
          {scanned && (
            <View style={s.scannedBadge}>
              <Text style={s.scannedText}>QR code detectado!</Text>
            </View>
          )}
        </View>
      </CameraView>

      {scanned && (
        <View style={s.rescanOverlay}>
          <Pressable style={[s.rescanBtn, { backgroundColor: tokens.primary }]} onPress={() => setScanned(false)}>
            <Text style={[s.rescanText, { color: tokens.primaryForeground }]}>Escanar novamente</Text>
          </Pressable>
        </View>
      )}
    </View>
  )
}

const s = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  mutedFg: {},
  permTitle: { textAlign: 'center', fontSize: 18, fontWeight: '600' },
  permDesc: { textAlign: 'center', fontSize: 14 },

  scannerContainer: { overflow: 'hidden', borderRadius: 12 },
  overlay: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scanFrame: { width: 224, height: 224, borderRadius: 16, borderWidth: 2, borderColor: 'rgba(255,255,255,0.6)' },
  scannedBadge: { position: 'absolute', bottom: 32, borderRadius: 9999, backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 16, paddingVertical: 8 },
  scannedText: { fontSize: 14, color: '#fff' },

  rescanOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.3)' },
  rescanBtn: { borderRadius: 9999, paddingHorizontal: 24, paddingVertical: 12 },
  rescanText: { fontWeight: '500' },
})
