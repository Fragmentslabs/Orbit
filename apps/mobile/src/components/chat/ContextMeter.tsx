import { useMemo } from 'react'
import { View, Text } from 'react-native'
import Svg, { Circle } from 'react-native-svg'
import { useSessionStore } from '~/stores/session-store'
import { useSettingsStore } from '~/stores/settings-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import type { TokenUsage } from '@orbit/shared'

// Mesma conta do context-meter do desktop: o usage do ULTIMO step e o tamanho
// real do contexto atual. `input`/`output` no topo somam todos os steps do
// turno (inflados pelas idas-e-vindas de tool) e so servem de fallback para
// mensagens gravadas antes de lastStep existir — era por isso que o mesmo chat
// mostrava 72,7K no desktop e 1,3M aqui.
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
  const { lastTokens, compacted } = useMemo(() => {
    let lastSummary = -1
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].summary) lastSummary = i
    }
    const found = [...messages].reverse().find((m) => m.role === 'assistant' && m.tokens)?.tokens
    return { lastTokens: found, compacted: lastSummary >= 0 }
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

  // Indicador, nao botao: o contador do desktop tambem so informa (tooltip).
  // Aqui ele disparava /compact no toque — um envio de mensagem a um toque de
  // distancia, que parecia bug (o chat entrava em "rodando" do nada).
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
