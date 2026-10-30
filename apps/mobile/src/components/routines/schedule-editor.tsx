import { Component, useState, type ComponentType, type ReactNode } from 'react'
import { View, Text, Pressable, TextInput, StyleSheet, Modal, Platform } from 'react-native'
import type { DateTimePickerEvent } from '@react-native-community/datetimepicker'
import { useTranslation } from 'react-i18next'
import {
  AlignLeft,
  Bot,
  BrainCircuit,
  Eye,
  FileText,
  Globe,
  Network,
  RefreshCw,
  Search,
} from 'lucide-react-native'
import type { PermissionMode, RoutineModes, Schedule } from '@orbit/shared'
import { DEFAULT_ROUTINE_PERMISSION, parseTime, ROUTINE_MODES, ROUTINE_PERMISSIONS } from '@orbit/shared'
import { Switch } from '~/components/ui/switch'
import { getThemeTokens, type ThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { hslToRgba } from '~/lib/theme'
import { describeSchedule, scheduleMode, shortDays, type ScheduleMode } from '~/lib/schedule'

// The datetimepicker package calls TurboModuleRegistry.getEnforcing while the
// module loads and THROWS on binaries without the native module (outdated
// build / old Expo Go). That is why the require is lazy and guarded: a static
// import would break the route on load (default export never registered). With
// the module missing, the UI falls back to the manual picker
// (ManualTimePicker).
const NativePicker: ComponentType<any> | null = (() => {
  try {
    // Conditional load of an optional module: a static import does not work
    // here (the module may not exist at runtime — Expo Go, web, a build without
    // the native one) and that is exactly why the require sits inside the
    // try/if.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@react-native-community/datetimepicker').default
  } catch {
    return null
  }
})()

/**
 * Schedule and mode editing — shared by creating and editing an existing
 * routine. Mirror of the desktop's schedule-editor.tsx: presets + fine tuning,
 * no cron.
 */

const WEEKDAYS = [1, 2, 3, 4, 5]
const WEEKEND = [0, 6]

/** Today as "YYYY-MM-DD" (local time) — default for the "once" mode. */
function todayIso(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** "YYYY-MM-DD" → Date at noon (midnight crosses timezones/DST). */
function dateFromIso(date: string): Date {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day, 12, 0, 0, 0)
}

/** Date → local "YYYY-MM-DD". */
function toIsoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** "YYYY-MM-DD" → "DD/MM/YYYY" for the chip. */
function formatDateShort(date: string): string {
  const [year, month, day] = date.split('-')
  return `${day}/${month}/${year}`
}

/**
 * Centered time-selection modal — structure shared by the native picker and by
 * the manual fallback: dark overlay (tapping outside closes without applying),
 * a view with muted background and rounded corners, the control in the center
 * and Cancel/OK in the modal's own footer.
 */
function TimeDialog({
  onCancel,
  onOk,
  children,
}: {
  onCancel: () => void
  onOk: () => void
  children: ReactNode
}) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  return (
    <Modal visible animationType="fade" transparent onRequestClose={onCancel}>
      <Pressable style={s.modalBackdrop} onPress={onCancel} accessibilityLabel={t('scheduleSheet.cancel')}>
        <View style={[s.modalBox, { backgroundColor: tokens.muted }]}>
          <Text style={[s.modalTitle, { color: tokens.foreground }]}>{t('routines.schedule.selectTime')}</Text>
          <View style={s.modalContent}>{children}</View>
          <View style={[s.modalFooter, { borderTopColor: tokens.border }]}>
            <Pressable onPress={onCancel} style={s.modalButton} hitSlop={4}>
              <Text style={{ color: tokens.primary, fontSize: 16 }}>{t('scheduleSheet.cancel')}</Text>
            </Pressable>
            <View style={[s.modalDivider, { backgroundColor: tokens.border }]} />
            <Pressable onPress={onOk} style={s.modalButton} hitSlop={4}>
              <Text style={{ color: tokens.primary, fontSize: 16, fontWeight: '600' }}>{t('scheduleSheet.ok')}</Text>
            </Pressable>
          </View>
        </View>
      </Pressable>
    </Modal>
  )
}

/**
 * Manual time picker (fallback): a full-screen grid of hours and minutes with
 * the same look as the native picker. Only used when the binary lacks the
 * datetimepicker native module (old build / Expo Go) — the normal path is
 * NativeTimePicker.
 */
function ManualTimePicker({
  value,
  onSelect,
  onClose,
}: {
  value: string
  onSelect: (time: string) => void
  onClose: () => void
}) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const initial = parseTime(value)
  const [hour, setHour] = useState(initial?.hour ?? 9)
  const [minute, setMinute] = useState(initial?.minute ?? 0)
  const p = (n: number) => String(n).padStart(2, '0')
  const chip = (selected: boolean) => ({
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'transparent',
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: selected ? tokens.primary : tokens.muted,
  })
  const chipText = (selected: boolean) => ({
    fontSize: 12,
    color: selected ? tokens.primaryForeground : tokens.mutedForeground,
  })
  return (
    <TimeDialog
      onCancel={onClose}
      onOk={() => {
        onSelect(`${p(hour)}:${p(minute)}`)
        onClose()
      }}
    >
      <Text style={{ color: tokens.foreground, fontSize: 28, fontWeight: '700', marginBottom: 16 }}>
        {p(hour)}:{p(minute)}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'center', maxWidth: 280 }}>
        {Array.from({ length: 24 }, (_, h) => (
          <Pressable key={h} onPress={() => setHour(h)} style={chip(h === hour)}>
            <Text style={chipText(h === hour)}>{p(h)}</Text>
          </Pressable>
        ))}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'center', maxWidth: 280, marginTop: 8 }}>
        {Array.from({ length: 12 }, (_, i) => i * 5).map((m) => (
          <Pressable key={m} onPress={() => setMinute(m)} style={chip(m === minute)}>
            <Text style={chipText(m === minute)}>{p(m)}</Text>
          </Pressable>
        ))}
      </View>
    </TimeDialog>
  )
}

/** Primary background with alpha (e.g. primary at 10% — like bg-primary/10). */
function primaryBg(tokens: ThemeTokens, alpha: number): string {
  return hslToRgba(tokens.primary.replace(/hsla?\(|\)/g, '').replace(/,/g, ''), alpha)
}

/** "HH:MM" → Date (today, at the given time) for the native picker. */
function timeToDate(time: string): Date {
  const p = parseTime(time)
  const d = new Date()
  d.setHours(p?.hour ?? 9, p?.minute ?? 0, 0, 0)
  return d
}

function formatTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * Native time picker, opened with a single tap on the time.
 * iOS: centered modal with the native spinner (the system wheels) already
 * open — the system's compact control would need a second tap to open the
 * popover, so we use the modal, which is the iOS default for time. Android:
 * native dialog. Requires the native module in the binary.
 */
function NativeTimePicker({
  value,
  onChange,
  onClose,
}: {
  value: string
  onChange: (time: string) => void
  onClose: () => void
}) {
  const theme = useThemeStore((s) => s.resolved)
  const [draft, setDraft] = useState(() => timeToDate(value))

  // Without the native module the caller (ScheduleEditor) never gets to render
  // this modal — it falls back to ManualTimePicker beforehand.
  if (!NativePicker) return null

  if (Platform.OS === 'android') {
    return (
      <NativePicker
        mode="time"
        value={draft}
        is24Hour
        onChange={(event: DateTimePickerEvent, date?: Date) => {
          if (event.type === 'set' && date) onChange(formatTime(date))
          onClose()
        }}
      />
    )
  }

  return (
    <TimeDialog
      onCancel={onClose}
      onOk={() => {
        onChange(formatTime(draft))
        onClose()
      }}
    >
      {/* The native UIPickerView has a fixed height (216pt) but may draw its
          content offset inside it; the flex container centers the wheels
          vertically in the screen's remaining space. */}
      <NativePicker
        mode="time"
        display="spinner"
        value={draft}
        themeVariant={theme === 'dark' ? 'dark' : 'light'}
        onChange={(event: DateTimePickerEvent, date?: Date) => {
          if (event.type === 'set' && date) setDraft(date)
        }}
      />
    </TimeDialog>
  )
}

/**
 * Boundary for builds without the native module: if the datetimepicker throws
 * (Native module cannot be null), it falls back to the manual picker instead of
 * taking the screen down. After one error, the manual one is used directly.
 */
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

export function ScheduleEditor({ schedule, onChange }: { schedule: Schedule; onChange: (schedule: Schedule) => void }) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const mode = scheduleMode(schedule)
  const names = shortDays(t)
  const timeValid = !!parseTime(schedule.time)
  const [showPicker, setShowPicker] = useState(false)
  const [showDatePicker, setShowDatePicker] = useState(false)
  /** Binary without the native module (old build) → uses the manual picker. */
  const [nativeMode, setNativeMode] = useState(!!NativePicker)
  const closePicker = () => setShowPicker(false)

  const changeMode = (next: ScheduleMode) => {
    if (next === 'daily') onChange({ time: schedule.time })
    else if (next === 'weekly') onChange({ time: schedule.time, days: schedule.days?.length ? schedule.days : WEEKDAYS })
    else if (next === 'intervalHours') onChange({ time: schedule.time, intervalHours: schedule.intervalHours ?? 6 })
    else if (next === 'once') onChange({ time: schedule.time, onceDate: schedule.onceDate ?? todayIso() })
    else onChange({ time: schedule.time, intervalDays: schedule.intervalDays ?? 2 })
  }

  const toggleDay = (day: number) => {
    const current = new Set(schedule.days ?? [])
    if (current.has(day)) current.delete(day)
    else current.add(day)
    // Never leaves the list empty: with no day marked the routine would have no
    // time to run, and the screen would show a schedule that never fires.
    const days = [...current].sort((a, b) => a - b)
    onChange({ time: schedule.time, days: days.length ? days : [day] })
  }

  const activeChip = { borderColor: tokens.primary, backgroundColor: primaryBg(tokens, 0.1) }
  const inactiveChip = { borderColor: 'transparent', backgroundColor: tokens.muted }

  return (
    <View style={{ gap: 10 }}>
      <View style={s.rowWrap}>
        {(['daily', 'weekly', 'intervalDays', 'intervalHours', 'once'] as ScheduleMode[]).map((option) => (
          <Pressable
            key={option}
            onPress={() => changeMode(option)}
            style={[s.chip, mode === option ? activeChip : inactiveChip]}
          >
            <Text style={[s.chipText, { color: mode === option ? tokens.primary : tokens.mutedForeground }]}>
              {t(`routines.schedule.mode.${option}`)}
            </Text>
          </Pressable>
        ))}
        <Text style={[s.timeLabel, { color: tokens.mutedForeground }]}>{t('routines.schedule.time')}</Text>
        {showPicker ? (
          nativeMode ? (
            <NativeErrorBoundary
              fallback={
                <ManualTimePicker
                  value={schedule.time}
                  onSelect={(time) => {
                    onChange({ ...schedule, time })
                    closePicker()
                  }}
                  onClose={closePicker}
                />
              }
              onError={() => setNativeMode(false)}
            >
              <NativeTimePicker
                value={schedule.time}
                onChange={(time) => onChange({ ...schedule, time })}
                onClose={closePicker}
              />
            </NativeErrorBoundary>
          ) : (
            <ManualTimePicker
              value={schedule.time}
              onSelect={(time) => {
                onChange({ ...schedule, time })
                closePicker()
              }}
              onClose={closePicker}
            />
          )
        ) : (
          <Pressable onPress={() => setShowPicker(true)} hitSlop={8}>
            <Text style={[s.timeInput, { color: timeValid ? tokens.foreground : tokens.destructive }]}>
              {schedule.time}
            </Text>
          </Pressable>
        )}
      </View>

      {mode === 'weekly' && (
        <View style={s.rowWrap}>
          {names.map((name, day) => {
            const active = schedule.days?.includes(day) ?? false
            return (
              <Pressable
                key={day}
                onPress={() => toggleDay(day)}
                style={[s.dayChip, active ? activeChip : inactiveChip]}
              >
                <Text style={[s.dayChipText, { color: active ? tokens.primary : tokens.mutedForeground }]}>{name}</Text>
              </Pressable>
            )
          })}
          <Pressable onPress={() => onChange({ time: schedule.time, days: WEEKDAYS })} style={{ paddingHorizontal: 6, paddingVertical: 4 }}>
            <Text style={[s.linkText, { color: tokens.mutedForeground }]}>{t('routines.schedule.workdays')}</Text>
          </Pressable>
          <Pressable onPress={() => onChange({ time: schedule.time, days: WEEKEND })} style={{ paddingHorizontal: 6, paddingVertical: 4 }}>
            <Text style={[s.linkText, { color: tokens.mutedForeground }]}>{t('routines.schedule.weekend')}</Text>
          </Pressable>
        </View>
      )}

      {mode === 'intervalDays' && (
        <View style={s.rowWrap}>
          <Text style={[s.linkText, { color: tokens.mutedForeground }]}>{t('routines.schedule.every')}</Text>
          <TextInput
            value={String(schedule.intervalDays ?? 2)}
            onChangeText={(v) =>
              onChange({
                time: schedule.time,
                intervalDays: Math.max(2, Math.min(365, Number(v) || 2)),
              })
            }
            keyboardType="number-pad"
            style={[s.intervalInput, { borderColor: tokens.border, color: tokens.foreground }]}
          />
          <Text style={[s.linkText, { color: tokens.mutedForeground }]}>{t('routines.schedule.days')}</Text>
        </View>
      )}

      {mode === 'intervalHours' && (
        <View style={s.rowWrap}>
          <Text style={[s.linkText, { color: tokens.mutedForeground }]}>{t('routines.schedule.every')}</Text>
          <TextInput
            value={String(schedule.intervalHours ?? 6)}
            onChangeText={(v) =>
              onChange({
                time: schedule.time,
                intervalHours: Math.max(1, Math.min(23, Number(v) || 6)),
              })
            }
            keyboardType="number-pad"
            style={[s.intervalInput, { borderColor: tokens.border, color: tokens.foreground }]}
          />
          <Text style={[s.linkText, { color: tokens.mutedForeground }]}>{t('routines.schedule.hours')}</Text>
        </View>
      )}

      {mode === 'once' && (
        <View style={{ gap: 6 }}>
          <View style={s.rowWrap}>
            <Text style={[s.linkText, { color: tokens.mutedForeground }]}>{t('routines.schedule.em')}</Text>
            {showDatePicker && NativePicker ? (
              <NativePicker
                mode="date"
                value={dateFromIso(schedule.onceDate ?? todayIso())}
                onChange={(event: DateTimePickerEvent, date?: Date) => {
                  if (event.type === 'set' && date) {
                    onChange({ time: schedule.time, onceDate: toIsoDate(date) })
                  }
                  setShowDatePicker(false)
                }}
              />
            ) : NativePicker ? (
              <Pressable onPress={() => setShowDatePicker(true)} hitSlop={8}>
                <Text style={[s.timeInput, { color: tokens.foreground }]}>
                  {formatDateShort(schedule.onceDate ?? todayIso())}
                </Text>
              </Pressable>
            ) : (
              // Without the native module (old build): a plain text field.
              <TextInput
                value={schedule.onceDate ?? ''}
                onChangeText={(v) => v && onChange({ time: schedule.time, onceDate: v })}
                placeholder={t('routines.schedule.datePlaceholder')}
                placeholderTextColor={tokens.mutedForeground}
                style={[s.intervalInput, { borderColor: tokens.border, color: tokens.foreground, minWidth: 110 }]}
              />
            )}
          </View>
          <Text style={[s.summary, { color: tokens.mutedForeground }]}>{t('routines.schedule.onceHint')}</Text>
        </View>
      )}

      <Text style={[s.summary, { color: tokens.mutedForeground }]}>{describeSchedule(schedule, t)}</Text>
    </View>
  )
}

// ─── Modes ───────────────────────────────────────────────────────────────────

/** Icon of each mode — the same ones as the "active modes" section of the preferences. */
const MODE_ICON: Record<(typeof ROUTINE_MODES)[number], typeof Bot> = {
  brain: BrainCircuit,
  loop: RefreshCw,
  subagents: Bot,
  orchestrate: Network,
  browser: Globe,
  plan: FileText,
  simple: AlignLeft,
  search: Search,
  vision: Eye,
}

/** Editable mode keys — the subset depends on the routine's mode. */
type ModeKey = (typeof ROUTINE_MODES)[number]

/**
 * Modes as clickable badges, in the same pattern as the preferences: on is
 * primary-colored, off is ghost. The agent SUGGESTS on creation — the user is
 * the one who confirms, with one tap.
 */
export function ModesEditor({
  modes,
  onChange,
  available = ROUTINE_MODES,
}: {
  modes: RoutineModes
  onChange: (modes: RoutineModes) => void
  /** Modes shown — a chat routine receives ROUTINE_CHAT_MODES. */
  available?: ModeKey[]
}) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const permission = modes.permissionMode ?? DEFAULT_ROUTINE_PERMISSION

  const toggle = (key: ModeKey) => {
    const on = modes[key] !== true
    const next: RoutineModes = { ...modes, [key]: on || undefined }
    // Orchestration implies loop + subagents and is incompatible with plan —
    // the same rule as the chat:send handler, applied here so the screen does
    // not show a combination the backend will undo on its own.
    if (key === 'orchestrate' && on) {
      next.loop = true
      next.subagents = true
      next.plan = undefined
    }
    if (key === 'plan' && on) next.orchestrate = undefined
    onChange(next)
  }

  const activeChip = { borderColor: tokens.primary, backgroundColor: primaryBg(tokens, 0.1) }
  const inactiveChip = { borderColor: 'transparent', backgroundColor: tokens.muted }

  return (
    <View style={{ gap: 10 }}>
      <View style={s.rowWrap}>
        {available.map((key) => {
          const Icon = MODE_ICON[key]
          const active = modes[key] === true
          return (
            <Pressable key={key} onPress={() => toggle(key)} style={[s.modeChip, active ? activeChip : inactiveChip]}>
              <Icon size={13} color={active ? tokens.primary : tokens.mutedForeground} />
              <Text style={[s.chipText, { color: active ? tokens.primary : tokens.mutedForeground }]}>
                {t(`routines.modes.${key}.name`)}
              </Text>
            </Pressable>
          )
        })}
      </View>

      <View style={{ gap: 6 }}>
        <Text style={[s.sectionLabel, { color: tokens.mutedForeground }]}>{t('routines.modes.permission')}</Text>
        <View style={s.rowWrap}>
          {ROUTINE_PERMISSIONS.map((option: PermissionMode) => (
            <Pressable
              key={option}
              onPress={() => onChange({ ...modes, permissionMode: option })}
              style={[s.chip, permission === option ? activeChip : inactiveChip]}
            >
              <Text style={[s.chipText, { color: permission === option ? tokens.primary : tokens.mutedForeground }]}>
                {t(`permissionModePicker.${option}`)}
              </Text>
            </Pressable>
          ))}
        </View>
        {permission === 'ask' && (
          <Text style={[s.summary, { color: tokens.mutedForeground }]}>{t('routines.modes.permissionWarning')}</Text>
        )}
      </View>
    </View>
  )
}

/** Compact (read-only) badges of the enabled modes — card and detail screen. */
export function ModeBadges({
  modes,
  permission,
  available = ROUTINE_MODES,
}: {
  modes: RoutineModes
  permission?: boolean
  /** Modes considered — a chat routine does not show loop/orchestration even if
   *  the hand-edited routines.json has the field (the scheduler ignores it anyway). */
  available?: ModeKey[]
}) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const active = available.filter((key) => modes[key] === true)
  const permissionMode: PermissionMode = modes.permissionMode ?? DEFAULT_ROUTINE_PERMISSION
  if (active.length === 0 && !permission) return null
  const badgeStyle = { borderColor: tokens.primary, backgroundColor: primaryBg(tokens, 0.1) }
  return (
    <View style={s.rowWrap}>
      {active.map((key) => {
        const Icon = MODE_ICON[key]
        return (
          <View key={key} style={[s.badge, badgeStyle]}>
            <Icon size={11} color={tokens.primary} />
            <Text style={[s.badgeText, { color: tokens.primary }]}>{t(`routines.modes.${key}.name`)}</Text>
          </View>
        )
      })}
      {permission && (
        <View style={[s.badge, { borderColor: 'transparent', backgroundColor: tokens.muted }]}>
          <Text style={[s.badgeText, { color: tokens.mutedForeground }]}>{t(`permissionModePicker.${permissionMode}`)}</Text>
        </View>
      )}
    </View>
  )
}

/** On/off switch reused by the card and by the detail screen header. */
export function ActiveSwitch({ active, onChange }: { active: boolean; onChange: (v: boolean) => void }) {
  const { t } = useTranslation()
  return (
    <Switch
      checked={active}
      onCheckedChange={onChange}
      accessibilityLabel={active ? t('routines.list.active') : t('routines.list.paused')}
    />
  )
}

const s = StyleSheet.create({
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  modalBackdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
    padding: 24,
  },
  modalBox: {
    width: '100%',
    maxWidth: 340,
    borderRadius: 16,
    paddingTop: 18,
    alignItems: 'center',
    overflow: 'hidden',
  },
  modalTitle: { fontSize: 16, fontWeight: '600', marginBottom: 12 },
  modalContent: { alignItems: 'center', paddingHorizontal: 20 },
  modalFooter: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: 16,
    alignSelf: 'stretch',
  },
  modalButton: { flex: 1, alignItems: 'center', paddingVertical: 14 },
  modalDivider: { width: StyleSheet.hairlineWidth, alignSelf: 'stretch' },
  chip: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  chipText: { fontSize: 12, fontWeight: '500' },
  modeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  timeLabel: { fontSize: 12 },
  timeInput: { fontSize: 12, fontWeight: '500' },
  dayChip: {
    width: 30,
    height: 30,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayChipText: { fontSize: 12, fontWeight: '500' },
  linkText: { fontSize: 12 },
  intervalInput: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
    fontSize: 12,
    fontFamily: 'monospace',
    minWidth: 52,
    textAlign: 'center',
  },
  summary: { fontSize: 12 },
  sectionLabel: { fontSize: 12, fontWeight: '500' },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  badgeText: { fontSize: 11, fontWeight: '500' },
})
