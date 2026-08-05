import { useState, useMemo } from 'react'
import { View, Text, Pressable, LayoutAnimation, Platform, UIManager } from 'react-native'
import { CalendarIcon, ListPlus, ChevronDown } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { useMessageQueueStore } from '~/stores/message-queue-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { formatTime } from '~/lib/format-time'
import { useThemeStore } from '~/stores/theme-store'

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true)
}

interface QueueIndicatorProps {
  sessionId?: string
}

function formatSchedule(ts: number, locale: string): string {
  const now = Date.now()
  const diff = ts - now
  if (diff < 0) return 'Agora'
  if (diff < 60_000) return 'Em segundos'
  if (diff < 3_600_000) return `Em ${Math.ceil(diff / 60_000)}min`
  if (diff < 86_400_000) return `Em ${Math.ceil(diff / 3_600_000)}h`
  const date = new Date(ts).toLocaleDateString(locale, { dateStyle: 'short' })
  return `${date} ${formatTime(ts, locale)}`
}

export function QueueIndicator({ sessionId }: QueueIndicatorProps) {
  const { i18n } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const queues = useMessageQueueStore((s) => s.queues)
  const [expanded, setExpanded] = useState(false)
  const items = sessionId ? queues[sessionId] : undefined

  const toggle = useMemo(() => {
    if (!items || items.length === 0) return null
    const queueCount = items.filter((m) => !m.scheduledAt).length
    const scheduledCount = items.filter((m) => m.scheduledAt).length
    return { queueCount, scheduledCount, total: items.length }
  }, [items])

  const handleToggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
    setExpanded((prev) => !prev)
  }

  if (!toggle) return null

  return (
    <View className="rounded-lg overflow-hidden" style={{ borderWidth: 1, borderColor: tokens.border, backgroundColor: tokens.muted }}>
      <Pressable
        onPress={handleToggle}
        className="flex-row items-center gap-2 px-3 py-2"
      >
        <View className="flex-row items-center gap-1.5 flex-1">
          {toggle.queueCount > 0 && <ListPlus size={14} color={tokens.mutedForeground} />}
          {toggle.scheduledCount > 0 && <CalendarIcon size={14} color={tokens.mutedForeground} />}
          <Text className="text-xs" style={{ color: tokens.mutedForeground }}>
            {toggle.total} {toggle.total === 1 ? 'mensagem' : 'mensagens'} na fila
          </Text>
        </View>
        <ChevronDown
          size={14}
          color={tokens.mutedForeground}
          style={{ transform: expanded ? [{ rotate: '0deg' }] : [{ rotate: '-90deg' }] }}
        />
      </Pressable>
      {expanded && (
        <View className="px-2 pb-1 gap-0.5">
          {items!.map((msg) => (
            <View
              key={msg.id}
              className="flex-row items-center gap-2 rounded-md px-3 py-1.5"
            >
              {msg.scheduledAt ? (
                <CalendarIcon size={13} color={tokens.mutedForeground} />
              ) : (
                <ListPlus size={13} color={tokens.mutedForeground} />
              )}
              <Text
                className="text-xs flex-1"
                numberOfLines={1}
                style={{ color: tokens.mutedForeground }}
              >
                {msg.text}
              </Text>
              <Text className="text-[10px]" style={{ color: tokens.mutedForeground, opacity: 0.6 }}>
                {msg.scheduledAt ? formatSchedule(msg.scheduledAt, i18n.language) : 'Fila'}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  )
}
