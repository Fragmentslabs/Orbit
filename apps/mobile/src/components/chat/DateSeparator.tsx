import { View, Text } from 'react-native'
import { useTranslation } from 'react-i18next'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

/** true quando `curr` cai em um dia civil diferente de `prev` (ou é a primeira mensagem). */
export function isNewDay(prev: number | undefined, curr: number): boolean {
  if (prev === undefined) return true
  const a = new Date(prev)
  const b = new Date(curr)
  return a.getFullYear() !== b.getFullYear() || a.getMonth() !== b.getMonth() || a.getDate() !== b.getDate()
}

/** Badge de data estilo WhatsApp: "Hoje" / "Ontem" / data completa. */
export function DateSeparator({ timestamp }: { timestamp: number }) {
  const { t, i18n } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const now = Date.now()
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)

  const isToday = !isNewDay(now, timestamp)
  const isYesterday = !isToday && !isNewDay(yesterday.getTime(), timestamp)

  const label = isToday
    ? t('dateSeparator.today')
    : isYesterday
      ? t('dateSeparator.yesterday')
      : new Date(timestamp).toLocaleDateString(i18n.language, { day: '2-digit', month: '2-digit', year: 'numeric' })

  return (
    <View className="my-2 items-center">
      <View className="rounded-full px-3 py-1" style={{ backgroundColor: tokens.muted }}>
        <Text className="text-[11px] font-medium" style={{ color: tokens.mutedForeground }}>{label}</Text>
      </View>
    </View>
  )
}
