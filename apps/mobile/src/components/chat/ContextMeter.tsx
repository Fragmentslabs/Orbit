import { useMemo, useCallback } from 'react'
import { View, Text, Pressable } from 'react-native'
import Svg, { Circle } from 'react-native-svg'
import { cn } from '~/lib/utils'
import { useSessionStore } from '~/stores/session-store'
import { useSettingsStore } from '~/stores/settings-store'
import type { TokenUsage } from '@orbit/shared'

function sumTokens(u: TokenUsage): number {
  return (u.input ?? 0) + (u.output ?? 0)
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

const R = 7
const C = 2 * Math.PI * R
const NO_MSGS: import('@orbit/shared').ChatMessage[] = []

export function ContextMeter({ sessionId }: { sessionId?: string }) {
  const messages = useSessionStore((s) =>
    sessionId ? s.messages[sessionId] ?? NO_MSGS : NO_MSGS,
  )
  const { lastTokens, compacted } = useMemo(() => {
    let lastSummary = -1
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].summary) lastSummary = i
    }
    const found = [...messages].reverse().find((m) => m.role === 'assistant' && m.tokens)?.tokens
    return { lastTokens: found, compacted: lastSummary >= 0 }
  }, [messages])

  const catalog = useSettingsStore((s) => s.catalog)
  const selected = useSettingsStore((s) => s.selectedModel)
  const limit = selected && catalog
    ? catalog[selected.providerId]?.models[selected.modelId]?.limit?.context
    : undefined

  const used = lastTokens ? sumTokens(lastTokens) : 0
  const pct = limit && limit > 0 ? used / limit : 0
  const atLimit = pct >= 1

  const handleCompact = useCallback(async () => {
    if (!sessionId) return
    const sendMsg = useSessionStore.getState().sendMessage
    sendMsg('/compact', { sessionId })
  }, [sessionId])

  if (used === 0) return null

  return (
    <Pressable className="flex-row items-center gap-1 rounded-md px-1.5 py-1 opacity-40 text-foreground" onPress={handleCompact}>
      <Svg width={16} height={16} viewBox="0 0 16 16">
        <Circle
          cx="8"
          cy="8"
          r={R}
          fill="none"
          stroke="currentColor"
          opacity={0.3}
          strokeWidth={2}
        />
        <Circle
          cx="8"
          cy="8"
          r={R}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - pct)}
          transform="rotate(-90 8 8)"
        />
      </Svg>
      <Text className={cn('text-xs tabular-nums', atLimit && 'text-destructive')}>
        {formatTokens(used)}
      </Text>
    </Pressable>
  )
}
