import React, { Suspense } from 'react'
import { View, Text, Platform, StyleSheet } from 'react-native'
import type { ConnectionConfig } from '@orbit/companion-client'
import { Spin } from '~/components/ui/spin'
import { Loader2 } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

interface Props {
  onScanned: (config: Omit<ConnectionConfig, 'pin'> & { pin?: string }) => void
  disabled?: boolean
}

const canUseCamera = Platform.OS === 'ios' || Platform.OS === 'android'

let QRScannerInner: React.ComponentType<Props> | null = null

try {
  if (canUseCamera) {
    // Conditional loading of an optional module: a static import does not
    // work here (the module may not exist at runtime — Expo Go, web,
    // build without the native part) and that is exactly why the require is
    // inside the try/if.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    QRScannerInner = require('./QRScanner').QRScanner
  }
} catch {
  QRScannerInner = null
}

export function QRScannerWrapper({ onScanned, disabled }: Props) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  if (!canUseCamera || !QRScannerInner) {
    return (
      <View style={s.fallback}>
        <Text style={[s.fallbackText, { color: tokens.mutedForeground }]}>
          {t('qrScanner.webFallback')}
        </Text>
      </View>
    )
  }

  return (
    <Suspense
      fallback={
        <View style={s.loading}>
          <Spin><Loader2 size={24} color={tokens.mutedForeground} /></Spin>
        </View>
      }
    >
      <QRScannerInner onScanned={onScanned} disabled={disabled} />
    </Suspense>
  )
}

const s = StyleSheet.create({
  fallback: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  fallbackText: { textAlign: 'center', fontSize: 14 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
})
