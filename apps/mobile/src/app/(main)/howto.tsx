import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { ArrowLeft, Search, Globe, Brain, AlignLeft, BrainCircuit, Bot, Network, RefreshCw, FileText, KeyRound, Eye, BookOpen } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { SafeScreen } from '~/components/layout/SafeScreen'

interface ModeInfo {
  icon: typeof Search
  label: string
  modes: string[]
  description: string
  detail: string
  combo?: string[]
}

const MODE_ICONS = [Search, Globe, Brain, AlignLeft, BrainCircuit, Bot, Network, RefreshCw, FileText, KeyRound]

export default function HowToScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const rawModes = t('howtoScreen.modes', { returnObjects: true }) as Omit<ModeInfo, 'icon'>[]
  const MODES: ModeInfo[] = rawModes.map((m, i) => ({ ...m, icon: MODE_ICONS[i] }))
  const COMBOS = t('howtoScreen.combos', { returnObjects: true }) as { label: string; items: string[]; description: string }[]

  const hslToHsla = (hsl: string, alpha: number) => {
    const m = hsl.match(/hsl\(([^)]+)\)/)
    return m ? `hsla(${m[1]}, ${alpha})` : hsl
  }

  return (
    <SafeScreen>
      {/* Header */}
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.backBtn}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <Text style={[s.headerTitle, { color: tokens.foreground }]}>{t('howtoScreen.title')}</Text>
        <View style={{ width: 34 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        <Text style={[s.sectionTitle, { color: tokens.mutedForeground }]}>{t('howtoScreen.sectionModes')}</Text>
        <Text style={[s.sectionDesc, { color: tokens.mutedForeground }]}>
          {t('howtoScreen.sectionModesDesc')}
        </Text>

        {MODES.map((mode) => {
          const Icon = mode.icon
          return (
            <View key={mode.label} style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
              <View style={s.cardHeader}>
                <Icon size={18} color={tokens.primary} />
                <Text style={[s.cardLabel, { color: tokens.foreground }]}>{mode.label}</Text>
                <View style={s.badges}>
                  {mode.modes.map((m) => (
                    <Text key={m} style={[s.badge, { backgroundColor: tokens.border, color: tokens.mutedForeground }]}>{m}</Text>
                  ))}
                </View>
              </View>
              <Text style={[s.cardDesc, { color: tokens.mutedForeground }]}>{mode.description}</Text>
              <Text style={[s.cardDetail, { color: tokens.foreground }]}>{mode.detail}</Text>
              {mode.combo && mode.combo.length > 0 && (
                <Text style={[s.combo, { color: tokens.mutedForeground }]}>{t('howtoScreen.combinesWellWith', { items: mode.combo.join(', ') })}</Text>
              )}
            </View>
          )
        })}

        <Text style={[s.sectionTitle, { color: tokens.mutedForeground, marginTop: 24 }]}>{t('howtoScreen.sectionCombos')}</Text>

        {COMBOS.map((combo) => (
          <View key={combo.label} style={[s.comboCard, { borderColor: tokens.border, backgroundColor: tokens.accent }]}>
            <View style={s.comboItems}>
              {combo.items.map((item) => {
                const m = MODES.find((x) => x.label === item)
                const Icon = m?.icon ?? BookOpen
                return (
                  <View key={item} style={[s.comboChip, { backgroundColor: tokens.background, borderColor: tokens.border }]}>
                    <Icon size={12} color={tokens.foreground} />
                    <Text style={[s.comboChipLabel, { color: tokens.foreground }]}>{item}</Text>
                  </View>
                )
              })}
            </View>
            <Text style={[s.cardDetail, { color: tokens.foreground }]}>{combo.description}</Text>
          </View>
        ))}

        {/* Tip */}
        <View style={[s.tipBox, { borderColor: tokens.primary, backgroundColor: hslToHsla(tokens.primary, 0.12) }]}>
          <Text style={[s.tipTitle, { color: tokens.primary }]}>{t('howtoScreen.tipTitle')}</Text>
          <Text style={[s.tipText, { color: tokens.mutedForeground }]}>
            {t('howtoScreen.tipText')}
          </Text>
        </View>
      </ScrollView>
    </SafeScreen>
  )
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1 },
  backBtn: { padding: 6, borderRadius: 8 },
  headerTitle: { fontSize: 16, fontWeight: '600' },
  sectionTitle: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
  sectionDesc: { fontSize: 12, marginBottom: 16, lineHeight: 18 },
  card: { borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 1, gap: 6 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardLabel: { fontSize: 14, fontWeight: '600', flex: 1 },
  badges: { flexDirection: 'row', gap: 4 },
  badge: { fontSize: 10, fontWeight: '500', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden' },
  cardDesc: { fontSize: 12, opacity: 0.7 },
  cardDetail: { fontSize: 12, lineHeight: 18 },
  combo: { fontSize: 11, opacity: 0.6, marginTop: 2 },
  comboCard: { borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 1, gap: 8 },
  comboItems: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  comboChip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1 },
  comboChipLabel: { fontSize: 11, fontWeight: '500' },
  tipBox: { borderRadius: 14, padding: 14, marginTop: 8, borderWidth: 1, gap: 4 },
  tipTitle: { fontSize: 12, fontWeight: '600' },
  tipText: { fontSize: 12, lineHeight: 18 },
})
