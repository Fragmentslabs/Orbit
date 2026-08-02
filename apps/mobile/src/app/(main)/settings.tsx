import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { View, Text, ScrollView, Pressable, Switch, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { Image } from 'expo-image'
import {
  ArrowLeft,
  Bell,
  BellOff,
  BookOpen,
  RefreshCw,
  Wifi,
  Monitor,
  LogOut,
  Cpu,
  Shield,
  Brain,
  BrainCircuit,
  AlignLeft,
  MessageCircle,
  Puzzle,
  Palette,
  AlertTriangle,
  Folder,
  Languages,
  ChevronRight,
} from 'lucide-react-native'
import { useConnectionStore } from '~/stores/connection-store'
import { useSettingsStore } from '~/stores/settings-store'
import { Spin } from '~/components/ui/spin'
import { getThemeTokens, type ThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { useNotificationPrefsStore } from '~/stores/notification-prefs-store'
import { useLocaleStore, LOCALE_LABELS, SUPPORTED_LOCALES, type AppLocale } from '~/stores/locale-store'

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
    { id: 'ask', label: t('settings.preferences.permissionModes.ask') },
    { id: 'approve', label: t('settings.preferences.permissionModes.approve') },
    { id: 'full', label: t('settings.preferences.permissionModes.full') },
  ]
}

function useReasoningLevels(): { id: CompanionPreferences['reasoningLevel']; label: string }[] {
  const { t } = useTranslation()
  return [
    { id: 'low', label: t('settings.preferences.reasoningLevels.low') },
    { id: 'medium', label: t('settings.preferences.reasoningLevels.medium') },
    { id: 'high', label: t('settings.preferences.reasoningLevels.high') },
  ]
}

export default function SettingsScreen() {
  const { t } = useTranslation()
  const PERMISSION_MODES = usePermissionModes()
  const REASONING_LEVELS = useReasoningLevels()
  const locale = useLocaleStore((s) => s.locale)
  const setLocale = useLocaleStore((s) => s.setLocale)
  const router = useRouter()
  const connection = useConnectionStore((s) => s.connection)
  const config = useConnectionStore((s) => s.config)
  const disconnect = useConnectionStore((s) => s.disconnect)
  const clearSavedConfig = useConnectionStore((s) => s.clearSavedConfig)

  const selectedModel = useSettingsStore((s) => s.selectedModel)
  const catalog = useSettingsStore((s) => s.catalog)
  const connectedProviders = useSettingsStore((s) => s.connectedProviders)
  const preferences = useSettingsStore((s) => s.preferences) as CompanionPreferences | null
  const updatePreferences = useSettingsStore((s) => s.updatePreferences)
  const fetchPreferences = useSettingsStore((s) => s.fetchPreferences)
  const fetchSelectedModel = useSettingsStore((s) => s.fetchSelectedModel)
  const fetchConnectedProviders = useSettingsStore((s) => s.fetchConnectedProviders)
  const loading = useSettingsStore((s) => s.loading)

  const autoCreateFolders = useSettingsStore((s) => s.autoCreateFolders)
  const setAutoCreateFolders = useSettingsStore((s) => s.setAutoCreateFolders)

  const notificationPrefs = useNotificationPrefsStore((s) => s.prefs)
  const setNotificationPref = useNotificationPrefsStore((s) => s.setPref)

  const [refreshing, setRefreshing] = useState(false)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  useEffect(() => {
    void fetchPreferences()
    void fetchSelectedModel()
    void fetchConnectedProviders()
  }, [])

  const handleRefresh = async () => {
    setRefreshing(true)
    await Promise.all([fetchPreferences(), fetchSelectedModel(), fetchConnectedProviders()])
    setRefreshing(false)
  }

  const handleDisconnect = async () => {
    disconnect()
    await clearSavedConfig()
    router.replace('/(connection)')
  }

  const setPref = (patch: Partial<CompanionPreferences>) => {
    void updatePreferences(patch)
  }

  const selectedModelName =
    selectedModel && catalog
      ? catalog[selectedModel.providerId]?.models[selectedModel.modelId]?.name ?? selectedModel.modelId
      : t('settings.model.notSet')

  return (
    <SafeAreaView style={[s.container, { backgroundColor: tokens.background }]} edges={['top']}>
      {/* Header */}
      <View style={[s.header, { borderBottomColor: tokens.border, backgroundColor: tokens.background }]}>
        <Pressable onPress={() => router.back()} style={s.headerBtn}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <Text style={[s.headerTitle, { color: tokens.foreground }]}>{t('settings.title')}</Text>
        <Pressable onPress={handleRefresh} disabled={refreshing || loading} style={s.headerBtn}>
          <Spin active={refreshing || loading}>
            <RefreshCw size={18} color={tokens.mutedForeground} />
          </Spin>
        </Pressable>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 48 }}>
        {/* ── Conexão ─────────────────────────────────────────────── */}
        <Text style={[s.sectionLabel, { color: tokens.mutedForeground }]}>{t('settings.connection.sectionLabel')}</Text>
        <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          <Row icon={Wifi} label={t('settings.connection.status')} value={connection.status === 'connected' ? t('settings.connection.connected') : t('settings.connection.disconnected')} />
          <RowDivider />
          <Row icon={Monitor} label={t('settings.connection.desktop')} value={connection.deviceName ?? config?.host ?? '—'} />
          <RowDivider />
          <Row icon={LogOut} label={t('settings.connection.disconnect')} destructive onPress={handleDisconnect} />
        </View>

        {/* ── Provedores ──────────────────────────────────────────── */}
        <Text style={[s.sectionLabel, { color: tokens.mutedForeground }]}>{t('settings.providers.sectionLabel')}</Text>
        <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          {connectedProviders.length === 0 ? (
            <Text style={[s.emptyText, { color: tokens.mutedForeground }]}>
              {t('settings.providers.none')}
            </Text>
          ) : (
            <View style={s.providersWrap}>
              {connectedProviders.map((id) => (
                <View key={id} style={[s.providerChip, { borderColor: tokens.border, backgroundColor: tokens.muted }]}>
                  <Image
                    source={`https://models.dev/logos/${id}.svg`}
                    style={{ width: 14, height: 14 }}
                    contentFit="contain"
                  />
                  <Text style={[s.providerChipText, { color: tokens.foreground }]}>{catalog?.[id]?.name ?? id}</Text>
                </View>
              ))}
            </View>
          )}
          <Text style={[s.helperText, { color: tokens.mutedForeground }]}>
            {t('settings.providers.helper')}
          </Text>
        </View>

        {/* ── Modelo ──────────────────────────────────────────────── */}
        <Text style={[s.sectionLabel, { color: tokens.mutedForeground }]}>{t('settings.model.sectionLabel')}</Text>
        <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          <Row icon={Cpu} label={t('settings.model.active')} value={selectedModelName} />
        </View>

        {/* ── Preferências (sincronizadas com o desktop) ──────────── */}
        <Text style={[s.sectionLabel, { color: tokens.mutedForeground }]}>{t('settings.preferences.sectionLabel')}</Text>
        <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          <SwitchRow
            icon={BrainCircuit}
            label={t('settings.preferences.brain')}
            value={preferences?.brain ?? true}
            onChange={(v) => setPref({ brain: v })}
          />
          <RowDivider />
          <SwitchRow
            icon={BrainCircuit}
            label={t('settings.preferences.autoContext')}
            description={t('settings.preferences.autoContextDescription')}
            value={preferences?.brainContext ?? true}
            onChange={(v) => setPref({ brainContext: v })}
          />
          <RowDivider />
          <SwitchRow
            icon={Brain}
            label={t('settings.preferences.reasoning')}
            value={preferences?.reasoning ?? false}
            onChange={(v) => setPref({ reasoning: v })}
          />
          {preferences?.reasoning ? (
            <>
              <RowDivider />
              <View style={s.segmentRow}>
                <Text style={[s.segmentLabel, { color: tokens.foreground }]}>{t('settings.preferences.level')}</Text>
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
            label={t('settings.preferences.simple')}
            description={t('settings.preferences.simpleDescription')}
            value={preferences?.simple ?? false}
            onChange={(v) => setPref({ simple: v })}
          />
          <RowDivider />
          <View style={s.segmentRow}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Shield size={18} color={tokens.mutedForeground} />
              <Text style={[s.rowLabel, { color: tokens.foreground }]}>{t('settings.preferences.permissions')}</Text>
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
            label={t('settings.preferences.autoFolders')}
            description={t('settings.preferences.autoFoldersDescription')}
            value={autoCreateFolders}
            onChange={setAutoCreateFolders}
          />
        </View>

        {/* ── Notificações ──────────────────────────────────────────── */}
        <Text style={[s.sectionLabel, { color: tokens.mutedForeground }]}>{t('settings.notifications.sectionLabel')}</Text>
        <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          <SwitchRow
            icon={Bell}
            label={t('settings.notifications.pendingAsk')}
            description={t('settings.notifications.pendingAskDescription')}
            value={notificationPrefs.pendingAsk}
            onChange={(v) => setNotificationPref('pendingAsk', v)}
          />
          <RowDivider />
          <SwitchRow
            icon={MessageCircle}
            label={t('settings.notifications.newMessage')}
            description={t('settings.notifications.newMessageDescription')}
            value={notificationPrefs.newMessage}
            onChange={(v) => setNotificationPref('newMessage', v)}
          />
          <RowDivider />
          <SwitchRow
            icon={AlertTriangle}
            label={t('settings.notifications.chatError')}
            description={t('settings.notifications.chatErrorDescription')}
            value={notificationPrefs.chatError}
            onChange={(v) => setNotificationPref('chatError', v)}
          />
        </View>

        {/* ── Ferramentas ─────────────────────────────────────────── */}
        <Text style={[s.sectionLabel, { color: tokens.mutedForeground }]}>{t('settings.tools.sectionLabel')}</Text>
        <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          <Row
            icon={Puzzle}
            label={t('settings.tools.mcpSkills')}
            onPress={() => router.push('/(main)/tools')}
            chevron
          />
        </View>

        {/* ── Aparência ──────────────────────────────────────────── */}
        <Text style={[s.sectionLabel, { color: tokens.mutedForeground }]}>{t('settings.appearanceSection.sectionLabel')}</Text>
        <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          <Row icon={Palette} label={t('settings.appearanceSection.themeAndModes')} onPress={() => router.push('/(main)/appearance')} chevron />
        </View>

        {/* ── Idioma ──────────────────────────────────────────────── */}
        <Text style={[s.sectionLabel, { color: tokens.mutedForeground }]}>{t('settings.language.sectionLabel')}</Text>
        <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          <View style={s.segmentRow}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Languages size={18} color={tokens.mutedForeground} />
              <Text style={[s.rowLabel, { color: tokens.foreground }]}>{t('settings.language.sectionLabel')}</Text>
            </View>
            <View style={[s.segmentGroup, { backgroundColor: tokens.border }]}>
              {SUPPORTED_LOCALES.map((loc) => (
                <Pressable
                  key={loc}
                  onPress={() => setLocale(loc)}
                  style={[s.segment, locale === loc && { backgroundColor: tokens.primary }]}
                >
                  <Text
                    style={[s.segmentText, { color: tokens.mutedForeground }, locale === loc && { color: tokens.primaryForeground }]}
                  >
                    {LOCALE_LABELS[loc]}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
          <Text style={[s.helperText, { color: tokens.mutedForeground }]}>{t('settings.language.description')}</Text>
        </View>

        {/* ── Informações ──────────────────────────────────────────── */}
        <Text style={[s.sectionLabel, { color: tokens.mutedForeground }]}>{t('settings.info.sectionLabel')}</Text>
        <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          <Row icon={BookOpen} label={t('settings.info.howItWorks')} onPress={() => router.push('/(main)/howto')} chevron />
        </View>

        <View style={s.footer}>
          <Text style={[s.footerText, { color: tokens.mutedForeground }]}>{t('settings.footer')}</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

function Row({
  icon: Icon,
  label,
  value,
  onPress,
  destructive,
  chevron,
}: {
  icon: typeof Wifi
  label: string
  value?: string
  onPress?: () => void
  destructive?: boolean
  chevron?: boolean
}) {
  const t = getThemeTokens(useThemeStore((s) => s.resolved))
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={s.row}>
      <Icon size={18} color={destructive ? '#ff3344' : t.mutedForeground} />
      <Text style={[s.rowLabel, { color: destructive ? '#ff3344' : t.foreground }, { flex: 1 }]}>{label}</Text>
      {value ? (
        <Text style={[s.rowValue, { color: t.mutedForeground }]} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {chevron ? <ChevronRight size={15} color={t.mutedForeground} /> : null}
    </Pressable>
  )
}

function SwitchRow({
  icon: Icon,
  label,
  description,
  value,
  onChange,
}: {
  icon: typeof Wifi
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

  sectionLabel: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 8,
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  card: {
    marginHorizontal: 16,
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 13 },
  rowDivider: { height: 1, marginLeft: 46 },
  rowLabel: { fontSize: 14 },
  rowDesc: { fontSize: 11, marginTop: 2 },
  rowValue: { fontSize: 12, maxWidth: 160 },

  emptyText: { padding: 16, fontSize: 13, lineHeight: 19 },
  helperText: { paddingHorizontal: 16, paddingBottom: 12, fontSize: 11 },
  providersWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 16, paddingBottom: 8 },
  providerChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 9999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  providerChipText: { fontSize: 12, fontWeight: '500' },

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
  segmentActive: {},
  segmentText: { fontSize: 12, fontWeight: '500' },
  segmentTextActive: {},

  footer: { alignItems: 'center', paddingTop: 32 },
  footerText: { fontSize: 11 },
})
