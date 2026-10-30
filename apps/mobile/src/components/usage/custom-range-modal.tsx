import { Component, useState, type ComponentType, type ReactNode } from 'react'
import { View, Text, Pressable, Modal, Platform, TextInput, StyleSheet } from 'react-native'
import type { DateTimePickerEvent } from '@react-native-community/datetimepicker'
import { CalendarDays } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { CustomAnalyticsRange } from '@orbit/shared'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

// The datetimepicker package calls TurboModuleRegistry.getEnforcing on module
// load and THROWS in binaries without the native module (outdated build / old Expo
// Go). That is why the require is lazy and guarded: a static import
// would take this route down at load time (default export never registered). With
// the module missing, the UI falls back to the manual fallback (ManualDateField).
const NativePicker: ComponentType<any> | null = (() => {
  try {
    // Conditional loading of an optional module: a static import does not
    // work here (the module may not exist at runtime — Expo Go, web,
    // build without the native part) and that is exactly why the require is
    // inside the try/if.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@react-native-community/datetimepicker').default
  } catch {
    return null
  }
})()

/**
 * Custom period selection of the usage screen — mirror of the desktop date range
 * picker. iOS: native inline calendar inside the modal; Android:
 * native dialog per field (From/To). Binaries without the native module fall back
 * to the manual fallback (DD/MM/YYYY fields).
 */

const DAY_MS = 24 * 60 * 60 * 1000

function startOfDay(d: Date): Date {
  const c = new Date(d)
  c.setHours(0, 0, 0, 0)
  return c
}

function endOfDay(d: Date): Date {
  const c = new Date(d)
  c.setHours(23, 59, 59, 999)
  return c
}

export function formatShortDate(d: Date, locale: string): string {
  return d.toLocaleDateString(locale, { day: '2-digit', month: 'short', year: 'numeric' })
}

/** "01 Aug – 10 Aug" — label of the chip when the custom period is active. */
export function rangeLabel(range: CustomAnalyticsRange, locale: string): string {
  return `${formatShortDate(new Date(range.from), locale)} – ${formatShortDate(new Date(range.to), locale)}`
}

/** Manual fallback: digits only DD/MM/YYYY, for builds without the native module. */
function ManualDateField({
  value,
  locale,
  onChange,
}: {
  value: Date
  locale: string
  onChange: (d: Date) => void
}) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const text = value.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' })
  return (
    <TextInput
      value={text}
      keyboardType="numeric"
      onChangeText={(v) => {
        const m = v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
        if (!m) return
        const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]))
        if (!Number.isNaN(d.getTime())) onChange(d)
      }}
      style={[s.inputManual, { borderColor: tokens.border, color: tokens.foreground }]}
    />
  )
}

/** Boundary: if the datetimepicker throws (native module missing), use the manual one. */
class NativeErrorBoundary extends Component<{ fallback: ReactNode; onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch() {
    this.props.onError()
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

export function CustomRangeModal({
  visible,
  currentValue,
  onCancel,
  onConfirm,
}: {
  visible: boolean
  currentValue: CustomAnalyticsRange | null
  onCancel: () => void
  onConfirm: (range: CustomAnalyticsRange) => void
}) {
  const { t, i18n } = useTranslation()
  const theme = useThemeStore((s) => s.resolved)
  const tokens = getThemeTokens(theme)
  const [from, setFrom] = useState(() => (currentValue ? new Date(currentValue.from) : new Date(Date.now() - 6 * DAY_MS)))
  const [to, setTo] = useState(() => (currentValue ? new Date(currentValue.to) : new Date()))
  const [field, setField] = useState<'from' | 'to'>('from')
  const [openField, setOpenField] = useState<'from' | 'to' | null>(null)
  const [nativeMode, setNativeMode] = useState(!!NativePicker)

  const fieldValue = field === 'from' ? from : to
  const setFieldValue = field === 'from' ? setFrom : setTo

  const confirm = () => {
    let start = startOfDay(from)
    let end = endOfDay(to)
    // Inverted selection (to before from) — inverts it, as in the desktop picker.
    if (end.getTime() < start.getTime()) {
      const swapped = start
      start = startOfDay(to)
      end = endOfDay(swapped)
    }
    onConfirm({ type: 'custom', from: start.getTime(), to: end.getTime() })
  }

  const chipStyle = (active: boolean) => ({
    borderColor: active ? tokens.primary : tokens.border,
    backgroundColor: active ? tokens.background : tokens.muted,
  })

  const nativeSelector = NativePicker ? (
    <NativePicker
      mode="date"
      display={Platform.OS === 'ios' ? 'inline' : 'default'}
      value={fieldValue}
      maximumDate={new Date()}
      locale={i18n.language}
      themeVariant={theme === 'dark' ? 'dark' : 'light'}
      onChange={(event: DateTimePickerEvent, date?: Date) => {
        if (Platform.OS === 'android') {
          setOpenField(null)
          if (event.type === 'set' && date) setFieldValue(date)
        } else if (date) {
          setFieldValue(date)
        }
      }}
    />
  ) : null

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onCancel}>
      <Pressable style={s.backdrop} onPress={onCancel} accessibilityLabel={t('scheduleSheet.cancel')}>
        <View style={[s.box, { backgroundColor: tokens.card }]}>
          <Text style={[s.heading, { color: tokens.foreground }]}>{t('usageScreen.rangeCustom')}</Text>

          <View style={s.fieldsRow}>
            {(['from', 'to'] as const).map((c) => (
              <Pressable
                key={c}
                onPress={() => {
                  setField(c)
                  setOpenField(c)
                }}
                style={[s.fieldChip, chipStyle(field === c)]}
              >
                <CalendarDays size={14} color={field === c ? tokens.primary : tokens.mutedForeground} />
                <Text style={[s.fieldLabel, { color: field === c ? tokens.primary : tokens.mutedForeground }]}>
                  {t(c === 'from' ? 'usageScreen.customFrom' : 'usageScreen.customTo')}
                </Text>
                <Text style={[s.fieldValueText, { color: tokens.foreground }]}>
                  {formatShortDate(c === 'from' ? from : to, i18n.language)}
                </Text>
              </Pressable>
            ))}
          </View>

          <View style={s.selectorWrap}>
            {Platform.OS === 'android' ? (
              openField ? (
                <NativeErrorBoundary
                  fallback={<ManualDateField value={fieldValue} locale={i18n.language} onChange={setFieldValue} />}
                  onError={() => setNativeMode(false)}
                >
                  {nativeSelector}
                </NativeErrorBoundary>
              ) : (
                <Text style={[s.hint, { color: tokens.mutedForeground }]}>{t('usageScreen.customHint')}</Text>
              )
            ) : nativeMode ? (
              <NativeErrorBoundary
                fallback={<ManualDateField value={fieldValue} locale={i18n.language} onChange={setFieldValue} />}
                onError={() => setNativeMode(false)}
              >
                {nativeSelector}
              </NativeErrorBoundary>
            ) : (
              <ManualDateField value={fieldValue} locale={i18n.language} onChange={setFieldValue} />
            )}
          </View>

          <View style={[s.footer, { borderTopColor: tokens.border }]}>
            <Pressable onPress={onCancel} style={s.button} hitSlop={4}>
              <Text style={{ color: tokens.primary, fontSize: 16 }}>{t('scheduleSheet.cancel')}</Text>
            </Pressable>
            <View style={[s.divider, { backgroundColor: tokens.border }]} />
            <Pressable onPress={confirm} style={s.button} hitSlop={4}>
              <Text style={{ color: tokens.primary, fontSize: 16, fontWeight: '600' }}>{t('scheduleSheet.ok')}</Text>
            </Pressable>
          </View>
        </View>
      </Pressable>
    </Modal>
  )
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
    padding: 24,
  },
  box: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 16,
    paddingTop: 18,
    alignItems: 'center',
    overflow: 'hidden',
  },
  heading: { fontSize: 16, fontWeight: '600', marginBottom: 14 },
  fieldsRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, width: '100%' },
  fieldChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  fieldLabel: { fontSize: 12, fontWeight: '600' },
  fieldValueText: { fontSize: 12, marginLeft: 'auto' },
  selectorWrap: { alignItems: 'center', paddingHorizontal: 16, marginTop: 8, minHeight: 60 },
  hint: { fontSize: 12, paddingVertical: 20 },
  inputManual: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    fontFamily: 'monospace',
    minWidth: 140,
    textAlign: 'center',
    marginTop: 8,
  },
  footer: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: 12,
    alignSelf: 'stretch',
  },
  button: { flex: 1, alignItems: 'center', paddingVertical: 14 },
  divider: { width: StyleSheet.hairlineWidth, alignSelf: 'stretch' },
})
