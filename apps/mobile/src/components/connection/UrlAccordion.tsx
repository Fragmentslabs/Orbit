import { useState, useCallback, useEffect, useRef } from 'react'
import { View, Text, TextInput, Pressable, Animated, Platform, StyleSheet } from 'react-native'
import { ChevronDown, Globe, Keyboard, Loader2 } from 'lucide-react-native'
import * as Device from 'expo-device'
import { useConnectionStore } from '~/stores/connection-store'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Card } from '~/components/ui/card'
import { Spin } from '~/components/ui/spin'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

const DEFAULT_PORT = '3847'

interface UrlAccordionProps {
  prefill?: { host: string; port: number }
  defaultExpanded?: boolean
}

export function UrlAccordion({ prefill, defaultExpanded = true }: UrlAccordionProps) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const { connection, connect } = useConnectionStore()
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [ip, setIp] = useState(prefill?.host ?? '')
  const [port, setPort] = useState(String(prefill?.port ?? DEFAULT_PORT))
  const [pin, setPin] = useState(['', '', '', '', '', ''])
  const pinRefs = useRef<(TextInput | null)[]>([])
  const prevPrefillRef = useRef(prefill)

  useEffect(() => {
    if (prefill && prefill !== prevPrefillRef.current) {
      setIp(prefill.host)
      setPort(String(prefill.port))
      setExpanded(true)
      prevPrefillRef.current = prefill
      setTimeout(() => pinRefs.current[0]?.focus(), 350)
    }
  }, [prefill])

  const [rotateAnim] = useState(() => new Animated.Value(defaultExpanded ? 1 : 0))
  const isConnecting = connection.status === 'connecting' || connection.status === 'authenticating'

  const toggleExpanded = useCallback(() => {
    Animated.timing(rotateAnim, { toValue: expanded ? 0 : 1, duration: 200, useNativeDriver: true }).start()
    setExpanded(!expanded)
  }, [expanded, rotateAnim])

  const pinString = pin.join('')
  const canConnect = ip.trim().length > 0 && port.trim().length > 0 && pinString.length === 6

  const handleConnect = useCallback(() => {
    if (!canConnect) return
    connect({ host: ip.trim(), port: parseInt(port, 10), pin: pinString, deviceName: Device.deviceName ?? `Orbit ${Platform.OS}` })
  }, [ip, port, pinString, connect, canConnect])

  const handlePinDigit = useCallback((text: string, index: number) => {
    const digit = text.replace(/\D/g, '').slice(-1)
    if (!digit) return
    setPin(prev => {
      const next = [...prev]; next[index] = digit; return next
    })
    if (index < 5) {
      pinRefs.current[index + 1]?.focus()
    } else if (index === 5) {
      // 6th digit entered — auto-submit after a brief delay
      const fullPin = pin.slice(0, 5).join('') + digit
      if (ip.trim().length > 0 && port.trim().length > 0 && fullPin.length === 6) {
        setTimeout(() => {
          connect({
            host: ip.trim(),
            port: parseInt(port, 10),
            pin: fullPin,
            deviceName: Device.deviceName ?? `Orbit ${Platform.OS}`,
          })
        }, 150)
      }
    }
  }, [ip, port, pin, connect])

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

  const rotateInterpolation = rotateAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] })

  return (
    <Card style={{ overflow: 'hidden' }}>
      <Pressable onPress={toggleExpanded} style={s.header}>
        <View style={s.headerLeft}>
          <View style={s.iconCircle}>
            <Globe size={18} color={tokens.primary} />
          </View>
          <View>
            <Text style={[s.fg, { color: tokens.foreground }]}>Conectar manualmente</Text>
            <Text style={[s.mutedFg, { color: tokens.mutedForeground }]}>IP, porta e PIN do Orbit Desktop</Text>
          </View>
        </View>
        <Animated.View style={{ transform: [{ rotate: rotateInterpolation }] }}>
          <ChevronDown size={20} color={tokens.mutedForeground} />
        </Animated.View>
      </Pressable>

      {expanded && (
        <View style={s.body}>
          <View style={s.row}>
            <View style={{ flex: 1, gap: 6 }}>
              <Text style={[s.label, { color: tokens.mutedForeground }]}>Endereço IP</Text>
              <Input placeholder="192.168.1.100" value={ip} onChangeText={setIp} keyboardType="numbers-and-punctuation" autoCapitalize="none" autoCorrect={false} />
            </View>
            <View style={{ width: 80, gap: 6 }}>
              <Text style={[s.label, { color: tokens.mutedForeground }]}>Porta</Text>
              <Input placeholder="3847" value={port} onChangeText={setPort} keyboardType="number-pad" style={{ textAlign: 'center' }} />
            </View>
          </View>

          <View style={{ gap: 8 }}>
            <Text style={[s.label, { color: tokens.mutedForeground }]}>PIN</Text>
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
                {connection.error === 'invalid_pin' ? 'PIN inválido. Verifique o PIN exibido no Orbit Desktop.' : connection.error}
              </Text>
            </View>
          ) : null}

          <View style={s.row}>
            <View style={{ flex: 1 }}>
              <Button onPress={handleConnect} disabled={!canConnect || isConnecting}>
                {isConnecting ? <Spin><Loader2 size={16} /></Spin> : null}
                {isConnecting ? 'Conectando...' : 'Conectar'}
              </Button>
            </View>
            <Button variant="ghost" size="icon" onPress={handleReset}>
              <Keyboard size={18} />
            </Button>
          </View>
        </View>
      )}
    </Card>
  )
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  iconCircle: { width: 40, height: 40, borderRadius: 6, backgroundColor: 'rgba(245,166,35,0.1)', alignItems: 'center', justifyContent: 'center' },
  body: { gap: 16, paddingHorizontal: 16, paddingBottom: 16 },
  row: { flexDirection: 'row', gap: 12 },
  label: { fontSize: 12, fontWeight: '500' },
  fg: { fontSize: 14, fontWeight: '500' },
  mutedFg: { fontSize: 12 },
  pinRow: { flexDirection: 'row', justifyContent: 'center', gap: 8 },
  errorBox: { borderRadius: 8, backgroundColor: 'rgba(255,51,68,0.1)', paddingHorizontal: 12, paddingVertical: 8 },
  errorText: { fontSize: 12 },
})
