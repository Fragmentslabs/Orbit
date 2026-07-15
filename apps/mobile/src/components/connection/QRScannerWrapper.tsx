import React, { Suspense, useState, useEffect, useCallback } from 'react'
import { View, Text, Platform } from 'react-native'
import type { ConnectionConfig } from '@orbit/companion-client'
import { cn } from '~/lib/utils'
import { Button } from '~/components/ui/button'
import { Loader2 } from 'lucide-react-native'

interface Props {
  onScanned: (config: Omit<ConnectionConfig, 'pin'>) => void
  disabled?: boolean
  className?: string
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

export function QRScannerWrapper({ onScanned, disabled, className }: Props) {
  if (!canUseCamera || !QRScannerInner) {
    return (
      <View className={cn('flex-1 items-center justify-center gap-4 p-6', className)}>
        <Text className="text-center text-sm text-muted-foreground">
          QR Code disponível apenas em dispositivos móveis com câmera.
        </Text>
      </View>
    )
  }

  return (
    <Suspense
      fallback={
        <View className={cn('flex-1 items-center justify-center', className)}>
          <Loader2 size={24} className="animate-spin text-muted-foreground" />
        </View>
      }
    >
      <QRScannerInner onScanned={onScanned} disabled={disabled} className={className} />
    </Suspense>
  )
}
