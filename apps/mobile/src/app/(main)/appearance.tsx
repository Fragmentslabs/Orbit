import { View, Text, Pressable, ScrollView, StyleSheet, Switch } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ArrowLeft, Sun, Moon, Monitor, List, Square, Layers, Smile } from 'lucide-react-native'
import { Appearance, useColorScheme } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useThemeStore, type ThemePreference } from '~/stores/theme-store'
import { useAppearanceStore, type DisplayMode } from '~/stores/appearance-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore as useThemeTokensStore } from '~/stores/theme-store'

export default function AppearanceScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const systemScheme = useColorScheme()
  const systemIsDark = systemScheme !== 'light'
  const themePref = useThemeStore((s) => s.preference)
  const setThemePref = useThemeStore((s) => s.setPreference)
  const displayMode = useAppearanceStore((s) => s.displayMode)
  const setDisplayMode = useAppearanceStore((s) => s.setDisplayMode)
  const personaVisible = useAppearanceStore((s) => s.personaVisible)
  const setPersonaVisible = useAppearanceStore((s) => s.setPersonaVisible)
  const tokens = getThemeTokens(useThemeTokensStore((s) => s.resolved))

  const handleTheme = (value: ThemePreference) => {
    setThemePref(value, systemIsDark)
    Appearance.setColorScheme(value === 'system' ? (systemIsDark ? 'dark' : 'light') : value)
  }

  const themeChips: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
    { value: 'light', label: t('appearanceScreen.themeLight'), icon: Sun },
    { value: 'dark', label: t('appearanceScreen.themeDark'), icon: Moon },
    { value: 'system', label: t('appearanceScreen.themeSystem'), icon: Monitor },
  ]

  const modeChips: { value: DisplayMode; label: string; icon: typeof List; hint: string }[] = [
    { value: 'toggles', label: t('appearanceScreen.displayModeToggles'), icon: List, hint: t('appearanceScreen.displayModeTogglesHint') },
    { value: 'actions', label: t('appearanceScreen.displayModeActions'), icon: Square, hint: t('appearanceScreen.displayModeActionsHint') },
    { value: 'both', label: t('appearanceScreen.displayModeBoth'), icon: Layers, hint: t('appearanceScreen.displayModeBothHint') },
  ]

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }} edges={['top']}>
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.backBtn}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <Text style={[s.headerTitle, { color: tokens.foreground }]}>{t('appearanceScreen.title')}</Text>
        <View style={{ width: 34 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        <Text style={[s.sectionTitle, { color: tokens.mutedForeground }]}>{t('appearanceScreen.themeSection')}</Text>

        <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          <View style={s.chipRow}>
            {themeChips.map(({ value, label, icon: Icon }) => {
              const active = themePref === value
              return (
                <Pressable
                  key={value}
                  onPress={() => handleTheme(value)}
                  style={[
                    s.chip,
                    active
                      ? { backgroundColor: tokens.background, borderColor: tokens.border }
                      : { backgroundColor: tokens.muted, borderColor: tokens.border },
                  ]}
                >
                  <Icon size={16} color={active ? tokens.primary : tokens.mutedForeground} />
                  <Text style={[s.chipLabel, { color: active ? tokens.primary : tokens.mutedForeground }]}>
                    {label}
                  </Text>
                </Pressable>
              )
            })}
          </View>
        </View>

        <Text style={[s.sectionTitle, { color: tokens.mutedForeground, marginTop: 24 }]}>{t('appearanceScreen.displayModesSection')}</Text>

        <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          <View style={s.chipRow}>
            {modeChips.map(({ value, label, icon: Icon, hint }) => {
              const active = displayMode === value
              return (
                <Pressable
                  key={value}
                  onPress={() => setDisplayMode(value)}
                  style={[
                    s.chip,
                    active
                      ? { backgroundColor: tokens.background, borderColor: tokens.border }
                      : { backgroundColor: tokens.muted, borderColor: tokens.border },
                  ]}
                >
                  <Icon size={16} color={active ? tokens.primary : tokens.mutedForeground} />
                  <Text style={[s.chipLabel, { color: active ? tokens.primary : tokens.mutedForeground }]}>
                    {label}
                  </Text>
                </Pressable>
              )
            })}
          </View>
          <Text style={[s.hint, { color: tokens.mutedForeground }]}>
            {modeChips.find((c) => c.value === displayMode)?.hint}
          </Text>
        </View>

        <Text style={[s.sectionTitle, { color: tokens.mutedForeground, marginTop: 24 }]}>{t('appearanceScreen.personaSection')}</Text>

        <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Smile size={20} color={tokens.mutedForeground} />
            <Text style={{ flex: 1, fontSize: 14, color: tokens.foreground }}>{t('appearanceScreen.showPersona')}</Text>
            <Switch
              value={personaVisible}
              onValueChange={setPersonaVisible}
              trackColor={{ false: tokens.muted, true: tokens.primary }}
              thumbColor={tokens.background}
            />
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1 },
  backBtn: { padding: 6, borderRadius: 8 },
  headerTitle: { fontSize: 16, fontWeight: '600' },
  sectionTitle: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  card: { borderRadius: 14, borderWidth: 1, padding: 14, marginBottom: 4 },
  chipRow: { flexDirection: 'row', gap: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flex: 1,
    justifyContent: 'center',
    borderWidth: 1,
  },
  chipLabel: { fontSize: 12, fontWeight: '500' },
  hint: { fontSize: 11, marginTop: 10, lineHeight: 16, opacity: 0.7 },
})
