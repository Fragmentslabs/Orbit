import { View, Text } from 'react-native'
import { Bot, XCircle } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { ToolPart } from '@orbit/shared'
import { Shimmer } from '~/components/ai/Shimmer'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

export function SubAgentCard({ part }: { part: ToolPart }) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const task = typeof part.input?.task === 'string' ? part.input.task : t('subAgentCard.defaultTask')

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
      {part.state === 'done' && part.output && (
        <Text
          className="mt-1.5 max-h-48 text-xs"
          style={{ color: tokens.mutedForeground }}
          numberOfLines={12}
        >
          {part.output}
        </Text>
      )}
    </View>
  )
}
