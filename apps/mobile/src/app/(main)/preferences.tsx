import { useEffect } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, Switch } from 'react-native'
import { useRouter } from 'expo-router'
import {
  ArrowLeft,
  BrainCircuit,
  Brain,
  AlignLeft,
  Shield,
  Folder,
  Search,
  Globe,
  Eye,
  FileText,
  Bot,
  Network,
  Sparkles,
} from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '~/stores/settings-store'
import { useModelModePrefs, type ActiveModeDefaults } from '~/stores/model-mode-prefs'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { SafeScreen } from '~/components/layout/SafeScreen'

interface CompanionPreferences {
  brain: boolean
  brainContext: boolean
  permissionMode: 'ask' | 'approve' | 'full'
  reasoning: boolean
  reasoningLevel: 'off' | 'low' | 'medium' | 'high'
  simple: boolean
}

function usePermissionModes(): { id: CompanionPreferences['permissionMode']; label: string }[] {
  const { t } = useTranslation()
  return [
    { id: 'ask', label: t('preferencesScreen.permissionModes.ask') },
    { id: 'approve', label: t('preferencesScreen.permissionModes.approve') },
    { id: 'full', label: t('preferencesScreen.permissionModes.full') },
  ]
}

function useReasoningLevels(): { id: CompanionPreferences['reasoningLevel']; label: string }[] {
  const { t } = useTranslation()
  return [
    { id: 'low', label: t('preferencesScreen.reasoningLevels.low') },
    { id: 'medium', label: t('preferencesScreen.reasoningLevels.medium') },
    { id: 'high', label: t('preferencesScreen.reasoningLevels.high') },
  ]
}

export default function PreferencesScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const PERMISSION_MODES = usePermissionModes()
  const REASONING_LEVELS = useReasoningLevels()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const preferences = useSettingsStore((s) => s.preferences) as CompanionPreferences | null
  const updatePreferences = useSettingsStore((s) => s.updatePreferences)
  const fetchPreferences = useSettingsStore((s) => s.fetchPreferences)
  const autoCreateFolders = useSettingsStore((s) => s.autoCreateFolders)
  const setAutoCreateFolders = useSettingsStore((s) => s.setAutoCreateFolders)

  // Defaults configuráveis dos modos ativos, por modo (chat/código) — espelho
  // do ActiveModesSection do desktop.
  const chatActiveModes = useModelModePrefs((s) => s.chatActiveModes)
  const codeActiveModes = useModelModePrefs((s) => s.codeActiveModes)
  const setChatActiveMode = useModelModePrefs((s) => s.setChatActiveMode)
  const setCodeActiveMode = useModelModePrefs((s) => s.setCodeActiveMode)

  useEffect(() => {
    void fetchPreferences()
  }, [fetchPreferences])

  const setPref = (patch: Partial<CompanionPreferences>) => {
    void updatePreferences(patch)
  }

  return (
    <SafeScreen style={s.container}>
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.headerBtn}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <Text style={[s.headerTitle, { color: tokens.foreground }]}>{t('preferencesScreen.title')}</Text>
        <View style={s.headerBtn} />
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          <SwitchRow
            icon={BrainCircuit}
            label={t('preferencesScreen.brain')}
            value={preferences?.brain ?? true}
            onChange={(v) => setPref({ brain: v })}
          />
          <RowDivider />
          <SwitchRow
            icon={BrainCircuit}
            label={t('preferencesScreen.autoContext')}
            description={t('preferencesScreen.autoContextDescription')}
            value={preferences?.brainContext ?? true}
            onChange={(v) => setPref({ brainContext: v })}
          />
          <RowDivider />
          <SwitchRow
            icon={Brain}
            label={t('preferencesScreen.reasoning')}
            value={preferences?.reasoning ?? false}
            onChange={(v) => setPref({ reasoning: v })}
          />
          {preferences?.reasoning ? (
            <>
              <RowDivider />
              <View style={s.segmentRow}>
                <Text style={[s.segmentLabel, { color: tokens.foreground }]}>{t('preferencesScreen.level')}</Text>
                <View style={[s.segmentGroup, { backgroundColor: tokens.border }]}>
                  {REASONING_LEVELS.map((level) => (
                    <Pressable
                      key={level.id}
                      onPress={() => setPref({ reasoningLevel: level.id })}
                      style={[s.segment, preferences?.reasoningLevel === level.id && { backgroundColor: tokens.primary }]}
                    >
                      <Text
                        style={[
                          s.segmentText,
                          { color: tokens.mutedForeground },
                          preferences?.reasoningLevel === level.id && { color: tokens.primaryForeground },
                        ]}
                      >
                        {level.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            </>
          ) : null}
          <RowDivider />
          <SwitchRow
            icon={AlignLeft}
            label={t('preferencesScreen.simple')}
            description={t('preferencesScreen.simpleDescription')}
            value={preferences?.simple ?? false}
            onChange={(v) => setPref({ simple: v })}
          />
          <RowDivider />
          <View style={s.segmentRow}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Shield size={18} color={tokens.mutedForeground} />
              <Text style={[s.rowLabel, { color: tokens.foreground }]}>{t('preferencesScreen.permissions')}</Text>
            </View>
            <View style={[s.segmentGroup, { backgroundColor: tokens.border }]}>
              {PERMISSION_MODES.map((pm) => (
                <Pressable
                  key={pm.id}
                  onPress={() => setPref({ permissionMode: pm.id })}
                  style={[s.segment, preferences?.permissionMode === pm.id && { backgroundColor: tokens.primary }]}
                >
                  <Text
                    style={[s.segmentText, { color: tokens.mutedForeground }, preferences?.permissionMode === pm.id && { color: tokens.primaryForeground }]}
                  >
                    {pm.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
          <RowDivider />
          <SwitchRow
            icon={Folder}
            label={t('preferencesScreen.autoFolders')}
            description={t('preferencesScreen.autoFoldersDescription')}
            value={autoCreateFolders}
            onChange={setAutoCreateFolders}
          />
        </View>

        <View style={[s.card, s.modesCard, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          <Text style={[s.modesHeader, { color: tokens.foreground }]}>
            {t('preferencesScreen.activeModes')}
          </Text>
          <ActiveModesSection modes={chatActiveModes} onChange={setChatActiveMode} isCode={false} />
          <ActiveModesSection modes={codeActiveModes} onChange={setCodeActiveMode} isCode={true} />
        </View>
      </ScrollView>
    </SafeScreen>
  )
}

function ActiveModesSection({
  modes,
  onChange,
  isCode,
}: {
  modes: ActiveModeDefaults
  onChange: (key: keyof ActiveModeDefaults, value: boolean) => void
  isCode: boolean
}) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const items: { key: keyof ActiveModeDefaults; label: string; icon: typeof Search }[] = [
    { key: 'simple', label: t('preferencesScreen.modes.simple'), icon: AlignLeft },
    { key: 'brain', label: t('preferencesScreen.modes.brain'), icon: BrainCircuit },
    { key: 'thinking', label: t('preferencesScreen.modes.thinking'), icon: Sparkles },
    { key: 'search', label: t('preferencesScreen.modes.search'), icon: Search },
    { key: 'vision', label: t('preferencesScreen.modes.vision'), icon: Eye },
    ...(isCode ? [] : [{ key: 'browser' as const, label: t('preferencesScreen.modes.browser'), icon: Globe }]),
    ...(isCode ? [{ key: 'plan' as const, label: t('preferencesScreen.modes.plan'), icon: FileText }] : []),
    { key: 'subagents', label: t('preferencesScreen.modes.subagents'), icon: Bot },
    ...(isCode ? [{ key: 'orchestra' as const, label: t('preferencesScreen.modes.orchestra'), icon: Network }] : []),
  ]

  return (
    <View style={s.modesSection}>
      <Text style={[s.modesSubtitle, { color: tokens.mutedForeground }]}>
        {isCode ? t('preferencesScreen.codeDefaults') : t('preferencesScreen.chatDefaults')}
      </Text>
      <View style={s.chipsWrap}>
        {items.map(({ key, label, icon: Icon }) => {
          const active = modes[key]
          return (
            <Pressable
              key={key}
              onPress={() => onChange(key, !active)}
              style={[
                s.chip,
                { borderColor: tokens.border },
                active && { backgroundColor: tokens.muted, borderColor: tokens.primary },
              ]}
            >
              <Icon size={13} color={active ? tokens.primary : tokens.mutedForeground} />
              <Text style={[s.chipLabel, { color: active ? tokens.primary : tokens.mutedForeground }]}>
                {label}
              </Text>
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}

function SwitchRow({
  icon: Icon,
  label,
  description,
  value,
  onChange,
}: {
  icon: typeof BrainCircuit
  label: string
  description?: string
  value: boolean
  onChange: (value: boolean) => void
}) {
  const t = getThemeTokens(useThemeStore((s) => s.resolved))
  return (
    <View style={s.row}>
      <Icon size={18} color={t.mutedForeground} />
      <View style={{ flex: 1 }}>
        <Text style={[s.rowLabel, { color: t.foreground }]}>{label}</Text>
        {description ? <Text style={[s.rowDesc, { color: t.mutedForeground }]}>{description}</Text> : null}
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ false: t.muted, true: t.primary }} thumbColor={t.foreground} />
    </View>
  )
}

function RowDivider() {
  const t = getThemeTokens(useThemeStore((s) => s.resolved))
  return <View style={[s.rowDivider, { backgroundColor: t.border }]} />
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
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 13 },
  rowDivider: { height: 1, marginLeft: 46 },
  rowLabel: { fontSize: 14 },
  rowDesc: { fontSize: 11, marginTop: 2 },

  segmentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  segmentLabel: { fontSize: 14 },
  segmentGroup: {
    flexDirection: 'row',
    borderRadius: 10,
    padding: 2,
  },
  segment: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  segmentText: { fontSize: 12, fontWeight: '500' },

  modesCard: { marginTop: 16, padding: 16 },
  modesHeader: { fontSize: 13, fontWeight: '600', marginBottom: 12 },
  modesSection: { marginBottom: 12 },
  modesSubtitle: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  chipsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  chipLabel: { fontSize: 12, fontWeight: '500' },
})
