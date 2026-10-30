import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight, Monitor } from 'lucide-react-native'
import { uiDestination } from '@orbit/shared'
import { getThemeTokens, withAlpha } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

/**
 * Navigation card — the mobile mirror of the `nav` block of orbit-ui.
 *
 * The `target` is an id of the shared registry (ui-destinations), and the label
 * comes from the i18n key the screen itself uses, so renaming a screen renames
 * the card. A screen that does not exist on the phone shows up explained and inert: a
 * button that opens nothing is worse than a sentence.
 *
 * Nothing navigates on its own — the touch is the consent.
 */
export function NavCard({ destination, note }: { destination: string; note?: string }) {
  const { t } = useTranslation()
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const target = uiDestination(destination)

  // Id the registry does not know: silence, not an empty card — the prose of the
  // message has already said where it is.
  if (!target) return null

  const screen = target.mobile

  if (!screen) {
    return (
      <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.muted }]}>
        <Monitor size={16} color={tokens.mutedForeground} />
        <Text style={[s.title, { color: tokens.mutedForeground }]}>{t('orbitUi.nav.otherSurface')}</Text>
      </View>
    )
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${t('orbitUi.nav.open')}: ${t(screen.titleKey)}`}
      onPress={() => router.push(screen.path as any)}
      style={({ pressed }) => [
        s.card,
        { borderColor: tokens.border, backgroundColor: tokens.card, opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <View style={[s.icon, { backgroundColor: withAlpha(tokens.primary, 0.14) }]}>
        <ArrowUpRight size={15} color={tokens.primary} />
      </View>
      <View style={s.body}>
        <Text style={[s.title, { color: tokens.foreground }]} numberOfLines={1}>
          {t(screen.titleKey)}
        </Text>
        {note ? (
          <Text style={[s.note, { color: tokens.mutedForeground }]} numberOfLines={2}>
            {note}
          </Text>
        ) : null}
      </View>
      <Text style={[s.action, { color: tokens.mutedForeground }]}>{t('orbitUi.nav.open')}</Text>
    </Pressable>
  )
}

const s = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  icon: { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, gap: 2 },
  title: { fontSize: 14, fontWeight: '600' },
  note: { fontSize: 12, lineHeight: 16 },
  action: { fontSize: 12, fontWeight: '500' },
})
