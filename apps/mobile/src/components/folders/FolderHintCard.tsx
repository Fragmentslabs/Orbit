import { View, Text, Pressable, StyleSheet } from 'react-native'
import { FolderPlus, X } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { getThemeTokens, withAlpha } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

/**
 * Notice above the input when code mode has no folder — mirror of the desktop FolderHintCard.
 * The send button is disabled in that state; this says why and offers the shortcut that solves
 * it (the folder sheet). It goes away on its own once a folder is chosen.
 */
export function FolderHintCard({ onChoose, onDismiss }: { onChoose: () => void; onDismiss: () => void }) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  return (
    <View style={s.wrap}>
      <View style={[s.card, { backgroundColor: withAlpha(tokens.primary, 0.12), borderColor: withAlpha(tokens.primary, 0.3) }]}>
        <FolderPlus size={16} color={tokens.primary} />
        <Text style={[s.text, { color: tokens.foreground }]}>{t('folderHint.hint')}</Text>
        <Pressable onPress={onChoose} style={[s.btn, { backgroundColor: withAlpha(tokens.foreground, 0.1) }]} accessibilityRole="button">
          <Text style={[s.btnText, { color: tokens.foreground }]}>{t('folderHint.choose')}</Text>
        </Pressable>
        <Pressable onPress={onDismiss} hitSlop={10} accessibilityLabel={t('folderHint.dismiss')}>
          <X size={15} color={tokens.mutedForeground} />
        </Pressable>
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingBottom: 8 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9 },
  text: { flex: 1, fontSize: 12.5, lineHeight: 17 },
  btn: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  btnText: { fontSize: 12.5, fontWeight: '600' },
})
