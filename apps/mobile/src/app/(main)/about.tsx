import { View, Text, ScrollView, Pressable, StyleSheet, Linking } from 'react-native'
import { useRouter } from 'expo-router'
import Constants from 'expo-constants'
import { ArrowLeft, Globe, Heart, Star } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { SafeScreen } from '~/components/layout/SafeScreen'

const KO_FI_URL = 'https://ko-fi.com/fragmentslabs'
const WEBSITE_URL = 'https://fragmentslabs.com'
const GITHUB_URL = 'https://github.com/fragmentslabs'

/** Espelha o painel Sobre do desktop (mesmos textos e links). A versao vem do
 *  expo config, que o chore de release sobe junto com os package.json — e a
 *  mesma string que o desktop mostra pelo app.getVersion. */
export default function AboutScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const version = Constants.expoConfig?.version ?? ''

  const open = (url: string) => {
    Linking.openURL(url).catch(() => {})
  }

  return (
    <SafeScreen>
      {/* Header */}
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.backBtn}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <Text style={[s.headerTitle, { color: tokens.foreground }]}>{t('aboutScreen.title')}</Text>
        <View style={{ width: 34 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        {version ? (
          <View style={[s.versionPill, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
            <Text style={[s.versionText, { color: tokens.mutedForeground }]}>
              {t('aboutScreen.version', { version })}
            </Text>
          </View>
        ) : null}

        <Text style={[s.intro, { color: tokens.mutedForeground }]}>{t('aboutScreen.intro')}</Text>

        <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          <Text style={[s.cardTitle, { color: tokens.foreground }]}>Fragments Labs</Text>
          <Text style={[s.cardDesc, { color: tokens.mutedForeground }]}>{t('aboutScreen.fraglab')}</Text>
        </View>

        <Pressable
          onPress={() => open(KO_FI_URL)}
          style={[s.supportBtn, { backgroundColor: tokens.primary }]}
        >
          <Heart size={15} color={tokens.primaryForeground} />
          <Text style={[s.supportText, { color: tokens.primaryForeground }]}>{t('aboutScreen.support')}</Text>
        </Pressable>

        <View style={s.links}>
          <Pressable onPress={() => open(WEBSITE_URL)} style={s.link}>
            <Globe size={13} color={tokens.mutedForeground} />
            <Text style={[s.linkText, { color: tokens.mutedForeground }]}>{t('aboutScreen.website')}</Text>
          </Pressable>
          <Pressable onPress={() => open(GITHUB_URL)} style={s.link}>
            <Star size={13} color={tokens.mutedForeground} />
            <Text style={[s.linkText, { color: tokens.mutedForeground }]}>{t('aboutScreen.github')}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeScreen>
  )
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  backBtn: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 16, fontWeight: '600' },

  versionPill: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
    marginBottom: 12,
  },
  versionText: { fontSize: 11, fontVariant: ['tabular-nums'] },

  intro: { fontSize: 13, lineHeight: 20 },

  card: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginTop: 16,
  },
  cardTitle: { fontSize: 13, fontWeight: '600' },
  cardDesc: { fontSize: 12, lineHeight: 18, marginTop: 6 },

  supportBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 10,
    paddingVertical: 12,
    marginTop: 20,
  },
  supportText: { fontSize: 13, fontWeight: '600' },

  links: { flexDirection: 'row', gap: 20, marginTop: 18, justifyContent: 'center' },
  link: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 6 },
  linkText: { fontSize: 12 },
})
