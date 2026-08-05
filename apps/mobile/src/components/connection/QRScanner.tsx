import { useState, useCallback } from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { parseConnectionPayload, type ConnectionConfig } from '@orbit/companion-client'
import { useTranslation } from 'react-i18next'
import { Button } from '~/components/ui/button'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

interface QRScannerProps {
  onScanned: (config: Omit<ConnectionConfig, 'pin'> & { pin?: string }) => void
  disabled?: boolean
}

export function QRScanner({ onScanned, disabled }: QRScannerProps) {
  const { t } = useTranslation()
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
        <Text style={[s.mutedFg, { color: 'rgba(255,255,255,0.75)' }]}>{t('qrScanner.preparingCamera')}</Text>
      </View>
    )
  }

  if (!permission.granted) {
    return (
      <View style={[s.center, { padding: 24 }]}>
        <Text style={s.permTitle}>{t('qrScanner.permissionRequiredTitle')}</Text>
        <Text style={s.permDesc}>
          {t('qrScanner.permissionRequiredDesc')}
        </Text>
        <Button onPress={requestPermission}>{t('qrScanner.grantPermission')}</Button>
      </View>
    )
  }

  return (
    <View style={s.scannerContainer}>
      <CameraView
        style={{ flex: 1 }}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={scanned ? undefined : handleBarcodeScanned}
      >
        <View style={s.overlay}>
          <View style={s.scanFrame} />
          {scanned && (
            <View style={s.scannedBadge}>
              <Text style={s.scannedText}>{t('qrScanner.detected')}</Text>
            </View>
          )}
        </View>
      </CameraView>

      {scanned && (
        <View style={s.rescanOverlay}>
          <Pressable style={[s.rescanBtn, { backgroundColor: tokens.primary }]} onPress={() => setScanned(false)}>
            <Text style={[s.rescanText, { color: tokens.primaryForeground }]}>{t('qrScanner.scanAgain')}</Text>
          </Pressable>
        </View>
      )}
    </View>
  )
}

const s = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  mutedFg: {},
  permTitle: { textAlign: 'center', fontSize: 18, fontWeight: '600', color: '#fff' },
  permDesc: { textAlign: 'center', fontSize: 14, color: 'rgba(255,255,255,0.75)' },

  scannerContainer: { flex: 1 },
  overlay: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scanFrame: { width: 240, height: 240, borderRadius: 16, borderWidth: 2, borderColor: 'rgba(255,255,255,0.6)' },
  scannedBadge: { position: 'absolute', bottom: 32, borderRadius: 9999, backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 16, paddingVertical: 8 },
  scannedText: { fontSize: 14, color: '#fff' },

  rescanOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.3)' },
  rescanBtn: { borderRadius: 9999, paddingHorizontal: 24, paddingVertical: 12 },
  rescanText: { fontWeight: '500' },
})
