import { View, Text, Pressable, ScrollView, StyleSheet, Switch } from 'react-native'
import { useRouter } from 'expo-router'
import { ArrowLeft, Search, Globe, FileText, AlignLeft, BrainCircuit, Eye, Bot, Network, RefreshCw } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { useAppearanceStore, type ModeId } from '~/stores/appearance-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { SafeScreen } from '~/components/layout/SafeScreen'

/** Agrupamento dos modos por contexto de uso nos inputs — espelho do painel
 *  de aparência do desktop. */
const MODE_GROUPS: { key: 'both' | 'chat' | 'code'; ids: ModeId[] }[] = [
  { key: 'both', ids: ['search', 'plan', 'simple', 'brain', 'vision'] },
  { key: 'code', ids: ['subagents', 'orchestra', 'loop'] },
  { key: 'chat', ids: ['browser'] },
]

function useModeOptions(): { id: ModeId; label: string; icon: typeof Search }[] {
  const { t } = useTranslation()
  return [
    { id: 'search', label: t('promptInput.modes.research'), icon: Search },
    { id: 'browser', label: t('promptInput.modes.browser'), icon: Globe },
    { id: 'plan', label: t('promptInput.modes.plan'), icon: FileText },
    { id: 'simple', label: t('promptInput.modes.simple'), icon: AlignLeft },
    { id: 'brain', label: t('promptInput.modes.brain'), icon: BrainCircuit },
    { id: 'vision', label: t('promptInput.modes.vision'), icon: Eye },
    { id: 'subagents', label: t('promptInput.modes.subagents'), icon: Bot },
    { id: 'orchestra', label: t('promptInput.modes.orchestra'), icon: Network },
    { id: 'loop', label: t('promptInput.modes.loop'), icon: RefreshCw },
  ]
}

export default function ModesScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const modesInRow = useAppearanceStore((s) => s.modesInRow)
  const setModesInRow = useAppearanceStore((s) => s.setModesInRow)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const modeOptions = useModeOptions()

  const toggleMode = (id: ModeId) => {
    setModesInRow(modesInRow.includes(id) ? modesInRow.filter((m) => m !== id) : [...modesInRow, id])
  }

  return (
    <SafeScreen>
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.backBtn}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <Text style={[s.headerTitle, { color: tokens.foreground }]}>{t('appearanceScreen.bottomModes.title')}</Text>
        <View style={{ width: 34 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        <Text style={[s.hint, { color: tokens.mutedForeground, marginBottom: 16 }]}>
          {t('appearanceScreen.bottomModes.hint')}
        </Text>

        {MODE_GROUPS.map((group) => (
          <View key={group.key} style={{ marginBottom: 16 }}>
            <Text style={[s.sectionTitle, { color: tokens.mutedForeground }]}>
              {t(`appearanceScreen.bottomModes.modeGroups.${group.key}`)}
            </Text>
            <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
              {group.ids.map((id, index) => {
                const option = modeOptions.find((o) => o.id === id)
                if (!option) return null
                const Icon = option.icon
                const checked = modesInRow.includes(id)
                return (
                  <View key={id}>
                    {index > 0 && <View style={[s.divider, { backgroundColor: tokens.border }]} />}
                    <View style={s.row}>
                      <View style={s.rowLeft}>
                        <Icon size={18} color={tokens.mutedForeground} />
                        <Text style={{ flex: 1, fontSize: 14, color: tokens.foreground }}>{option.label}</Text>
                      </View>
                      <Switch
                        value={checked}
                        onValueChange={() => toggleMode(id)}
                        trackColor={{ false: tokens.muted, true: tokens.primary }}
                        thumbColor={tokens.foreground}
                      />
                    </View>
                  </View>
                )
              })}
            </View>
          </View>
        ))}
      </ScrollView>
    </SafeScreen>
  )
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1 },
  backBtn: { padding: 6, borderRadius: 8 },
  headerTitle: { fontSize: 16, fontWeight: '600' },
  sectionTitle: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  card: { borderRadius: 14, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 4 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 9 },
  rowLeft: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
  divider: { height: 1 },
  hint: { fontSize: 11, lineHeight: 16, opacity: 0.7 },
})
