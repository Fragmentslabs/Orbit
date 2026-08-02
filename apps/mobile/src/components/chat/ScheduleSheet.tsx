import { useEffect, useRef, useState } from 'react'
import { View, Text, Pressable, Animated, Modal, StyleSheet, Dimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import DateTimePicker from '@expo/ui/community/datetime-picker'
import { CalendarIcon, Clock, ChevronDown } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

interface SchedulePreset {
  label: string
  getTimestamp: () => number
}

function usePresets(): SchedulePreset[] {
  const { t } = useTranslation()
  return [
    { label: t('scheduleSheet.presetIn30Min'), getTimestamp: () => Date.now() + 30 * 60 * 1000 },
    { label: t('scheduleSheet.presetIn1Hour'), getTimestamp: () => Date.now() + 60 * 60 * 1000 },
    { label: t('scheduleSheet.presetIn2Hours'), getTimestamp: () => Date.now() + 2 * 60 * 60 * 1000 },
    { label: t('scheduleSheet.presetTomorrow9am'), getTimestamp: () => {
      const d = new Date()
      d.setDate(d.getDate() + 1)
      d.setHours(9, 0, 0, 0)
      return d.getTime()
    }},
  ]
}

function formatDate(ts: number, locale: string): string {
  return new Date(ts).toLocaleString(locale, {
    dateStyle: 'full',
    timeStyle: 'short',
  })
}

function formatDateShort(d: Date, locale: string): string {
  return d.toLocaleDateString(locale)
}

function formatTimeShort(d: Date, locale: string): string {
  return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
}

interface ScheduleSheetProps {
  visible: boolean
  onClose: () => void
  onConfirm: (timestamp: number) => void
}

const SHEET_HEIGHT = Math.min(Dimensions.get('window').height * 0.72, 560)

export function ScheduleSheet({ visible, onClose, onConfirm }: ScheduleSheetProps) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language
  const PRESETS = usePresets()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const insets = useSafeAreaInsets()
  const [slideAnim] = useState(() => new Animated.Value(SHEET_HEIGHT))
  const [backdropAnim] = useState(() => new Animated.Value(0))

  const [selectedDate, setSelectedDate] = useState(new Date(Date.now() + 30 * 60 * 1000))
  const [selectedPreset, setSelectedPreset] = useState<number | null>(null)
  const [customExpanded, setCustomExpanded] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)

  const [pickerTarget, setPickerTarget] = useState<'date' | 'time' | null>(null)

  useEffect(() => {
    Animated.parallel([
      Animated.timing(slideAnim, {
        toValue: visible ? 0 : SHEET_HEIGHT,
        duration: 250,
        useNativeDriver: true,
      }),
      Animated.timing(backdropAnim, {
        toValue: visible ? 1 : 0,
        duration: 250,
        useNativeDriver: true,
      }),
    ]).start()

    if (visible) {
      const defaultDate = new Date(Date.now() + 30 * 60 * 1000)
      setSelectedDate(defaultDate)
      setSelectedPreset(0)
      setCustomExpanded(false)
      setPickerTarget(null)
      setPreview(formatDate(defaultDate.getTime(), locale))
    }
  }, [visible, slideAnim, backdropAnim])

  useEffect(() => {
    if (customExpanded) {
      setPreview(formatDate(selectedDate.getTime(), locale))
    }
  }, [selectedDate, customExpanded])

  const handlePreset = (preset: SchedulePreset, idx: number) => {
    const ts = preset.getTimestamp()
    setSelectedPreset(idx)
    setCustomExpanded(false)
    setPickerTarget(null)
    setSelectedDate(new Date(ts))
    setPreview(formatDate(ts, locale))
  }

  const toggleCustom = () => {
    const willExpand = !customExpanded
    setCustomExpanded(willExpand)
    if (willExpand) {
      setSelectedPreset(null)
      setPreview(formatDate(selectedDate.getTime(), locale))
    } else {
      setPickerTarget(null)
    }
  }

  const openPicker = (target: 'date' | 'time') => {
    setSelectedPreset(null)
    setCustomExpanded(true)
    setPickerTarget(target)
  }

  const handlePickerDone = (date?: Date) => {
    if (date) setSelectedDate(date)
    setPickerTarget(null)
  }

  const handleConfirm = () => {
    if (!preview) return
    let ts: number
    if (selectedPreset !== null && !customExpanded) {
      ts = PRESETS[selectedPreset].getTimestamp()
    } else {
      ts = selectedDate.getTime()
    }
    onConfirm(ts)
    onClose()
  }

  const canConfirm = preview !== null && selectedDate.getTime() > Date.now()

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <Animated.View style={[s.backdrop, { opacity: backdropAnim }]}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
      </Animated.View>

      <Animated.View
        style={[
          s.sheet,
          {
            paddingBottom: insets.bottom + 12,
            transform: [{ translateY: slideAnim }],
            backgroundColor: tokens.card,
            borderColor: tokens.border,
          },
        ]}
      >
        <View style={[s.handle, { backgroundColor: tokens.muted }]} />

        <View style={[s.header, { borderBottomColor: tokens.border }]}>
          <CalendarIcon size={18} color={tokens.foreground} />
          <Text style={[s.title, { color: tokens.foreground }]}>{t('scheduleSheet.title')}</Text>
        </View>

        <View style={s.presetsRow}>
          {PRESETS.map((preset, idx) => (
            <Pressable
              key={preset.label}
              onPress={() => handlePreset(preset, idx)}
              style={[
                s.presetChip,
                {
                  backgroundColor: selectedPreset === idx && !customExpanded ? tokens.primary : tokens.border,
                  borderColor: selectedPreset === idx && !customExpanded ? tokens.primary : 'transparent',
                },
              ]}
            >
              <Clock size={14} color={selectedPreset === idx && !customExpanded ? tokens.primaryForeground : tokens.mutedForeground} />
              <Text
                style={[
                  s.presetLabel,
                  { color: selectedPreset === idx && !customExpanded ? tokens.primaryForeground : tokens.foreground },
                ]}
              >
                {preset.label}
              </Text>
            </Pressable>
          ))}
        </View>

        <Pressable
          onPress={toggleCustom}
          style={[s.customToggle, { borderBottomColor: tokens.border, backgroundColor: customExpanded ? tokens.muted : 'transparent' }]}
        >
          <Text style={[s.customToggleText, { color: customExpanded ? tokens.foreground : tokens.mutedForeground }]}>
            {t('scheduleSheet.custom')}
          </Text>
          <ChevronDown
            size={16}
            color={customExpanded ? tokens.foreground : tokens.mutedForeground}
            style={{ transform: customExpanded ? [{ rotate: '180deg' }] : [{ rotate: '0deg' }] }}
          />
        </Pressable>

        {customExpanded && (
          <View style={s.customFields}>
            <Pressable onPress={() => openPicker('date')} style={[s.fieldRow, { backgroundColor: tokens.border }]}>
              <CalendarIcon size={18} color={tokens.mutedForeground} />
              <Text style={[s.fieldLabel, { color: tokens.mutedForeground }]}>{t('scheduleSheet.date')}</Text>
              <Text style={[s.fieldValue, { color: tokens.foreground }]}>{formatDateShort(selectedDate, locale)}</Text>
            </Pressable>

            <Pressable onPress={() => openPicker('time')} style={[s.fieldRow, { backgroundColor: tokens.border }]}>
              <Clock size={18} color={tokens.mutedForeground} />
              <Text style={[s.fieldLabel, { color: tokens.mutedForeground }]}>{t('scheduleSheet.time')}</Text>
              <Text style={[s.fieldValue, { color: tokens.foreground }]}>{formatTimeShort(selectedDate, locale)}</Text>
            </Pressable>
          </View>
        )}

        {preview && (
          <Text style={[s.preview, { color: tokens.mutedForeground }]}>
            {t('scheduleSheet.willSendAt')} <Text style={[s.previewHighlight, { color: tokens.foreground }]}>{preview}</Text>
          </Text>
        )}

        <View style={[s.actions, { borderTopColor: tokens.border }]}>
          <Pressable onPress={onClose} style={[s.actionBtn, { borderColor: tokens.border }]}>
            <Text style={[s.actionLabel, { color: tokens.foreground }]}>{t('scheduleSheet.cancel')}</Text>
          </Pressable>
          <Pressable
            onPress={handleConfirm}
            disabled={!canConfirm}
            style={[s.actionBtn, { backgroundColor: canConfirm ? tokens.primary : tokens.muted, opacity: canConfirm ? 1 : 0.5 }]}
          >
            <Text style={[s.actionLabel, { color: tokens.primaryForeground, fontWeight: '600' }]}>{t('scheduleSheet.confirm')}</Text>
          </Pressable>
        </View>
      </Animated.View>

      {/* Mini-modal para picker de data */}
      <Modal visible={pickerTarget === 'date'} transparent animationType="fade" onRequestClose={() => setPickerTarget(null)}>
        <View style={s.pickerOverlay}>
          <View style={[s.pickerModal, { backgroundColor: tokens.card }]}>
            <DateTimePicker
              value={selectedDate}
              mode="date"
              display="default"
              presentation="dialog"
              onChange={(_event: any, date?: Date) => handlePickerDone(date)}
            />
            <Pressable onPress={() => setPickerTarget(null)} style={[s.pickerDone, { borderTopColor: tokens.border }]}>
              <Text style={[s.pickerDoneText, { color: tokens.primary }]}>{t('scheduleSheet.ok')}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Mini-modal para picker de horário */}
      <Modal visible={pickerTarget === 'time'} transparent animationType="fade" onRequestClose={() => setPickerTarget(null)}>
        <View style={s.pickerOverlay}>
          <View style={[s.pickerModal, { backgroundColor: tokens.card }]}>
            <DateTimePicker
              value={selectedDate}
              mode="time"
              display="default"
              presentation="dialog"
              onChange={(_event: any, date?: Date) => handlePickerDone(date)}
            />
            <Pressable onPress={() => setPickerTarget(null)} style={[s.pickerDone, { borderTopColor: tokens.border }]}>
              <Text style={[s.pickerDoneText, { color: tokens.primary }]}>{t('scheduleSheet.ok')}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </Modal>
  )
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    paddingTop: 10,
    paddingHorizontal: 16,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    marginBottom: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingBottom: 12,
    borderBottomWidth: 1,
    marginBottom: 12,
  },
  title: { fontSize: 16, fontWeight: '600' },
  presetsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  presetChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
  },
  presetLabel: { fontSize: 13, fontWeight: '500' },
  customToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderBottomWidth: 1,
    marginBottom: 8,
  },
  customToggleText: { fontSize: 14, fontWeight: '500' },
  customFields: { gap: 8, marginBottom: 12 },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
  },
  fieldLabel: { fontSize: 14, flex: 1 },
  fieldValue: { fontSize: 14, fontWeight: '600' },
  preview: {
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 12,
  },
  previewHighlight: { fontWeight: '600' },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    paddingTop: 12,
    borderTopWidth: 1,
  },
  actionBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  actionLabel: { fontSize: 14 },
  pickerOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  pickerModal: {
    borderRadius: 16,
    padding: 20,
    width: '85%',
    alignItems: 'center',
  },
  pickerDone: {
    marginTop: 12,
    paddingVertical: 10,
    paddingHorizontal: 32,
    borderTopWidth: 1,
    width: '100%',
    alignItems: 'center',
  },
  pickerDoneText: { fontSize: 16, fontWeight: '600' },
})
