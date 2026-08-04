import { View, Text, Pressable } from 'react-native'
import { Copy, RotateCcw, Clock, CheckCircle } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { ChatMessage } from '@orbit/shared'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { useState } from 'react'

interface MessageActionsProps {
  message: ChatMessage
  onCopy?: () => void
  onRevert?: () => void
}

function formatTime(ts: number, locale: string): string {
  const d = new Date(ts)
  return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
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

export function MessageActions({ message, onCopy, onRevert }: MessageActionsProps) {
  const { i18n } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    onCopy?.()
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        marginTop: 8,
        paddingTop: 8,
        borderTopWidth: 1,
        borderTopColor: tokens.border,
        opacity: 0.55,
      }}
    >
      <Pressable
        onPress={handleCopy}
        style={({ pressed }) => ({
          padding: 4,
          borderRadius: 4,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        {copied
          ? <CheckCircle size={13} color={tokens.primary} />
          : <Copy size={13} color={tokens.mutedForeground} />
        }
      </Pressable>

      {onRevert && message.role === 'assistant' && (
        <Pressable
          onPress={onRevert}
          style={({ pressed }) => ({
            padding: 4,
            borderRadius: 4,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <RotateCcw size={13} color={tokens.mutedForeground} />
        </Pressable>
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
  )
}
