import { useState, useCallback, useEffect, useRef } from 'react'
import {
  View,
  Text,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
} from 'react-native'
import { ArrowRight, Globe, Loader2, Monitor, ScanLine } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { ConnectionConfig } from '@orbit/companion-client'
import * as Device from 'expo-device'
import { useConnectionStore } from '~/stores/connection-store'
import { useRecentConnectionsStore } from '~/stores/recent-connections-store'
import { useDesktopDiscovery } from '~/hooks/useDesktopDiscovery'
import { Button } from '~/components/ui/button'
import { ConnectionStatus } from '~/components/connection/ConnectionStatus'
import { ManualConnectSheet } from '~/components/connection/ManualConnectSheet'
import { QRScannerModal } from '~/components/connection/QRScannerModal'
import { Persona, type PersonaState } from '~/components/ai/Persona'
import { Spin } from '~/components/ui/spin'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { SafeScreen } from '~/components/layout/SafeScreen'

const canUseCamera = Platform.OS === 'ios' || Platform.OS === 'android'

export default function ConnectionScreen() {
  const { t } = useTranslation()
  const { connection, config: savedConfig, disconnect, connect } = useConnectionStore()
  const { recent, loadRecent } = useRecentConnectionsStore()
  const { status: discoveryStatus, found } = useDesktopDiscovery()
  const [qrOpen, setQrOpen] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const [prefill, setPrefill] = useState<{ host: string; port: number } | undefined>(undefined)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const isAutoReconnecting = !!savedConfig && connection.status !== 'disconnected' && !connection.error

  // Ao entrar na tela o persona começa dormindo e acorda depois de um instante,
  // tocando a transição sleep → normal (espelho do fluxo do desktop). Só depois
  // disso ele assume o estado derivado da conexão.
  const [personaAwake, setPersonaAwake] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setPersonaAwake(true), 700)
    return () => clearTimeout(t)
  }, [])

  const personaState: PersonaState = personaAwake
    ? connection.status === 'connected'
      ? 'speaking'
      : connection.status === 'connecting' || connection.status === 'authenticating'
        ? 'listening'
        : 'idle'
    : 'asleep'

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

  const connectWith = useCallback((host: string, port: number, pin?: string, token?: string) => {
    connect({
      host,
      port,
      pin: pin ?? '',
      token,
      deviceName: Device.deviceName ?? `Orbit ${Platform.OS}`,
    })
  }, [connect])

  const handleQrScanned = useCallback((config: Omit<ConnectionConfig, 'pin'> & { pin?: string }) => {
    setQrOpen(false)
    const token = findSavedToken(config.host)
    if (config.pin || token) {
      connectWith(config.host, config.port, config.pin, token)
      return
    }
    setPrefill({ host: config.host, port: config.port })
    setManualOpen(true)
  }, [connectWith, findSavedToken])

  const handleFacilitatorConnect = useCallback(() => {
    if (!found) return
    const token = findSavedToken(found.host)
    if (found.pin || token) {
      connectWith(found.host, found.wsPort, found.pin, token)
      return
    }
    setPrefill({ host: found.host, port: found.wsPort })
    setManualOpen(true)
  }, [found, connectWith, findSavedToken])

  const closeManual = useCallback(() => {
    setManualOpen(false)
    setPrefill(undefined)
  }, [])

  if (isAutoReconnecting && !reconnectDismissed) {
    return (
      <SafeScreen style={s.container} edges={['top', 'right', 'bottom', 'left']}>
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
      </SafeScreen>
    )
  }

  const header = (
    <View style={s.header}>
      <Persona state={personaState} size={140} />
      <View style={{ alignItems: 'center', gap: 4 }}>
        <Text style={[s.titleLarge, { color: tokens.foreground }]}>{t('connectionScreen.appName')}</Text>
        <Text style={[s.subtitle, { color: tokens.mutedForeground }, { textAlign: 'center' }]}>
          {t('connectionScreen.subtitle')}
        </Text>
      </View>
    </View>
  )

  const facilitator =
    discoveryStatus === 'found' && found ? (
      <Pressable
        onPress={handleFacilitatorConnect}
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

  const qrButton = canUseCamera ? (
    <Button onPress={() => setQrOpen(true)} size="lg">
      <ScanLine size={18} color="#4a2e0a" /> {t('connectionScreen.scanQrCode')}
    </Button>
  ) : null

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
    <SafeScreen style={s.container}>
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
          <View style={s.content}>
            {header}
            {facilitator}
            {qrButton}
            <Button variant="outline" size="lg" onPress={() => setManualOpen(true)} style={s.fullWidth}>
              <Globe size={18} color={tokens.primary} /> {t('connectionScreen.connectManually')}
            </Button>
            {statusAndHint}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      <ManualConnectSheet visible={manualOpen} onClose={closeManual} prefill={prefill} />
      <QRScannerModal visible={qrOpen} onClose={() => setQrOpen(false)} onScanned={handleQrScanned} />
    </SafeScreen>
  )
}

const s = StyleSheet.create({
  container: { flex: 1 },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'stretch',
    gap: 20,
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
    paddingHorizontal: 20,
    paddingTop: 32,
  },
  fullWidth: { alignSelf: 'stretch' },

  reconnecting: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 20, paddingHorizontal: 24 },
  reconnectingText: { alignItems: 'center', gap: 4 },
  title: { fontSize: 18, fontWeight: '600' },
  titleLarge: { fontSize: 24, fontWeight: 'bold' },

  header: { alignItems: 'center', gap: 16 },
  subtitle: { fontSize: 14, lineHeight: 20 },

  facilitatorCard: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 12, borderWidth: 1, paddingHorizontal: 16, paddingVertical: 14 },
  facilitatorIcon: { width: 40, height: 40, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },

  checkingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 8 },

  tipBox: { borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12 },
  tipText: { fontSize: 12, lineHeight: 20 },

  fgSemibold: { fontSize: 14, fontWeight: '600' },
  mutedFg: { fontSize: 12 },
})
