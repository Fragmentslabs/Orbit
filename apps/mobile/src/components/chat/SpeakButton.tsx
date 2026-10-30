/**
 * LISTEN: reads the answer out loud.
 *
 * It only exists in an assistant answer with text to read (`speakableText`) —
 * same rule as the desktop, including what is left out: the orbit-ui JSON and the
 * mermaid code are inline images, not prose.
 *
 * The synthesis runs on the desktop, which returns the signed URL of a WAV; here it is only
 * requested and played (see `stores/speak-store`). Without a ready voice engine, the button
 * becomes a red icon and the reason from the desktop shows below (see MessageActions)
 * instead of a dead button with no explanation.
 */
import { useMemo } from 'react'
import { ActivityIndicator } from 'react-native'
import { Square, Volume2 } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { ChatMessage } from '@orbit/shared'
import { speakableText } from '@orbit/shared'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useSpeakStore } from '~/stores/speak-store'
import { useThemeStore } from '~/stores/theme-store'
import { IconButton } from './IconButton'

export function SpeakButton({ message }: { message: ChatMessage }) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const text = useMemo(() => speakableText(message), [message])
  // `state` only counts for THIS message: the store holds one id at a time.
  const state = useSpeakStore((s) => (s.messageId === message.id ? s.state : 'idle'))
  // Tied to THIS message: the store holds one error at a time, and an error from another
  // bubble cannot paint this icon red.
  const error = useSpeakStore((s) => (s.errorMessageId === message.id ? s.error : null))
  const toggle = useSpeakStore((s) => s.toggle)

  // Tool-only turn: there is nothing to read.
  if (!text) return null

  const label =
    state === 'generating'
      ? t('voice.tts.generating')
      : state === 'playing'
        ? t('voice.tts.stop')
        : t('voice.tts.speak')

  return (
    <IconButton
      onPress={() => toggle(message)}
      accessibilityLabel={label}
      accessibilityState={{ busy: state === 'generating' }}
      testID="speak-button"
    >
      {state === 'generating' ? (
        // 20px inside a fixed 21 box: it shrinks on screen without changing
        // size in the layout, so the row does not jump while the voice is generated.
        <ActivityIndicator
          size="small"
          color={tokens.primary}
          style={{ transform: [{ scale: 0.6 }] }}
        />
      ) : state === 'playing' ? (
        <Square size={13} color={tokens.destructive} fill={tokens.destructive} />
      ) : (
        <Volume2 size={13} color={error ? tokens.destructive : tokens.mutedForeground} />
      )}
    </IconButton>
  )
}
