import React, { Suspense, useState, useEffect, useCallback } from 'react'
import { View, Text, Platform, StyleSheet } from 'react-native'
import type { ConnectionConfig } from '@orbit/companion-client'
import { Spin } from '~/components/ui/spin'
import { Loader2 } from 'lucide-react-native'
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
    QRScannerInner = require('./QRScanner').QRScanner
  }
} catch {
  QRScannerInner = null
}

export function QRScannerWrapper({ onScanned, disabled }: Props) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  if (!canUseCamera || !QRScannerInner) {
    return (
      <View style={s.fallback}>
        <Text style={[s.fallbackText, { color: tokens.mutedForeground }]}>
          QR Code disponível apenas em dispositivos móveis com câmera.
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
