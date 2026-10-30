import { useMemo } from 'react'
import { View, Text } from 'react-native'
import Svg, { Circle } from 'react-native-svg'
import { useSessionStore } from '~/stores/session-store'
import { useSettingsStore } from '~/stores/settings-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import type { TokenUsage } from '@orbit/shared'

// Same calculation as the desktop context-meter: the usage of the LAST step and the real
// size of the current context. `input`/`output` at the top sum all the steps of the
// turn (inflated by the tool round trips) and only serve as a fallback for
// messages recorded before lastStep existed — that was why the same chat
// showed 72.7K on the desktop and 1.3M here.
function sumTokens(u: TokenUsage): number {
  if (u.lastStep) return (u.lastStep.input ?? 0) + (u.lastStep.output ?? 0)
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
  const { lastTokens } = useMemo(() => {
    const found = [...messages].reverse().find((m) => m.role === 'assistant' && m.tokens)?.tokens
    return { lastTokens: found }
  }, [messages])

  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const catalog = useSettingsStore((s) => s.catalog)
  const selected = useSettingsStore((s) => s.selectedModel)
  const limit = selected && catalog
    ? catalog[selected.providerId]?.models[selected.modelId]?.limit?.context
    : undefined

  const used = lastTokens ? sumTokens(lastTokens) : 0
  const pct = limit && limit > 0 ? used / limit : 0
  const atLimit = pct >= 1

  if (used === 0) return null

  // Indicator, not a button: the desktop counter only informs as well (tooltip).
  // Here it fired /compact on tap — a message send one touch
  // away, which looked like a bug (the chat went into "running" out of nowhere).
  return (
    <View className="flex-row items-center gap-1 rounded-md px-1.5 py-1">
      <Svg width={16} height={16} viewBox="0 0 16 16">
        <Circle
          cx="8"
          cy="8"
          r={R}
          fill="none"
          stroke={tokens.mutedForeground}
          opacity={0.3}
          strokeWidth={2}
        />
        <Circle
          cx="8"
          cy="8"
          r={R}
          fill="none"
          stroke={atLimit ? tokens.destructive : tokens.primary}
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - pct)}
          transform="rotate(-90 8 8)"
        />
      </Svg>
      <Text
        className="text-xs tabular-nums"
        style={{ color: atLimit ? tokens.destructive : tokens.mutedForeground }}
      >
        {formatTokens(used)}
      </Text>
    </View>
  )
}
