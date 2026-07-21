import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ArrowLeft, Sun, Moon, Monitor, List, Square, Layers } from 'lucide-react-native'
import { Appearance, useColorScheme } from 'react-native'
import { useThemeStore, type ThemePreference } from '~/stores/theme-store'
import { useAppearanceStore, type DisplayMode } from '~/stores/appearance-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore as useThemeTokensStore } from '~/stores/theme-store'

const THEME_OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Claro', icon: Sun },
  { value: 'dark', label: 'Escuro', icon: Moon },
  { value: 'system', label: 'Sistema', icon: Monitor },
]

const DISPLAY_OPTIONS: { value: DisplayMode; label: string; icon: typeof List; desc: string }[] = [
  { value: 'toggles', label: 'Toggles', icon: List, desc: 'Modos como toggles inline. Configurações no gear.' },
  { value: 'actions', label: 'Ações', icon: Square, desc: 'Sem toggles inline. Todos os modos no "+".' },
  { value: 'both', label: 'Ambos', icon: Layers, desc: 'Toggles inline + modos avançados no "+".' },
]

export default function AppearanceScreen() {
  const router = useRouter()
  const systemScheme = useColorScheme()
  const systemIsDark = systemScheme !== 'light'
  const themePref = useThemeStore((s) => s.preference)
  const setThemePref = useThemeStore((s) => s.setPreference)
  const displayMode = useAppearanceStore((s) => s.displayMode)
  const setDisplayMode = useAppearanceStore((s) => s.setDisplayMode)
  const tokens = getThemeTokens(useThemeTokensStore((s) => s.resolved))

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }} edges={['top']}>
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.backBtn}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <Text style={[s.headerTitle, { color: tokens.foreground }]}>Aparência</Text>
        <View style={{ width: 34 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        <Text style={[s.sectionTitle, { color: tokens.mutedForeground }]}>Tema</Text>

        <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
            const active = themePref === value
            return (
              <Pressable
                key={value}
                onPress={() => {
                  setThemePref(value, systemIsDark)
                  Appearance.setColorScheme(value === 'system' ? (systemIsDark ? 'dark' : 'light') : value)
                }}
                style={[s.optionRow, active && { backgroundColor: tokens.primary + '18' }]}
              >
                <Icon size={18} color={active ? tokens.primary : tokens.mutedForeground} />
                <Text style={[s.optionLabel, { color: tokens.foreground }]}>{label}</Text>
                {active && <Text style={[s.check, { color: tokens.primary }]}>✓</Text>}
              </Pressable>
            )
          })}
        </View>

        <Text style={[s.sectionTitle, { color: tokens.mutedForeground, marginTop: 24 }]}>Modos de exibição</Text>

        <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          {DISPLAY_OPTIONS.map(({ value, label, icon: Icon, desc }) => {
            const active = displayMode === value
            return (
              <Pressable
                key={value}
                onPress={() => setDisplayMode(value)}
                style={[s.optionRow, active && { backgroundColor: tokens.primary + '18' }]}
              >
                <Icon size={18} color={active ? tokens.primary : tokens.mutedForeground} />
                <View style={{ flex: 1 }}>
                  <Text style={[s.optionLabel, { color: tokens.foreground }]}>{label}</Text>
                  <Text style={[s.optionDesc, { color: tokens.mutedForeground }]}>{desc}</Text>
                </View>
                {active && <Text style={[s.check, { color: tokens.primary }]}>✓</Text>}
              </Pressable>
            )
          })}
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
  card: { borderRadius: 14, borderWidth: 1, overflow: 'hidden', marginBottom: 4 },
  optionRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  optionLabel: { fontSize: 14, fontWeight: '500', flex: 1 },
  optionDesc: { fontSize: 11, marginTop: 1 },
  check: { fontSize: 16, fontWeight: '700' },
})
