import { useRef, useState, useCallback } from 'react'
import { TextInput, View, Text, StyleSheet, type NativeSyntheticEvent, type TextInputKeyPressEventData } from 'react-native'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

const PIN_LENGTH = 6

interface PinInputProps {
  onComplete: (pin: string) => void
  disabled?: boolean
  error?: string
}

export function PinInput({ onComplete, disabled, error }: PinInputProps) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const [digits, setDigits] = useState<string[]>(Array(PIN_LENGTH).fill(''))
  const inputs = useRef<(TextInput | null)[]>([])

  const focusInput = useCallback((index: number) => {
    if (index >= 0 && index < PIN_LENGTH) inputs.current[index]?.focus()
  }, [])

  const handleChange = useCallback((text: string, index: number) => {
    const digit = text.replace(/\D/g, '').slice(-1)
    const next = [...digits]; next[index] = digit; setDigits(next)
    if (digit && index < PIN_LENGTH - 1) focusInput(index + 1)
    const pin = next.join('')
    if (pin.length === PIN_LENGTH) onComplete(pin)
  }, [digits, focusInput, onComplete])

  const handleKeyPress = useCallback((e: NativeSyntheticEvent<TextInputKeyPressEventData>, index: number) => {
    if (e.nativeEvent.key === 'Backspace' && !digits[index] && index > 0) {
      const next = [...digits]; next[index - 1] = ''; setDigits(next)
      focusInput(index - 1)
    }
  }, [digits, focusInput])

  const handlePaste = useCallback((text: string) => {
    const pasted = text.replace(/\D/g, '').slice(0, PIN_LENGTH)
    if (!pasted) return
    const next = Array<string>(PIN_LENGTH).fill('')
    for (let i = 0; i < pasted.length; i++) next[i] = pasted[i]!
    setDigits(next)
    focusInput(Math.min(pasted.length, PIN_LENGTH - 1))
    if (pasted.length === PIN_LENGTH) onComplete(pasted)
  }, [focusInput, onComplete])

  return (
    <View style={s.container}>
      <View style={s.row}>
        {digits.map((digit, i) => (
          <TextInput
            key={i}
            ref={(ref) => { inputs.current[i] = ref }}
            style={[
              { height: 48, width: 44, borderWidth: 1, borderRadius: 8, textAlign: 'center', fontSize: 18, fontWeight: '600', borderColor: tokens.border, backgroundColor: tokens.background, color: tokens.foreground },
              digit ? { borderColor: tokens.primary, backgroundColor: 'rgba(245,166,35,0.05)' } : null,
              error ? { borderColor: '#ff3344' } : null,
              disabled ? { opacity: 0.5 } : null,
            ]}
            keyboardType="number-pad"
            maxLength={PIN_LENGTH}
            value={digit}
            onChangeText={(text) => { text.length > 1 ? handlePaste(text) : handleChange(text, i) }}
            onKeyPress={(e) => handleKeyPress(e, i)}
            selectTextOnFocus
            editable={!disabled}
            autoFocus={i === 0}
          />
        ))}
      </View>
      {error ? <Text style={[s.errorText, { color: '#ff3344' }]}>{error}</Text> : null}
    </View>
  )
}

const s = StyleSheet.create({
  container: { alignItems: 'center' },
  row: { flexDirection: 'row', gap: 8 },
  errorText: { marginTop: 8, fontSize: 12 },
})
