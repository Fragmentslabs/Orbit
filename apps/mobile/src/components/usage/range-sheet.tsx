import { View, Text, Pressable, StyleSheet } from 'react-native'
import { Check, ChevronRight, X } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { AnalyticsRange } from '@orbit/shared'
import { BottomSheet } from '~/components/ui/bottom-sheet'
import { tint, useTokens } from '~/components/list/parts'

export type PresetRange = 'today' | '7d' | '30d' | 'total'
const PRESETS: PresetRange[] = ['today', '7d', '30d', 'total']
const DAY_MS = 86_400_000

/** "8 – 14 Nov" for the last `days` days counting today; one day alone for "today". */
function spanLabel(days: number, locale: string, now: number): string {
  const fmt = (ts: number) => new Date(ts).toLocaleDateString(locale, { day: 'numeric', month: 'short' })
  return days <= 1 ? fmt(now) : `${fmt(now - (days - 1) * DAY_MS)} – ${fmt(now)}`
}

/** The period of the usage page, as a sheet: the presets with the dates they cover, and the custom range. */
export function RangeSheet({
  open,
  range,
  now,
  customLabel,
  onClose,
  onPick,
  onCustom,
}: {
  open: boolean
  range: AnalyticsRange
  now: number
  /** Label of the active custom range, when there is one. */
  customLabel: string | null
  onClose: () => void
  onPick: (range: PresetRange) => void
  onCustom: () => void
}) {
  const { t, i18n } = useTranslation()
  const tokens = useTokens()
  const dates: Record<PresetRange, string> = {
    today: spanLabel(1, i18n.language, now),
    '7d': spanLabel(7, i18n.language, now),
    '30d': spanLabel(30, i18n.language, now),
    total: t('usageScreen.rangeTotalHint'),
  }
  const titles: Record<PresetRange, string> = {
    today: t('usageScreen.rangeTodayFull'),
    '7d': t('usageScreen.range7dFull'),
    '30d': t('usageScreen.range30dFull'),
    total: t('usageScreen.rangeTotal'),
  }
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={
        <View style={s.head}>
          <Text style={{ fontSize: 17, fontWeight: '600', color: tokens.foreground }}>{t('usageScreen.periodTitle')}</Text>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel={t('sidebar.cancel')} style={s.close}>
            <X size={20} color={tokens.mutedForeground} />
          </Pressable>
        </View>
      }
    >
      <View style={{ gap: 8 }}>
        {PRESETS.map((id) => {
          const on = range === id
          return (
            <Pressable
              key={id}
              onPress={() => onPick(id)}
              accessibilityState={{ selected: on }}
              style={[s.option, { borderColor: on ? tokens.primary : tokens.border }, on && { backgroundColor: tint(tokens.primary, '26') }]}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 15, fontWeight: '500', color: tokens.foreground }}>{titles[id]}</Text>
                <Text style={{ marginTop: 1, fontSize: 12, color: tokens.mutedForeground }}>{dates[id]}</Text>
              </View>
              <View style={[s.radio, { borderColor: on ? tokens.primary : tokens.border }, on && { backgroundColor: tokens.primary }]}>
                {on ? <Check size={13} color={tokens.primaryForeground} /> : null}
              </View>
            </Pressable>
          )
        })}
        <Pressable
          onPress={onCustom}
          style={[s.option, { borderColor: customLabel ? tokens.primary : tokens.border }, customLabel ? { backgroundColor: tint(tokens.primary, '26') } : null]}
        >
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: '500', color: tokens.foreground }}>{t('usageScreen.rangeCustom')}</Text>
            <Text style={{ marginTop: 1, fontSize: 12, color: tokens.mutedForeground }}>{customLabel ?? t('usageScreen.rangeCustomHint')}</Text>
          </View>
          <ChevronRight size={16} color={tokens.mutedForeground} />
        </Pressable>
      </View>
    </BottomSheet>
  )
}

const s = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 8 },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginRight: -8 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1, borderRadius: 14 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
})
