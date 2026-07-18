import { View, Text, Pressable, ScrollView } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { Palette, ArrowLeft, Sun, Moon, Monitor } from 'lucide-react-native'
import { Appearance, useColorScheme } from 'react-native'
import { useThemeStore, type ThemePreference } from '~/stores/theme-store'

const THEME_OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Claro', icon: Sun },
  { value: 'dark', label: 'Escuro', icon: Moon },
  { value: 'system', label: 'Sistema', icon: Monitor },
]

const tokens = {
  light: {
    background: 'hsl(0, 0%, 100%)',
    foreground: 'hsl(240, 10%, 4%)',
    card: 'hsl(0, 0%, 100%)',
    border: 'hsl(240, 4%, 90%)',
    primary: 'hsl(44, 100%, 70%)',
    accent: 'hsl(240, 2%, 96%)',
    mutedFg: 'hsl(240, 4%, 55%)',
  },
  dark: {
    background: 'hsl(240, 11%, 4%)',
    foreground: 'hsl(0, 0%, 98%)',
    card: 'hsl(240, 6%, 10%)',
    border: 'hsl(240, 4%, 13%)',
    primary: 'hsl(44, 100%, 47%)',
    accent: 'hsl(240, 4%, 16%)',
    mutedFg: 'hsl(240, 6%, 64%)',
  },
}

export default function ThemeScreen() {
  const router = useRouter()
  const systemScheme = useColorScheme()
  const systemIsDark = systemScheme !== 'light'
  const current = useThemeStore((s) => s.preference)
  const resolved = useThemeStore((s) => s.resolved)
  const setPreference = useThemeStore((s) => s.setPreference)
  const t = tokens[resolved]

  const handleSelect = (value: ThemePreference) => {
    setPreference(value, systemIsDark)
    const resolvedTheme = value === 'system' ? (systemIsDark ? 'dark' : 'light') : value
    Appearance.setColorScheme(resolvedTheme)
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.background }} edges={['top']}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: t.border }}>
        <Pressable onPress={() => router.back()} style={{ padding: 4, marginLeft: -4 }}>
          <ArrowLeft size={22} color={t.foreground} />
        </Pressable>
        <Text style={{ flex: 1, fontSize: 16, fontWeight: '600', color: t.foreground, textAlign: 'center', marginRight: 24 }}>
          Tema
        </Text>
      </View>
      <ScrollView style={{ flex: 1 }}>
        <View style={{ padding: 16, gap: 8 }}>
          {THEME_OPTIONS.map((option) => {
            const Icon = option.icon
            const isActive = current === option.value
            return (
              <Pressable
                key={option.value}
                onPress={() => handleSelect(option.value)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  paddingHorizontal: 16,
                  paddingVertical: 12,
                  borderRadius: 8,
                  backgroundColor: isActive ? t.accent : t.card,
                  borderWidth: 1,
                  borderColor: isActive ? t.primary + '4D' : t.border,
                }}
              >
                <Icon size={20} color={isActive ? t.primary : t.mutedFg} />
                <Text style={{
                  fontSize: 14,
                  flex: 1,
                  color: t.foreground,
                  fontWeight: isActive ? '500' : '400',
                }}>
                  {option.label}
                </Text>
                {isActive && <Text style={{ fontSize: 12, color: t.primary }}>✓</Text>}
              </Pressable>
            )
          })}
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}
