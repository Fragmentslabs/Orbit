import { Fragment } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { ArrowLeft, Check } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { useLocaleStore, LOCALE_LABELS, SUPPORTED_LOCALES } from '~/stores/locale-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { SafeScreen } from '~/components/layout/SafeScreen'

export default function LanguageScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const locale = useLocaleStore((s) => s.locale)
  const setLocale = useLocaleStore((s) => s.setLocale)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  return (
    <SafeScreen style={s.container}>
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.headerBtn}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <Text style={[s.headerTitle, { color: tokens.foreground }]}>{t('languageScreen.title')}</Text>
        <View style={s.headerBtn} />
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          {SUPPORTED_LOCALES.map((loc, i) => (
            <Fragment key={loc}>
              {i > 0 && <View style={[s.divider, { backgroundColor: tokens.border }]} />}
              <Pressable onPress={() => setLocale(loc)} style={s.row}>
                <Text
                  style={[
                    s.rowText,
                    { color: locale === loc ? tokens.foreground : tokens.mutedForeground },
                    locale === loc && { fontWeight: '600' },
                  ]}
                >
                  {LOCALE_LABELS[loc]}
                </Text>
                {locale === loc && <Check size={18} color={tokens.primary} />}
              </Pressable>
            </Fragment>
          ))}
        </View>
        <Text style={[s.helperText, { color: tokens.mutedForeground }]}>{t('languageScreen.description')}</Text>
      </ScrollView>
    </SafeScreen>
  )
}

const s = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  headerBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 16, fontWeight: '600' },

  card: {
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
  },
  divider: { height: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  rowText: { fontSize: 14 },
  helperText: { marginTop: 12, fontSize: 11, lineHeight: 16 },
})
