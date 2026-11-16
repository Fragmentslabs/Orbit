import { useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, TextInput, Pressable, Modal } from 'react-native'
import { ChevronDown, ChevronUp, Search, X, CalendarDays } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { DateTimePicker } from '@expo/ui/community/datetime-picker'
import type { ChatMessage } from '@orbit/shared'
import { findMatchIds, reconcileIndex, stepIndex } from '~/lib/chat-search'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { useChatSearchStore } from '~/stores/chat-search-store'

interface Props {
  messages: ChatMessage[]
  onJumpToMessage: (id: string) => void
  /** Called when the bar mounts / unmounts — the screen saves and restores the scroll position. */
  onBegin?: () => void
  onEnd?: () => void
}

const DEBOUNCE_MS = 180

export function ChatMessageSearchBar({ messages, onJumpToMessage, onBegin, onEnd }: Props) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const close = useChatSearchStore((s) => s.close)
  const [query, setQuery] = useState('')
  const [matchIndex, setMatchIndex] = useState(0)
  const [datePickerOpen, setDatePickerOpen] = useState(false)
  const [pickedDate, setPickedDate] = useState(new Date())

  const setActive = useChatSearchStore((s) => s.setActive)
  // Typing only updates `query`; the scan over the conversation runs on the debounced value.
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const id = setTimeout(() => setDebounced(query), query.trim() ? DEBOUNCE_MS : 0)
    return () => clearTimeout(id)
  }, [query])

  const matches = useMemo(() => findMatchIds(messages, debounced), [messages, debounced])

  const activeIdRef = useRef<string | undefined>(undefined)
  const reconciledQueryRef = useRef(debounced)
  // A new query restarts at the first result; a growing conversation keeps the same message.
  const [lastDebounced, setLastDebounced] = useState(debounced)
  if (debounced !== lastDebounced) {
    setLastDebounced(debounced)
    setMatchIndex(0)
  }
  const safeIndex = matches.length === 0 ? 0 : Math.min(matchIndex, matches.length - 1)
  const currentId = matches[safeIndex]
  const term = debounced.trim()

  useEffect(() => {
    onBegin?.()
    return () => onEnd?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    // Streaming adds messages: realign the index so it keeps pointing at the same one.
    if (reconciledQueryRef.current !== debounced) {
      reconciledQueryRef.current = debounced
      return
    }
    if (activeIdRef.current && matches[matchIndex] !== activeIdRef.current) {
      const next = reconcileIndex(activeIdRef.current, matches)
      if (next !== matchIndex) setMatchIndex(next)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches])

  useEffect(() => {
    setActive(currentId ?? null, currentId ? term : '')
    if (currentId) onJumpToMessage(currentId)
    activeIdRef.current = currentId
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, term])

  // Stepping onto the same message from the same index is impossible, but with a single
  // result the buttons still re-center it.
  const goNext = () => {
    if (matches.length === 0) return
    setMatchIndex(stepIndex(safeIndex, 1, matches.length))
    if (matches.length === 1 && currentId) onJumpToMessage(currentId)
  }
  const goPrev = () => {
    if (matches.length === 0) return
    setMatchIndex(stepIndex(safeIndex, -1, matches.length))
    if (matches.length === 1 && currentId) onJumpToMessage(currentId)
  }

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
          submitBehavior="submit"
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
        />
        {query.trim().length > 0 && (
          <Text className="text-xs" style={{ color: tokens.mutedForeground }}>
            {matches.length === 0 ? (debounced === query ? t('chatSearch.noMatches') : '…') : t('chatSearch.of', { current: safeIndex + 1, total: matches.length })}
          </Text>
        )}
      </View>
      <Pressable accessibilityLabel={t('chatSearch.previousMatch')} onPress={goPrev} disabled={matches.length === 0} hitSlop={6} style={{ opacity: matches.length === 0 ? 0.4 : 1 }}>
        <ChevronUp size={18} color={tokens.foreground} />
      </Pressable>
      <Pressable accessibilityLabel={t('chatSearch.nextMatch')} onPress={goNext} disabled={matches.length === 0} hitSlop={6} style={{ opacity: matches.length === 0 ? 0.4 : 1 }}>
        <ChevronDown size={18} color={tokens.foreground} />
      </Pressable>
      <Pressable onPress={() => setDatePickerOpen(true)} hitSlop={6}>
        <CalendarDays size={18} color={tokens.mutedForeground} />
      </Pressable>
      <Pressable accessibilityLabel={t('chatSearch.close')} onPress={close} hitSlop={6}>
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
