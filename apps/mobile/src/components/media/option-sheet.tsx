import type { ComponentType } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native'
import { Check, ChevronDown, X } from 'lucide-react-native'
import { BottomSheet } from '~/components/ui/bottom-sheet'
import { tint, useTokens } from '~/components/list/parts'

export interface SheetOption {
  value: string
  label: string
  icon: ComponentType<{ size?: number; color?: string }>
  count?: number
}

/** The button of a filter: icon, the chosen label and a chevron — it opens the sheet of its options. */
export function FilterSelect({ option, active, onPress, accessibilityLabel }: { option: SheetOption | undefined; active: boolean; onPress: () => void; accessibilityLabel: string }) {
  const tokens = useTokens()
  if (!option) return null
  const Icon = option.icon
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={accessibilityLabel} style={[s.select, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
      <Icon size={15} color={active ? tokens.foreground : tokens.mutedForeground} />
      <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, color: active ? tokens.foreground : tokens.mutedForeground }}>
        {option.label}
      </Text>
      <ChevronDown size={15} color={tokens.mutedForeground} />
    </Pressable>
  )
}

/** One choice among many, as a sheet — the phone's version of the desktop's select. */
export function OptionSheet({ open, title, options, value, closeLabel, onPick, onClose }: { open: boolean; title: string; options: SheetOption[]; value: string; closeLabel: string; onPick: (value: string) => void; onClose: () => void }) {
  const tokens = useTokens()
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={
        <View style={s.head}>
          <Text style={{ fontSize: 17, fontWeight: '600', color: tokens.foreground }}>{title}</Text>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel={closeLabel} style={s.close}>
            <X size={20} color={tokens.mutedForeground} />
          </Pressable>
        </View>
      }
    >
      <ScrollView style={{ maxHeight: 460 }} contentContainerStyle={{ gap: 8 }}>
        {options.map((option) => {
          const on = option.value === value
          const Icon = option.icon
          return (
            <Pressable
              key={option.value}
              onPress={() => onPick(option.value)}
              accessibilityState={{ selected: on }}
              style={[s.option, { borderColor: on ? tokens.primary : tokens.border }, on && { backgroundColor: tint(tokens.primary, '26') }]}
            >
              <Icon size={18} color={tokens.mutedForeground} />
              <Text numberOfLines={1} style={{ flex: 1, fontSize: 14.5, color: tokens.foreground }}>
                {option.label}
              </Text>
              {option.count != null ? <Text style={{ fontSize: 12, color: tokens.mutedForeground, fontVariant: ['tabular-nums'] }}>{option.count}</Text> : null}
              <View style={[s.radio, { borderColor: on ? tokens.primary : tokens.border }, on && { backgroundColor: tokens.primary }]}>{on ? <Check size={13} color={tokens.primaryForeground} /> : null}</View>
            </Pressable>
          )
        })}
      </ScrollView>
    </BottomSheet>
  )
}

const s = StyleSheet.create({
  select: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8, height: 44, paddingHorizontal: 12, borderWidth: 1, borderRadius: 12 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 8 },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginRight: -10 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 12, borderWidth: 1, borderRadius: 14 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
})
