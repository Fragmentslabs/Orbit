import { useMemo } from 'react'
import { View, Text, Pressable } from 'react-native'
import Svg, { Circle } from 'react-native-svg'
import { cn } from '~/lib/utils'
import { useSessionStore } from '~/stores/session-store'
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

  const { accumulated, compacted } = useMemo(() => {
    let lastSummary = -1
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].summary) lastSummary = i
    }
    const slice = messages.slice(lastSummary + 1)
    const acc = slice.reduce(
      (a, m) => {
        if (m.role === 'assistant' && m.tokens) {
          a.input += m.tokens.input
          a.output += m.tokens.output
          a.reasoning += m.tokens.reasoning
          a.cacheRead += m.tokens.cacheRead
          a.cacheWrite += m.tokens.cacheWrite
        }
        return a
      },
      { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    )
    return { accumulated: acc, compacted: lastSummary >= 0 }
  }, [messages])

  const used = sumTokens(accumulated)
  if (used === 0) return null

  const pct = 0
  const atLimit = false

  return (
    <Pressable className="flex-row items-center gap-1 rounded-md px-1.5 py-1 opacity-40 text-foreground">
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
