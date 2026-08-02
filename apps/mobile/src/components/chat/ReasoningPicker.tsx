import { useState } from 'react'
import { Modal, View, Text, Pressable, StyleSheet } from 'react-native'
import { Brain, Check } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { hslToRgba } from '~/lib/theme'
import type { ModelVariant } from '@orbit/shared'

interface Props {
  variants: ModelVariant[]
  selected: string | undefined
  onSelect: (variantId: string) => void
}

export function ReasoningPicker({ variants, selected, onSelect }: Props) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const [open, setOpen] = useState(false)
  const current = variants.find((v) => v.id === selected)
  const rowSelectedBg = hslToRgba(
    tokens.primary.replace(/hsla?\(|\)/g, '').replace(/,/g, ''),
    0.08,
  )

  if (variants.length === 0) return null

  return (
    <>
      <Pressable onPress={() => setOpen(true)} style={s.trigger}>
        <Brain size={14} color={tokens.mutedForeground} />
        <Text style={[s.triggerText, { color: tokens.mutedForeground }]}>
          {current?.label ?? t('reasoningPicker.level')}
        </Text>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={s.backdrop} onPress={() => setOpen(false)} />
        <View style={[s.menu, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          <Text style={[s.menuTitle, { color: tokens.mutedForeground }]}>{t('reasoningPicker.levelTitle')}</Text>
          {variants.map((variant) => {
            const selectedId = variant.id === selected
            return (
              <Pressable
                key={variant.id}
                onPress={() => { onSelect(variant.id); setOpen(false) }}
                style={[s.item, selectedId && { backgroundColor: rowSelectedBg }]}
              >
                <Brain size={16} color={selectedId ? tokens.primary : tokens.mutedForeground} />
                <View style={{ flex: 1 }}>
                  <Text style={[s.itemLabel, { color: tokens.foreground }]}>{variant.label}</Text>
                  {variant.description ? (
                    <Text style={[s.itemDesc, { color: tokens.mutedForeground }]}>{variant.description}</Text>
                  ) : null}
                </View>
                {selectedId && <Check size={15} color={tokens.primary} />}
              </Pressable>
            )
          })}
        </View>
      </Modal>
    </>
  )
}

const s = StyleSheet.create({
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  triggerText: { fontSize: 13, fontWeight: '500' },

  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  menu: {
    position: 'absolute',
    bottom: 110,
    left: 16,
    right: 16,
    borderRadius: 14,
    borderWidth: 1,
    padding: 8,
    gap: 4,
  },
  menuTitle: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: 8,
    paddingTop: 4,
    paddingBottom: 6,
  },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 10 },
  itemLabel: { fontSize: 14, fontWeight: '500' },
  itemDesc: { fontSize: 11, marginTop: 1 },
})
