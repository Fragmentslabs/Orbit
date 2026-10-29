/**
 * OUVIR: lê a resposta em voz alta.
 *
 * Só existe em resposta do assistente com texto para ler (`speakableText`) —
 * mesma regra do desktop, inclusive no que fica de fora: o JSON do orbit-ui e o
 * código do mermaid são imagens inline, não prosa.
 *
 * A síntese roda no desktop, que devolve a URL assinada de um WAV; aqui só se
 * pede e se toca (ver `stores/speak-store`). Sem motor de voz pronto, o botão
 * vira ícone vermelho e o motivo do desktop aparece embaixo (ver MessageActions)
 * em vez de um botão morto sem explicação.
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
  // `state` só vale para ESTA mensagem: a store guarda um id por vez.
  const state = useSpeakStore((s) => (s.messageId === message.id ? s.state : 'idle'))
  // Preso a ESTA mensagem: a store guarda um erro por vez, e um erro de outra
  // bolha não pode pintar este ícone de vermelho.
  const error = useSpeakStore((s) => (s.errorMessageId === message.id ? s.error : null))
  const toggle = useSpeakStore((s) => s.toggle)

  // Turno só de ferramentas: não há o que ler.
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
        // 20px dentro de uma caixa fixa de 21: encolhe na tela sem mudar de
        // tamanho no layout, então a linha não pula enquanto a voz é gerada.
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
