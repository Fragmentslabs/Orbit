import { View, Text } from 'react-native'
import { Copy, Reply, RotateCcw, CheckCircle } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { ChatMessage } from '@orbit/shared'
import { getThemeTokens } from '~/lib/theme-tokens'
import { formatTime } from '~/lib/format-time'
import { useThemeStore } from '~/stores/theme-store'
import { useSpeakStore } from '~/stores/speak-store'
import { IconButton } from './IconButton'
import { SpeakButton } from './SpeakButton'
import { useState } from 'react'

interface MessageActionsProps {
  message: ChatMessage
  onCopy?: () => void
  onRevert?: () => void
  /** Marca a mensagem como contexto no compositor (ver formatMessageReply). */
  onReply?: () => void
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const totalMinutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (totalMinutes < 60) return `${totalMinutes}m ${String(seconds).padStart(2, '0')}s`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${hours}h ${String(minutes).padStart(2, '0')}m`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatCost(cost: number): string {
  if (cost >= 0.01) return `$${cost.toFixed(2)}`
  return `$${cost.toFixed(4)}`
}

export function MessageActions({ message, onCopy, onRevert, onReply }: MessageActionsProps) {
  const { t, i18n } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const [copied, setCopied] = useState(false)
  // Motivo da falha da leitura em voz alta DESTA mensagem (motor sem modelo,
  // offline). Fora da linha de ações: a linha é apagada de propósito (opacity),
  // e um erro legível não pode nascer ilegível. Preso ao id porque a store
  // guarda um erro por vez — solto, ele apareceria em todas as bolhas.
  const speakError = useSpeakStore((s) => (s.errorMessageId === message.id ? s.error : null))

  const handleCopy = () => {
    onCopy?.()
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // Na bolha do usuário a barra fica logo abaixo de um bloco estreito e
  // alinhado à direita — o filete separador ali vira um risco solto.
  const isUser = message.role === 'user'

  return (
    <View style={{ marginTop: isUser ? 4 : 8 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
          paddingTop: isUser ? 0 : 8,
          opacity: 0.55,
        }}
      >
        <IconButton onPress={handleCopy}>
          {copied
            ? <CheckCircle size={13} color={tokens.primary} />
            : <Copy size={13} color={tokens.mutedForeground} />
          }
        </IconButton>

        {/* Ouvir: ao lado do copiar, como no desktop. Só aparece em resposta
            do assistente que tenha prosa para ler. */}
        <SpeakButton message={message} />

        {/* Responder: a mensagem vira citação do próximo envio (barra acima do
            campo de texto), como no WhatsApp. */}
        {onReply && (
          <IconButton onPress={onReply} accessibilityLabel={t('reply.action')}>
            <Reply size={13} color={tokens.mutedForeground} />
          </IconButton>
        )}

        {/* Revert parte da mensagem do usuário: descarta esse turno e tudo
            depois dele e devolve texto/anexos ao input, como se estivesse
            editando a mensagem. */}
        {onRevert && message.role === 'user' && (
          <IconButton onPress={onRevert}>
            <RotateCcw size={13} color={tokens.mutedForeground} />
          </IconButton>
        )}

        <Text style={{ fontSize: 10, fontFamily: 'monospace', color: tokens.mutedForeground }}>
          {formatTime(message.completedAt ?? message.createdAt, i18n.language)}
        </Text>

        {message.completedAt && (
          <Text style={{ fontSize: 10, fontFamily: 'monospace', color: tokens.mutedForeground }}>
            · {formatDuration(message.completedAt - message.createdAt)}
          </Text>
        )}

        {message.tokens && (
          <Text style={{ fontSize: 10, fontFamily: 'monospace', color: tokens.mutedForeground }}>
            · {formatTokens(message.tokens.input)} in · {formatTokens(message.tokens.output)} out
            {message.tokens.cacheRead > 0 && ` · ${formatTokens(message.tokens.cacheRead)} cache`}
            {message.tokens.cost !== undefined && ` · ${formatCost(message.tokens.cost)}`}
          </Text>
        )}
      </View>

      {/* Por que a fala não saiu ("baixe o modelo em Voz", "sem conexão"). */}
      {speakError && (
        <Text numberOfLines={2} style={{ fontSize: 10, marginTop: 2, color: tokens.destructive }}>
          {speakError}
        </Text>
      )}
    </View>
  )
}
