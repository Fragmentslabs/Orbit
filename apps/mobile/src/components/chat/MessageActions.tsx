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
  /** Marks the message as context in the composer (see formatMessageReply). */
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
  // Reason for the read-aloud failure of THIS message (engine without a model,
  // offline). Outside the actions row: the row is dimmed on purpose (opacity),
  // and a legible error cannot be born illegible. Tied to the id because the store
  // holds one error at a time — loose, it would show up in every bubble.
  const speakError = useSpeakStore((s) => (s.errorMessageId === message.id ? s.error : null))

  const handleCopy = () => {
    onCopy?.()
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // In the user bubble the bar sits right below a narrow block aligned
  // to the right — the separator hairline there becomes a loose line.
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

        {/* Listen: next to copy, as on the desktop. It only shows up in an assistant
            answer that has prose to read. */}
        <SpeakButton message={message} />

        {/* Reply: the message becomes a quote of the next send (bar above the
            text field), as in WhatsApp. */}
        {onReply && (
          <IconButton onPress={onReply} accessibilityLabel={t('reply.action')}>
            <Reply size={13} color={tokens.mutedForeground} />
          </IconButton>
        )}

        {/* Revert part of the user message: discards that turn and everything
            after it and gives text/attachments back to the input, as if
            editing the message. */}
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

      {/* Why the speech did not come out ("download the model in Voice", "no connection"). */}
      {speakError && (
        <Text numberOfLines={2} style={{ fontSize: 10, marginTop: 2, color: tokens.destructive }}>
          {speakError}
        </Text>
      )}
    </View>
  )
}
