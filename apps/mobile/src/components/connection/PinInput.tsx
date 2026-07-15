import { useRef, useState, useCallback } from 'react'
import { TextInput, View, Text, type NativeSyntheticEvent, type TextInputKeyPressEventData } from 'react-native'
import { cn } from '~/lib/utils'

const PIN_LENGTH = 6

interface PinInputProps {
  /** Callback chamado quando os 6 dígitos são preenchidos. */
  onComplete: (pin: string) => void
  /** Estado de carregamento (desabilita input). */
  disabled?: boolean
  /** Mensagem de erro exibida abaixo do input. */
  error?: string
  className?: string
}

export function PinInput({ onComplete, disabled, error, className }: PinInputProps) {
  const [digits, setDigits] = useState<string[]>(Array(PIN_LENGTH).fill(''))
  const inputs = useRef<(TextInput | null)[]>([])

  const focusInput = useCallback((index: number) => {
    if (index >= 0 && index < PIN_LENGTH) {
      inputs.current[index]?.focus()
    }
  }, [])

  const handleChange = useCallback(
    (text: string, index: number) => {
      const digit = text.replace(/\D/g, '').slice(-1)
      const next = [...digits]
      next[index] = digit
      setDigits(next)

      if (digit && index < PIN_LENGTH - 1) {
        focusInput(index + 1)
      }

      const pin = next.join('')
      if (pin.length === PIN_LENGTH) {
        onComplete(pin)
      }
    },
    [digits, focusInput, onComplete],
  )

  const handleKeyPress = useCallback(
    (e: NativeSyntheticEvent<TextInputKeyPressEventData>, index: number) => {
      if (e.nativeEvent.key === 'Backspace' && !digits[index] && index > 0) {
        const next = [...digits]
        next[index - 1] = ''
        setDigits(next)
        focusInput(index - 1)
      }
    },
    [digits, focusInput],
  )

  const handlePaste = useCallback(
    (text: string) => {
      const pasted = text.replace(/\D/g, '').slice(0, PIN_LENGTH)
      if (!pasted) return

      const next = Array<string>(PIN_LENGTH).fill('')
      for (let i = 0; i < pasted.length; i++) {
        next[i] = pasted[i]!
      }
      setDigits(next)

      const focusIdx = Math.min(pasted.length, PIN_LENGTH - 1)
      focusInput(focusIdx)

      if (pasted.length === PIN_LENGTH) {
        onComplete(pasted)
      }
    },
    [focusInput, onComplete],
  )

  return (
    <View className={cn('items-center', className)}>
      <View className="flex-row gap-2">
        {digits.map((digit, i) => (
          <TextInput
            key={i}
            ref={(ref) => { inputs.current[i] = ref }}
            className={cn(
              'h-12 w-11 rounded-lg border text-center text-lg font-semibold text-foreground',
              'focus:border-primary focus:ring-1 focus:ring-primary',
              digit ? 'border-primary bg-primary/5' : 'border-border bg-background',
              error && 'border-destructive',
              disabled && 'opacity-50',
            )}
            keyboardType="number-pad"
            maxLength={PIN_LENGTH}
            value={digit}
            onChangeText={(text) => {
              if (text.length > 1) {
                handlePaste(text)
              } else {
                handleChange(text, i)
              }
            }}
            onKeyPress={(e) => handleKeyPress(e, i)}
            selectTextOnFocus
            editable={!disabled}
            autoFocus={i === 0}
          />
        ))}
      </View>
      {error ? (
        <Text className="mt-2 text-xs text-destructive">{error}</Text>
      ) : null}
    </View>
  )
}
