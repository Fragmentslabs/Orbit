import { Modal, View, Text, Pressable, StyleSheet } from 'react-native'
import type { LucideIcon } from 'lucide-react-native'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

export interface ActionMenuItem {
  icon: LucideIcon
  label: string
  onPress: () => void
  destructive?: boolean
}

interface ActionMenuProps {
  visible: boolean
  onClose: () => void
  items: ActionMenuItem[]
  /** Posição do menu — padrão: canto superior direito (dropdown do header). */
  anchor?: { top?: number; right?: number; left?: number; bottom?: number }
}

/** Dropdown de ações reutilizável (header do chat, sidebar). */
export function ActionMenu({ visible, onClose, items, anchor = { top: 52, right: 12 } }: ActionMenuProps) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={[s.menu, { backgroundColor: tokens.background, borderColor: tokens.border }, anchor]}>
        {items.map((item, i) => (
          <Pressable
            key={i}
            onPress={() => {
              onClose()
              item.onPress()
            }}
            style={s.menuItem}
          >
            <item.icon size={16} color={item.destructive ? tokens.destructive : tokens.foreground} />
            <Text style={[s.menuItemText, { color: item.destructive ? tokens.destructive : tokens.foreground }]}>{item.label}</Text>
          </Pressable>
        ))}
      </View>
    </Modal>
  )
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  menu: {
    position: 'absolute',
    width: 208,
    borderRadius: 12,
    borderWidth: 1,
    padding: 6,
    gap: 2,
  },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, paddingVertical: 10, borderRadius: 8 },
  menuItemText: { fontSize: 14, fontWeight: '500' },
})
