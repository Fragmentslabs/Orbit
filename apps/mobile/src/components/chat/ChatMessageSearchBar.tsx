import { useEffect, useMemo, useState } from 'react'
import { View, Text, TextInput, Pressable, Modal } from 'react-native'
import { ChevronDown, ChevronUp, Search, X, CalendarDays } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import DateTimePicker from '@expo/ui/community/datetime-picker'
import { normalizeText, type ChatMessage } from '@orbit/shared'
import { messageText } from '~/lib/message-utils'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { useChatSearchStore } from '~/stores/chat-search-store'

interface Props {
  messages: ChatMessage[]
  onJumpToMessage: (id: string) => void
}

export function ChatMessageSearchBar({ messages, onJumpToMessage }: Props) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const close = useChatSearchStore((s) => s.close)
  const [query, setQuery] = useState('')
  const [matchIndex, setMatchIndex] = useState(0)
  const [datePickerOpen, setDatePickerOpen] = useState(false)
  const [pickedDate, setPickedDate] = useState(new Date())

  const matches = useMemo(() => {
    const q = normalizeText(query.trim())
    if (!q) return []
    return messages.filter((m) => !m.summary && normalizeText(messageText(m)).includes(q))
  }, [messages, query])

  useEffect(() => {
    setMatchIndex(0)
  }, [query])

  useEffect(() => {
    const current = matches[matchIndex]
    if (current) onJumpToMessage(current.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches, matchIndex])

  const goNext = () => matches.length > 0 && setMatchIndex((i) => (i + 1) % matches.length)
  const goPrev = () => matches.length > 0 && setMatchIndex((i) => (i - 1 + matches.length) % matches.length)

  const handleDatePicked = (date?: Date) => {
    setDatePickerOpen(false)
    if (!date) return
    const hit = messages.find((m) => {
      const d = new Date(m.createdAt)
      return d.getFullYear() === date.getFullYear() && d.getMonth() === date.getMonth() && d.getDate() === date.getDate()
    })
    if (hit) onJumpToMessage(hit.id)
  }

  return (
    <View className="flex-row items-center gap-2 px-3 py-2" style={{ borderBottomWidth: 1, borderBottomColor: tokens.border, backgroundColor: tokens.background }}>
      <View className="flex-1 flex-row items-center gap-2 rounded-lg px-2.5 py-1.5" style={{ backgroundColor: tokens.muted }}>
        <Search size={14} color={tokens.mutedForeground} />
        <TextInput
          autoFocus
          value={query}
          onChangeText={setQuery}
          placeholder={t('chatSearch.placeholder')}
          placeholderTextColor={tokens.mutedForeground}
          style={{ flex: 1, fontSize: 14, color: tokens.foreground, paddingVertical: 2 }}
          returnKeyType="search"
          onSubmitEditing={goNext}
        />
        {query.trim().length > 0 && (
          <Text className="text-xs" style={{ color: tokens.mutedForeground }}>
            {matches.length === 0 ? t('chatSearch.noMatches') : t('chatSearch.of', { current: matchIndex + 1, total: matches.length })}
          </Text>
        )}
      </View>
      <Pressable onPress={goPrev} disabled={matches.length === 0} hitSlop={6} style={{ opacity: matches.length === 0 ? 0.4 : 1 }}>
        <ChevronUp size={18} color={tokens.foreground} />
      </Pressable>
      <Pressable onPress={goNext} disabled={matches.length === 0} hitSlop={6} style={{ opacity: matches.length === 0 ? 0.4 : 1 }}>
        <ChevronDown size={18} color={tokens.foreground} />
      </Pressable>
      <Pressable onPress={() => setDatePickerOpen(true)} hitSlop={6}>
        <CalendarDays size={18} color={tokens.mutedForeground} />
      </Pressable>
      <Pressable onPress={close} hitSlop={6}>
        <X size={18} color={tokens.mutedForeground} />
      </Pressable>

      <Modal visible={datePickerOpen} transparent animationType="fade" onRequestClose={() => setDatePickerOpen(false)}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' }} onPress={() => setDatePickerOpen(false)}>
          <Pressable
            style={{ marginTop: 'auto', marginBottom: 'auto', alignSelf: 'center', borderRadius: 16, padding: 16, backgroundColor: tokens.card }}
            onPress={(e) => e.stopPropagation()}
          >
            <Text className="mb-2 text-center text-sm font-medium" style={{ color: tokens.foreground }}>{t('chatSearch.dateFilter')}</Text>
            <DateTimePicker
              value={pickedDate}
              mode="date"
              display="default"
              presentation="dialog"
              onChange={(_event: any, date?: Date) => { if (date) setPickedDate(date); handleDatePicked(date) }}
            />
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  )
}
