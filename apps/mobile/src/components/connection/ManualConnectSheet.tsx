import { useCallback, useEffect, useRef, useState } from 'react'
import { Modal, View, Text, TextInput, Pressable, Animated, Platform, ScrollView, StyleSheet, Keyboard } from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Globe, History, KeyboardIcon, Loader2, Monitor, X } from 'lucide-react-native'
import * as Device from 'expo-device'
import { useTranslation } from 'react-i18next'
import { useConnectionStore } from '~/stores/connection-store'
import { prettyDeviceName } from '~/lib/device-name'
import { useRecentConnectionsStore, type RecentConnection } from '~/stores/recent-connections-store'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Spin } from '~/components/ui/spin'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

const DEFAULT_PORT = '3847'
const SLIDE_DURATION = 250
/** Altura máxima do drawer — recentes + formulário rolam internamente. */
const MAX_SHEET_HEIGHT = 640

interface ManualConnectSheetProps {
  visible: boolean
  onClose: () => void
  /** Host/porta pré-preenchidos (ex.: QR escaneado sem PIN). */
  prefill?: { host: string; port: number }
}

/**
 * Drawer de conexão manual (substitui o antigo card UrlAccordion).
 * Reúne as conexões recentes e o formulário IP/porta/PIN em um só lugar,
 * mantendo a tela principal limpa.
 */
export function ManualConnectSheet({ visible, onClose, prefill }: ManualConnectSheetProps) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const insets = useSafeAreaInsets()
  const { connection, connect } = useConnectionStore()
  const { recent, removeRecent } = useRecentConnectionsStore()

  const [ip, setIp] = useState('')
  const [port, setPort] = useState(DEFAULT_PORT)
  const [pin, setPin] = useState(['', '', '', '', '', ''])
  const pinRefs = useRef<(TextInput | null)[]>([])
  const prevPrefillRef = useRef(prefill)

  const [slideAnim] = useState(() => new Animated.Value(MAX_SHEET_HEIGHT))
  const [backdropAnim] = useState(() => new Animated.Value(0))

  const isConnecting = connection.status === 'connecting' || connection.status === 'authenticating'

  // Altura do teclado — usada para limitar a altura do drawer quando o teclado
  // abre (evita o cabeçalho sair da tela). O levantamento suave fica por conta
  // do KeyboardAvoidingView do react-native-keyboard-controller (mesma
  // convenção do ChatScreen).
  const [kbHeight, setKbHeight] = useState(0)

  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      (e) => setKbHeight(e.endCoordinates.height),
    )
    const hide = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setKbHeight(0),
    )
    return () => {
      show.remove()
      hide.remove()
    }
  }, [])

  const handleClose = useCallback(() => {
    Keyboard.dismiss()
    onClose()
  }, [onClose])

  const sheetMaxHeight = Math.max(280, MAX_SHEET_HEIGHT - kbHeight)

  useEffect(() => {
    Animated.parallel([
      Animated.timing(slideAnim, { toValue: visible ? 0 : MAX_SHEET_HEIGHT, duration: SLIDE_DURATION, useNativeDriver: true }),
      Animated.timing(backdropAnim, { toValue: visible ? 1 : 0, duration: SLIDE_DURATION, useNativeDriver: true }),
    ]).start()
  }, [visible, slideAnim, backdropAnim])

  // Prefill chega enquanto o drawer abre (QR escaneado sem PIN) — preenche e foca o PIN.
  useEffect(() => {
    if (visible && prefill && prefill !== prevPrefillRef.current) {
      setIp(prefill.host)
      setPort(String(prefill.port))
      prevPrefillRef.current = prefill
      setTimeout(() => pinRefs.current[0]?.focus(), 350)
    }
  }, [visible, prefill])

  const doConnect = useCallback((host: string, portNumber: number, pinValue: string, token?: string) => {
    connect({
      host,
      port: portNumber,
      pin: pinValue,
      token,
      deviceName: Device.deviceName ?? `Orbit ${Platform.OS}`,
    })
  }, [connect])

  const handleRecentPress = useCallback((rc: RecentConnection) => {
    if (rc.pin || rc.token) {
      doConnect(rc.host, rc.port, rc.pin ?? '', rc.token)
      return
    }
    // Sem credencial salva — cai no formulário pré-preenchido.
    setIp(rc.host)
    setPort(String(rc.port))
    setTimeout(() => pinRefs.current[0]?.focus(), 350)
  }, [doConnect])

  const pinString = pin.join('')
  const canConnect = ip.trim().length > 0 && port.trim().length > 0 && pinString.length === 6

  const handleConnect = useCallback(() => {
    if (!canConnect) return
    doConnect(ip.trim(), parseInt(port, 10), pinString)
  }, [ip, port, pinString, canConnect, doConnect])

  const handlePinDigit = useCallback((text: string, index: number) => {
    const digit = text.replace(/\D/g, '').slice(-1)
    if (!digit) return
    setPin(prev => {
      const next = [...prev]; next[index] = digit; return next
    })
    if (index < 5) {
      pinRefs.current[index + 1]?.focus()
    } else if (index === 5) {
      // 6º dígito — submete automaticamente após um breve delay
      const fullPin = pin.slice(0, 5).join('') + digit
      if (ip.trim().length > 0 && port.trim().length > 0 && fullPin.length === 6) {
        setTimeout(() => {
          doConnect(ip.trim(), parseInt(port, 10), fullPin)
        }, 150)
      }
    }
  }, [ip, port, pin, doConnect])

  const handlePinKeyPress = useCallback((key: string, index: number) => {
    if (key === 'Backspace') {
      setPin(prev => {
        const next = [...prev]
        if (next[index]) { next[index] = '' }
        else if (index > 0) { next[index - 1] = ''; pinRefs.current[index - 1]?.focus() }
        return next
      })
    }
  }, [])

  const handlePinPaste = useCallback((text: string) => {
    const digits = text.replace(/\D/g, '').slice(0, 6).split('')
    setPin(prev => { const next = [...prev]; digits.forEach((d, i) => { next[i] = d }); return next })
    pinRefs.current[Math.min(digits.length, 5)]?.focus()
  }, [])

  const handleReset = useCallback(() => {
    setIp(''); setPort(DEFAULT_PORT); setPin(['', '', '', '', '', ''])
  }, [])

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={handleClose}>
      <KeyboardAvoidingView behavior="padding" style={s.overlay}>
        <Animated.View style={[StyleSheet.absoluteFill, s.backdrop, { opacity: backdropAnim }]}>
          <Pressable style={{ flex: 1 }} onPress={handleClose} />
        </Animated.View>

        <Animated.View
          style={[
            s.sheet,
            {
              maxHeight: sheetMaxHeight,
              transform: [{ translateY: slideAnim }],
              backgroundColor: tokens.background,
              borderColor: tokens.border,
              paddingBottom: insets.bottom + 16,
            },
          ]}
        >
          <View style={[s.handle, { backgroundColor: tokens.muted }]} />

          <View style={s.header}>
            <View style={[s.iconCircle, { backgroundColor: 'rgba(245,166,35,0.1)' }]}>
              <Globe size={18} color={tokens.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[s.title, { color: tokens.foreground }]}>{t('manualConnectSheet.title')}</Text>
              <Text style={[s.subtitle, { color: tokens.mutedForeground }]}>{t('manualConnectSheet.subtitle')}</Text>
            </View>
            <Pressable onPress={handleClose} hitSlop={8} style={s.closeBtn}>
              <X size={20} color={tokens.mutedForeground} />
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={s.scrollContent} keyboardShouldPersistTaps="handled">
            <View style={{ gap: 16 }}>
              <View style={s.row}>
                <View style={{ flex: 1, gap: 6 }}>
                  <Text style={[s.label, { color: tokens.mutedForeground }]}>{t('manualConnectSheet.ipAddress')}</Text>
                  <Input placeholder="192.168.1.100" value={ip} onChangeText={setIp} keyboardType="numbers-and-punctuation" autoCapitalize="none" autoCorrect={false} />
                </View>
                <View style={{ width: 80, gap: 6 }}>
                  <Text style={[s.label, { color: tokens.mutedForeground }]}>{t('manualConnectSheet.port')}</Text>
                  <Input placeholder="3847" value={port} onChangeText={setPort} keyboardType="number-pad" style={{ textAlign: 'center' }} />
                </View>
              </View>

              <View style={{ gap: 8 }}>
                <View style={s.pinLabelRow}>
                  <Text style={[s.label, { color: tokens.mutedForeground }]}>{t('manualConnectSheet.pin')}</Text>
                  <Pressable
                    onPress={handleReset}
                    hitSlop={10}
                    style={s.resetBtn}
                    accessibilityLabel={t('manualConnectSheet.reset')}
                  >
                    <KeyboardIcon size={14} color={tokens.mutedForeground} />
                  </Pressable>
                </View>
                <View style={s.pinRow}>
                  {pin.map((digit, i) => (
                    <TextInput
                      key={i}
                      ref={(ref) => { pinRefs.current[i] = ref }}
                      style={[{ height: 48, width: 44, borderWidth: 1, borderRadius: 8, textAlign: 'center', fontSize: 18, fontWeight: '600', borderColor: tokens.border, backgroundColor: tokens.background, color: tokens.foreground }, digit ? { borderColor: tokens.primary, backgroundColor: 'rgba(245,166,35,0.05)' } : null, isConnecting ? { opacity: 0.5 } : null]}
                      keyboardType="number-pad"
                      maxLength={1}
                      value={digit}
                      onChangeText={(text) => { if (text.length > 1) handlePinPaste(text); else if (text) handlePinDigit(text, i) }}
                      onKeyPress={({ nativeEvent }) => handlePinKeyPress(nativeEvent.key, i)}
                      selectTextOnFocus
                      editable={!isConnecting}
                    />
                  ))}
                </View>
              </View>

              {connection.error ? (
                <View style={s.errorBox}>
                  <Text style={[s.errorText, { color: '#ff3344' }]}>
                    {connection.error === 'invalid_pin' ? t('manualConnectSheet.invalidPin') : connection.error}
                  </Text>
                </View>
              ) : null}

              <Button onPress={handleConnect} disabled={!canConnect || isConnecting} style={s.fullWidth}>
                {isConnecting ? <Spin><Loader2 size={16} color={tokens.primaryForeground} /></Spin> : null}
                {isConnecting ? t('manualConnectSheet.connecting') : t('manualConnectSheet.connect')}
              </Button>
            </View>

            {recent.length > 0 && <View style={[s.divider, { backgroundColor: tokens.border }]} />}

            {recent.length > 0 && (
              <View style={{ gap: 8 }}>
                <View style={s.recentsHeader}>
                  <History size={13} color={tokens.mutedForeground} />
                  <Text style={[s.recentsTitle, { color: tokens.mutedForeground }]}>{t('manualConnectSheet.recent')}</Text>
                </View>
                {recent.map((rc: RecentConnection) => (
                  <Pressable
                    key={`${rc.host}:${rc.port}`}
                    onPress={() => handleRecentPress(rc)}
                    style={[s.recentCard, { borderColor: tokens.border, backgroundColor: tokens.card }]}
                  >
                    <View style={[s.recentIcon, { backgroundColor: tokens.muted }]}>
                      <Monitor size={16} color={tokens.mutedForeground} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[s.fg, { color: tokens.foreground }]} numberOfLines={1}>{prettyDeviceName(rc.deviceName) ?? rc.host}</Text>
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
            )}
          </ScrollView>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const s = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderBottomWidth: 0,
  },
  fullWidth: { width: '100%' },
  handle: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginTop: 8, marginBottom: 4 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 12 },
  iconCircle: { width: 40, height: 40, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 16, fontWeight: '600' },
  subtitle: { fontSize: 12, marginTop: 2 },
  closeBtn: { width: 32, height: 32, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  scrollContent: { gap: 16, paddingHorizontal: 20, paddingBottom: 8 },
  recentsHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  recentsTitle: { fontSize: 12, fontWeight: '500', textTransform: 'uppercase', letterSpacing: 0.5 },
  recentCard: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 12, borderWidth: 1, paddingHorizontal: 16, paddingVertical: 12 },
  recentIcon: { width: 36, height: 36, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  removeBtn: { width: 28, height: 28, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  divider: { height: 1 },
  row: { flexDirection: 'row', gap: 12 },
  label: { fontSize: 12, fontWeight: '500' },
  pinLabelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  resetBtn: { padding: 4, borderRadius: 6 },
  fg: { fontSize: 14, fontWeight: '500' },
  mutedFg: { fontSize: 12 },
  pinRow: { flexDirection: 'row', justifyContent: 'center', gap: 8 },
  errorBox: { borderRadius: 8, backgroundColor: 'rgba(255,51,68,0.1)', paddingHorizontal: 12, paddingVertical: 8 },
  errorText: { fontSize: 12 },
})
