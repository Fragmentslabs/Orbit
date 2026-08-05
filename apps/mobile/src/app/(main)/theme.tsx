import { View, Text, Pressable, ScrollView } from 'react-native'
import { useRouter } from 'expo-router'
import { Palette, ArrowLeft, Sun, Moon, Monitor } from 'lucide-react-native'
import { Appearance, useColorScheme } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useThemeStore, type ThemePreference } from '~/stores/theme-store'
import { SafeScreen } from '~/components/layout/SafeScreen'

function useThemeOptions(): { value: ThemePreference; label: string; icon: typeof Sun }[] {
  const { t } = useTranslation()
  return [
    { value: 'light', label: t('themeScreen.light'), icon: Sun },
    { value: 'dark', label: t('themeScreen.dark'), icon: Moon },
    { value: 'system', label: t('themeScreen.system'), icon: Monitor },
  ]
}

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
  const { t } = useTranslation()
  const THEME_OPTIONS = useThemeOptions()
  const router = useRouter()
  const systemScheme = useColorScheme()
  const systemIsDark = systemScheme !== 'light'
  const current = useThemeStore((s) => s.preference)
  const resolved = useThemeStore((s) => s.resolved)
  const setPreference = useThemeStore((s) => s.setPreference)
  const tk = tokens[resolved]

  const handleSelect = (value: ThemePreference) => {
    setPreference(value, systemIsDark)
    const resolvedTheme = value === 'system' ? (systemIsDark ? 'dark' : 'light') : value
    Appearance.setColorScheme(resolvedTheme)
  }

  return (
    <SafeScreen backgroundColor={tk.background}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: tk.border }}>
        <Pressable onPress={() => router.back()} style={{ padding: 4, marginLeft: -4 }}>
          <ArrowLeft size={22} color={tk.foreground} />
        </Pressable>
        <Text style={{ flex: 1, fontSize: 16, fontWeight: '600', color: tk.foreground, textAlign: 'center', marginRight: 24 }}>
          {t('themeScreen.title')}
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
                  backgroundColor: isActive ? tk.accent : tk.card,
                  borderWidth: 1,
                  borderColor: isActive ? tk.primary + '4D' : tk.border,
                }}
              >
                <Icon size={20} color={isActive ? tk.primary : tk.mutedFg} />
                <Text style={{
                  fontSize: 14,
                  flex: 1,
                  color: tk.foreground,
                  fontWeight: isActive ? '500' : '400',
                }}>
                  {option.label}
                </Text>
                {isActive && <Text style={{ fontSize: 12, color: tk.primary }}>✓</Text>}
              </Pressable>
            )
          })}
        </View>
      </ScrollView>
    </SafeScreen>
  )
}
