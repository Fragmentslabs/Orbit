import { useState, useCallback, useEffect, useRef } from 'react'
import {
  View,
  Text,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  useWindowDimensions,
  StyleSheet,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ArrowRight, History, Loader2, Monitor, ScanLine, X } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { ConnectionConfig } from '@orbit/companion-client'
import * as Device from 'expo-device'
import { useConnectionStore } from '~/stores/connection-store'
import { useRecentConnectionsStore, type RecentConnection } from '~/stores/recent-connections-store'
import { useDesktopDiscovery } from '~/hooks/useDesktopDiscovery'
import { Button } from '~/components/ui/button'
import { Card } from '~/components/ui/card'
import { ConnectionStatus } from '~/components/connection/ConnectionStatus'
import { QRScannerWrapper } from '~/components/connection/QRScannerWrapper'
import { UrlAccordion } from '~/components/connection/UrlAccordion'
import { Persona, type PersonaState } from '~/components/ai/Persona'
import { Spin } from '~/components/ui/spin'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

const canUseCamera = Platform.OS === 'ios' || Platform.OS === 'android'

export default function ConnectionScreen() {
  const { t } = useTranslation()
  const { connection, config: savedConfig, disconnect, connect } = useConnectionStore()
  const { recent, loadRecent, removeRecent } = useRecentConnectionsStore()
  const { status: discoveryStatus, found } = useDesktopDiscovery()
  const [showQr, setShowQr] = useState(false)
  const [prefill, setPrefill] = useState<{ host: string; port: number } | undefined>(undefined)
  const { width } = useWindowDimensions()
  const isWide = width >= 768
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const isAutoReconnecting = !!savedConfig && connection.status !== 'disconnected' && !connection.error

  const personaState: PersonaState =
    connection.status === 'connected'
      ? 'speaking'
      : connection.status === 'connecting' || connection.status === 'authenticating'
        ? 'listening'
        : connection.error
          ? 'asleep'
          : 'idle'

  useEffect(() => { loadRecent() }, [loadRecent])

  const [reconnectDismissed, setReconnectDismissed] = useState(false)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (isAutoReconnecting && !reconnectDismissed) {
      reconnectTimer.current = setTimeout(() => {
        setReconnectDismissed(true)
      }, 8000)
    }
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
    }
  }, [isAutoReconnecting, reconnectDismissed])

  const handleCancelReconnect = useCallback(() => {
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
    setReconnectDismissed(true)
    disconnect()
  }, [disconnect])

  const findSavedToken = useCallback(
    (host: string) => recent.find((rc) => rc.host === host)?.token,
    [recent],
  )

  const handleQrScanned = useCallback((config: Omit<ConnectionConfig, 'pin'> & { pin?: string }) => {
    setShowQr(false)
    const token = findSavedToken(config.host)
    if (config.pin || token) {
      connect({
        host: config.host,
        port: config.port,
        pin: config.pin ?? '',
        token,
        deviceName: Device.deviceName ?? `Orbit ${Platform.OS}`,
      })
      return
    }
    setPrefill({ host: config.host, port: config.port })
  }, [connect, findSavedToken])

  const handlePrefill = useCallback((host: string, port: number, auth?: { pin?: string; token?: string }) => {
    const token = auth?.token ?? findSavedToken(host)
    if (auth?.pin || token) {
      connect({ host, port, pin: auth?.pin ?? '', token, deviceName: Device.deviceName ?? `Orbit ${Platform.OS}` })
      return
    }
    setPrefill({ host, port })
  }, [connect, findSavedToken])

  if (isAutoReconnecting && !reconnectDismissed) {
    return (
      <SafeAreaView style={[s.container, { backgroundColor: tokens.background }]}>
        <View style={s.reconnecting}>
          <Persona state="listening" size={120} />
          <View style={s.reconnectingText}>
            <Text style={[s.title, { color: tokens.foreground }]}>{t('connectionScreen.reconnecting')}</Text>
            <Text style={[s.mutedFg, { color: tokens.mutedForeground }]}>
              {savedConfig?.host}:{savedConfig?.port}
            </Text>
          </View>
          <ConnectionStatus state={connection} />
          <Button variant="outline" onPress={handleCancelReconnect}>
            {t('connectionScreen.cancel')}
          </Button>
        </View>
      </SafeAreaView>
    )
  }

  const header = (
    <View style={isWide ? s.headerWide : s.headerCenter}>
      <Persona state={personaState} size={isWide ? 160 : 140} />
      <View style={isWide ? { gap: 4 } : { alignItems: 'center', gap: 4 }}>
        <Text style={[s.titleLarge, { color: tokens.foreground }]}>{t('connectionScreen.appName')}</Text>
        <Text style={[s.subtitle, { color: tokens.mutedForeground }, !isWide && { textAlign: 'center' }]}>
          {t('connectionScreen.subtitle')}
        </Text>
      </View>
    </View>
  )

  const facilitator =
    discoveryStatus === 'found' && found ? (
      <Pressable
        onPress={() => handlePrefill(found.host, found.wsPort, { pin: found.pin })}
        style={[s.facilitatorCard, { borderColor: 'rgba(245,166,35,0.3)', backgroundColor: 'rgba(245,166,35,0.1)' }]}
      >
        <View style={[s.facilitatorIcon, { backgroundColor: 'rgba(245,166,35,0.15)' }]}>
          <Monitor size={18} color={tokens.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[s.fgSemibold, { color: tokens.foreground }]}>
            {t('connectionScreen.desktopFound', { name: found.name ? ` — ${found.name}` : '' })}
          </Text>
          <Text style={[s.mutedFg, { color: tokens.mutedForeground }]}>{found.host}:{found.wsPort} · {t('connectionScreen.tapToConnect')}</Text>
        </View>
        <ArrowRight size={16} color={tokens.primary} />
      </Pressable>
    ) : discoveryStatus === 'checking' ? (
      <View style={s.checkingRow}>
        <Spin><Loader2 size={12} color={tokens.mutedForeground} /></Spin>
        <Text style={[s.mutedFg, { color: tokens.mutedForeground }]}>{t('connectionScreen.searchingNetwork')}</Text>
      </View>
    ) : null

  const recents =
    recent.length > 0 ? (
      <View style={{ gap: 8 }}>
        <View style={s.recentsHeader}>
          <History size={13} color={tokens.mutedForeground} />
          <Text style={[s.recentsTitle, { color: tokens.mutedForeground }]}>{t('connectionScreen.recent')}</Text>
        </View>
        {recent.map((rc: RecentConnection) => (
          <Pressable
            key={`${rc.host}:${rc.port}`}
            onPress={() => handlePrefill(rc.host, rc.port, { token: rc.token, pin: rc.pin })}
            style={[s.recentCard, { borderColor: '#1f2128', backgroundColor: '#111318' }]}
          >
            <View style={[s.recentIcon, { backgroundColor: '#1a1c22' }]}>
              <Monitor size={16} color={tokens.mutedForeground} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[s.fg, { color: tokens.foreground }]}>{rc.deviceName ?? rc.host}</Text>
              <Text style={[s.mutedFg, { color: tokens.mutedForeground }]}>{rc.host}:{rc.port}</Text>
            </View>
            <Pressable
              onPress={() => void removeRecent(rc.host, rc.port)}
              hitSlop={8}
              style={s.removeBtn}
            >
              <X size={14} color={tokens.mutedForeground} />
            </Pressable>
          </Pressable>
        ))}
      </View>
    ) : null

  const qrButton = canUseCamera ? (
    showQr ? (
      <Card style={{ overflow: 'hidden', padding: 12 }}>
        <View style={s.qrHeader}>
          <Text style={[s.fg, { color: tokens.foreground }]}>{t('connectionScreen.scanQrCode')}</Text>
          <Button variant="ghost" size="sm" onPress={() => setShowQr(false)}>{t('connectionScreen.cancel')}</Button>
        </View>
        <View style={[s.qrCamera, { backgroundColor: '#000' }]}>
          <QRScannerWrapper onScanned={handleQrScanned} />
        </View>
      </Card>
    ) : (
      <Button onPress={() => setShowQr(true)} size="lg">
        <ScanLine size={18} color="#4a2e0a" /> {t('connectionScreen.scanQrCode')}
      </Button>
    )
  ) : null

  const manualConnect = <UrlAccordion prefill={prefill} defaultExpanded={isWide} />

  const statusAndHint = (
    <>
      <ConnectionStatus state={connection} detailed />
      <View style={[s.tipBox, { backgroundColor: 'rgba(26,28,34,0.5)' }]}>
        <Text style={[s.tipText, { color: tokens.mutedForeground }]}>
          <Text style={{ fontWeight: '600' }}>{t('connectionScreen.tipLabel')}</Text> {t('connectionScreen.tipText')}
        </Text>
      </View>
    </>
  )

  return (
    <SafeAreaView style={[s.container, { backgroundColor: tokens.background }]} edges={['top']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ flexGrow: 1, paddingBottom: 40 }}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
        >
          {isWide ? (
            <View style={s.wideContainer}>
              <View style={s.wideRow}>
                <View style={s.wideCol}>
                  {header}
                  {facilitator}
                  {recents}
                </View>
                <View style={s.wideCol}>
                  {manualConnect}
                  {qrButton}
                  {statusAndHint}
                </View>
              </View>
            </View>
          ) : (
            <View style={s.mobileContainer}>
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

const s = StyleSheet.create({
  container: { flex: 1 },
  reconnecting: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 20, paddingHorizontal: 24 },
  reconnectingText: { alignItems: 'center', gap: 4 },
  title: { fontSize: 18, fontWeight: '600' },
  titleLarge: { fontSize: 24, fontWeight: 'bold' },

  headerWide: { alignItems: 'flex-start', gap: 16 },
  headerCenter: { alignItems: 'center', gap: 16 },
  subtitle: { fontSize: 14, lineHeight: 20 },

  facilitatorCard: { width: '100%', flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 12, borderWidth: 1, paddingHorizontal: 16, paddingVertical: 14 },
  facilitatorIcon: { width: 40, height: 40, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },

  checkingRow: { width: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 8 },

  recentsHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  recentsTitle: { fontSize: 12, fontWeight: '500', textTransform: 'uppercase', letterSpacing: 0.5 },
  recentCard: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 12, borderWidth: 1, paddingHorizontal: 16, paddingVertical: 12 },
  recentIcon: { width: 36, height: 36, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  removeBtn: { width: 28, height: 28, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },

  qrHeader: { marginBottom: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  qrCamera: { height: 256, overflow: 'hidden', borderRadius: 8 },

  tipBox: { borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12 },
  tipText: { fontSize: 12, lineHeight: 20 },

  fg: { fontSize: 14, fontWeight: '500' },
  fgSemibold: { fontSize: 14, fontWeight: '600' },
  mutedFg: { fontSize: 12 },

  wideContainer: { flex: 1, justifyContent: 'center', paddingHorizontal: 32 },
  wideRow: { maxWidth: 896, alignSelf: 'center', width: '100%', flexDirection: 'row', gap: 48 },
  wideCol: { flex: 1, gap: 24 },
  mobileContainer: { flex: 1, gap: 24, paddingHorizontal: 20, paddingTop: 40 },
})
