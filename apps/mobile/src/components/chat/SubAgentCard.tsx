import { View, Text } from 'react-native'
import { Bot, XCircle } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { parseSubagentOutput, type ToolPart } from '@orbit/shared'
import { Shimmer } from '~/components/ai/Shimmer'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

export function SubAgentCard({ part }: { part: ToolPart }) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const task = typeof part.input?.task === 'string' ? part.input.task : t('subAgentCard.defaultTask')
  // O resultado é texto para o modelo: o aviso de "sem pasta" e o vazio viram i18n.
  const result = part.output ? parseSubagentOutput(part.output) : null

  return (
    <View
      className="my-1.5 w-full rounded-lg px-3 py-2"
      style={{
        borderWidth: 1,
        borderColor: tokens.border,
        backgroundColor: tokens.muted,
      }}
    >
      <View className="flex-row items-center gap-2">
        {part.state === 'error' ? (
          <XCircle size={14} color={tokens.destructive} />
        ) : (
          <Bot size={14} color={tokens.mutedForeground} />
        )}
        <Text
          className="flex-1 truncate text-xs font-medium"
          style={{ color: tokens.foreground }}
          numberOfLines={1}
        >
          {task}
        </Text>
      </View>
      {part.state === 'running' && (
        <Shimmer className="mt-1.5">{t('subAgentCard.runningBackground')}</Shimmer>
      )}
      {part.state === 'error' && part.error && (
        <Text className="mt-1.5 text-xs" style={{ color: tokens.destructive }}>
          {part.error}
        </Text>
      )}
      {part.state === 'done' && result?.noFolder && (
        <Text className="mt-1.5 text-xs italic" style={{ color: tokens.mutedForeground }}>
          {t('subAgentCard.noFolder')}
        </Text>
      )}
      {part.state === 'done' && result && (result.empty || result.text) ? (
        <Text
          className="mt-1.5 max-h-48 text-xs"
          style={{ color: tokens.mutedForeground }}
          numberOfLines={12}
        >
          {result.empty ? t('subAgentCard.empty') : result.text}
        </Text>
      ) : null}
    </View>
  )
}
