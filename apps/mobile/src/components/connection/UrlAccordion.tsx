import { useState, useCallback, useEffect, useRef } from 'react'
import { View, Text, TextInput, Pressable, Animated, Platform } from 'react-native'
import { ChevronDown, Globe, Keyboard, Loader2 } from 'lucide-react-native'
import * as Device from 'expo-device'
import { useConnectionStore } from '~/stores/connection-store'
import { cn } from '~/lib/utils'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Card } from '~/components/ui/card'

const DEFAULT_PORT = '3847'

interface UrlAccordionProps {
  /** Pre-fill IP and port from QR scan */
  prefill?: { host: string; port: number }
  /** Começa expandido (web/telas grandes) ou colapsado (mobile). */
  defaultExpanded?: boolean
}

export function UrlAccordion({ prefill, defaultExpanded = true }: UrlAccordionProps) {
  const { connection, connect } = useConnectionStore()
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [ip, setIp] = useState(prefill?.host ?? '')
  const [port, setPort] = useState(String(prefill?.port ?? DEFAULT_PORT))
  const [pin, setPin] = useState(['', '', '', '', '', ''])
  const pinRefs = useRef<(TextInput | null)[]>([])
  const prevPrefillRef = useRef(prefill)

  // Update form when QR scan provides new prefill
  useEffect(() => {
    if (prefill && prefill !== prevPrefillRef.current) {
      setIp(prefill.host)
      setPort(String(prefill.port))
      setExpanded(true)
      prevPrefillRef.current = prefill
      // Endereço já veio preenchido — falta só o PIN
      setTimeout(() => pinRefs.current[0]?.focus(), 350)
    }
  }, [prefill])
  const [rotateAnim] = useState(() => new Animated.Value(defaultExpanded ? 1 : 0))

  const isConnecting = connection.status === 'connecting' || connection.status === 'authenticating'

  const toggleExpanded = useCallback(() => {
    const toValue = expanded ? 0 : 1
    Animated.timing(rotateAnim, {
      toValue,
      duration: 200,
      useNativeDriver: true,
    }).start()
    setExpanded(!expanded)
  }, [expanded, rotateAnim])

  const pinString = pin.join('')
  const canConnect = ip.trim().length > 0 && port.trim().length > 0 && pinString.length === 6

  const handleConnect = useCallback(() => {
    if (!canConnect) return
    connect({
      host: ip.trim(),
      port: parseInt(port, 10),
      pin: pinString,
      deviceName: Device.deviceName ?? `Orbit ${Platform.OS}`,
    })
  }, [ip, port, pinString, connect, canConnect])

  const handlePinDigit = useCallback((text: string, index: number) => {
    const digit = text.replace(/\D/g, '').slice(-1)
    if (!digit) return
    setPin(prev => {
      const next = [...prev]
      next[index] = digit
      return next
    })
    if (index < 5) pinRefs.current[index + 1]?.focus()
  }, [])

  const handlePinKeyPress = useCallback((key: string, index: number) => {
    if (key === 'Backspace') {
      setPin(prev => {
        const next = [...prev]
        if (next[index]) {
          next[index] = ''
        } else if (index > 0) {
          next[index - 1] = ''
          pinRefs.current[index - 1]?.focus()
        }
        return next
      })
    }
  }, [])

  const handlePinPaste = useCallback((text: string) => {
    const digits = text.replace(/\D/g, '').slice(0, 6).split('')
    setPin(prev => {
      const next = [...prev]
      digits.forEach((d, i) => { next[i] = d })
      return next
    })
    const focusIdx = Math.min(digits.length, 5)
    pinRefs.current[focusIdx]?.focus()
  }, [])

  const handleReset = useCallback(() => {
    setIp('')
    setPort(DEFAULT_PORT)
    setPin(['', '', '', '', '', ''])
  }, [])

  const rotateInterpolation = rotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '180deg'],
  })

  return (
    <Card className="overflow-hidden">
      {/* Accordion Header */}
      <Pressable onPress={toggleExpanded} className="flex-row items-center justify-between px-4 py-4">
        <View className="flex-row items-center gap-3">
          <View className="h-10 w-10 items-center justify-center rounded-md bg-primary/10">
            <Globe size={18} className="text-primary" />
          </View>
          <View>
            <Text className="text-sm font-medium text-foreground">Conectar manualmente</Text>
            <Text className="text-xs text-muted-foreground">
              IP, porta e PIN do Orbit Desktop
            </Text>
          </View>
        </View>
        <Animated.View style={{ transform: [{ rotate: rotateInterpolation }] }}>
          <ChevronDown size={20} className="text-muted-foreground" />
        </Animated.View>
      </Pressable>

      {/* Expanded Content */}
      {expanded && (
        <View className="gap-4 px-4 pb-4">
          {/* IP + Port row */}
          <View className="flex-row gap-3">
            <View className="flex-1 gap-1.5">
              <Text className="text-xs font-medium text-muted-foreground">Endereço IP</Text>
              <Input
                placeholder="192.168.1.100"
                value={ip}
                onChangeText={setIp}
                keyboardType="numbers-and-punctuation"
                autoCapitalize="none"
                autoCorrect={false}
                className="text-sm"
              />
            </View>
            <View className="w-20 gap-1.5">
              <Text className="text-xs font-medium text-muted-foreground">Porta</Text>
              <Input
                placeholder="3847"
                value={port}
                onChangeText={setPort}
                keyboardType="number-pad"
                className="text-sm text-center"
              />
            </View>
          </View>

          {/* PIN Input */}
          <View className="gap-2">
            <Text className="text-xs font-medium text-muted-foreground">PIN</Text>
            <View className="flex-row justify-center gap-2">
              {pin.map((digit, i) => (
                <TextInput
                  key={i}
                  ref={(ref) => { pinRefs.current[i] = ref }}
                  className={cn(
                    'h-12 w-11 rounded-lg border text-center text-lg font-semibold text-foreground',
                    digit ? 'border-primary bg-primary/5' : 'border-border bg-background',
                    isConnecting && 'opacity-50',
                  )}
                  keyboardType="number-pad"
                  maxLength={1}
                  value={digit}
                  onChangeText={(text) => {
                    if (text.length > 1) {
                      handlePinPaste(text)
                    } else if (text) {
                      handlePinDigit(text, i)
                    }
                  }}
                  onKeyPress={({ nativeEvent }) => handlePinKeyPress(nativeEvent.key, i)}
                  selectTextOnFocus
                  editable={!isConnecting}
                />
              ))}
            </View>
          </View>

          {/* Error */}
          {connection.error ? (
            <View className="rounded-lg bg-destructive/10 px-3 py-2">
              <Text className="text-xs text-destructive">
                {connection.error === 'invalid_pin'
                  ? 'PIN inválido. Verifique o PIN exibido no Orbit Desktop.'
                  : connection.error}
              </Text>
            </View>
          ) : null}

          {/* Connect Button */}
          <View className="flex-row gap-2">
            <Button
              onPress={handleConnect}
              disabled={!canConnect || isConnecting}
              className="flex-1"
            >
              {isConnecting ? (
                <Loader2 size={16} className="animate-spin" />
              ) : null}
              {isConnecting ? 'Conectando...' : 'Conectar'}
            </Button>
            <Button variant="ghost" size="icon" onPress={handleReset}>
              <Keyboard size={18} />
            </Button>
          </View>
        </View>
      )}
    </Card>
  )
}
