/**
 * Seletor do modo de permissões (modo código) — espelho do
 * permission-mode-picker do desktop: Perguntar / Autonomia / Irrestrito.
 */
import { useState } from 'react'
import { Modal, View, Text, Pressable, StyleSheet } from 'react-native'
import { Shield, ShieldCheck, ShieldOff, Check } from 'lucide-react-native'
import type { LucideIcon } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { hslToRgba } from '~/lib/theme'

export type PermissionModeValue = 'ask' | 'approve' | 'full'

function useModes(): { id: PermissionModeValue; label: string; description: string; icon: LucideIcon }[] {
  const { t } = useTranslation()
  return [
    { id: 'ask', label: t('permissionModePicker.ask'), description: t('permissionModePicker.askDescription'), icon: Shield },
    { id: 'approve', label: t('permissionModePicker.approve'), description: t('permissionModePicker.approveDescription'), icon: ShieldCheck },
    { id: 'full', label: t('permissionModePicker.full'), description: t('permissionModePicker.fullDescription'), icon: ShieldOff },
  ]
}

interface Props {
  value: PermissionModeValue
  onChange: (mode: PermissionModeValue) => void
}

export function PermissionModePicker({ value, onChange }: Props) {
  const { t } = useTranslation()
  const MODES = useModes()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const [open, setOpen] = useState(false)
  const current = MODES.find((m) => m.id === value) ?? MODES[0]
  const Icon = current.icon
  const rowSelectedBg = hslToRgba(
    tokens.primary.replace(/hsla?\(|\)/g, '').replace(/,/g, ''),
    0.08,
  )

  return (
    <>
      <Pressable onPress={() => setOpen(true)} style={s.trigger}>
        <Icon size={14} color={tokens.mutedForeground} />
        <Text style={[s.triggerText, { color: tokens.mutedForeground }]}>{current.label}</Text>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={s.backdrop} onPress={() => setOpen(false)} />
        <View style={[s.menu, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          <Text style={[s.menuTitle, { color: tokens.mutedForeground }]}>{t('permissionModePicker.title')}</Text>
          {MODES.map((mode) => {
            const ModeIcon = mode.icon
            const selected = mode.id === value
            return (
              <Pressable
                key={mode.id}
                onPress={() => {
                  onChange(mode.id)
                  setOpen(false)
                }}
                style={[s.item, selected && { backgroundColor: rowSelectedBg }]}
              >
                <ModeIcon size={16} color={selected ? tokens.primary : tokens.mutedForeground} />
                <View style={{ flex: 1 }}>
                  <Text style={[s.itemLabel, { color: tokens.foreground }]}>{mode.label}</Text>
                  <Text style={[s.itemDesc, { color: tokens.mutedForeground }]}>{mode.description}</Text>
                </View>
                {selected && <Check size={15} color={tokens.primary} />}
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
