import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import Constants from 'expo-constants'
import {
  ArrowLeft,
  Bell,
  BookOpen,
  RefreshCw,
  Wifi,
  Monitor,
  LogOut,
  KeyRound,
  SlidersHorizontal,
  Puzzle,
  Palette,
  Languages,
  Info,
  ChevronRight,
} from 'lucide-react-native'
import { useConnectionStore } from '~/stores/connection-store'
import { useSettingsStore } from '~/stores/settings-store'
import { Spin } from '~/components/ui/spin'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

export default function SettingsScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const connection = useConnectionStore((s) => s.connection)
  const config = useConnectionStore((s) => s.config)
  const disconnect = useConnectionStore((s) => s.disconnect)
  const clearSavedConfig = useConnectionStore((s) => s.clearSavedConfig)

  const selectedModel = useSettingsStore((s) => s.selectedModel)
  const catalog = useSettingsStore((s) => s.catalog)
  const fetchSelectedModel = useSettingsStore((s) => s.fetchSelectedModel)
  const fetchConnectedProviders = useSettingsStore((s) => s.fetchConnectedProviders)
  const loading = useSettingsStore((s) => s.loading)

  const [refreshing, setRefreshing] = useState(false)
  // Sem literal de reserva: um numero fixo aqui envelhece a cada release e
  // passaria a mentir. Faltando o expo config, a UI simplesmente omite.
  const appVersion = Constants.expoConfig?.version ?? ''

  useEffect(() => {
    void fetchSelectedModel()
    void fetchConnectedProviders()
  }, [fetchSelectedModel, fetchConnectedProviders])

  const handleRefresh = async () => {
    setRefreshing(true)
    await Promise.all([fetchSelectedModel(), fetchConnectedProviders()])
    setRefreshing(false)
  }

  const handleDisconnect = async () => {
    disconnect()
    await clearSavedConfig()
    router.replace('/(connection)')
  }

  const selectedModelName =
    selectedModel && catalog
      ? catalog[selectedModel.providerId]?.models[selectedModel.modelId]?.name ?? selectedModel.modelId
      : t('providersScreen.modelNotSet')

  return (
    <SafeScreen style={s.container}>
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

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: 16, paddingBottom: 48 }}>
        {/* ── Navegação ─────────────────────────────────────────────── */}
        <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          <Row
            icon={KeyRound}
            label={t('settings.providers')}
            value={selectedModelName}
            onPress={() => router.push('/(main)/providers')}
            chevron
          />
          <RowDivider />
          <Row
            icon={SlidersHorizontal}
            label={t('settings.preferences')}
            onPress={() => router.push('/(main)/preferences')}
            chevron
          />
          <RowDivider />
          <Row
            icon={Bell}
            label={t('settings.notifications')}
            onPress={() => router.push('/(main)/notifications')}
            chevron
          />
          <RowDivider />
          <Row
            icon={Puzzle}
            label={t('settings.tools')}
            onPress={() => router.push('/(main)/tools')}
            chevron
          />
          <RowDivider />
          <Row
            icon={Palette}
            label={t('settings.appearance')}
            onPress={() => router.push('/(main)/appearance')}
            chevron
          />
          <RowDivider />
          <Row
            icon={Languages}
            label={t('settings.language')}
            onPress={() => router.push('/(main)/language')}
            chevron
          />
          <RowDivider />
          <Row
            icon={BookOpen}
            label={t('settings.howItWorks')}
            onPress={() => router.push('/(main)/howto')}
            chevron
          />
          <RowDivider />
          <Row
            icon={Info}
            label={t('settings.about')}
            value={appVersion || undefined}
            onPress={() => router.push('/(main)/about')}
            chevron
          />
        </View>

        {/* ── Conexão ───────────────────────────────────────────────── */}
        <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card, marginTop: 16 }]}>
          <Row icon={Wifi} label={t('settings.connection.status')} value={connection.status === 'connected' ? t('settings.connection.connected') : t('settings.connection.disconnected')} />
          <RowDivider />
          <Row icon={Monitor} label={t('settings.connection.desktop')} value={connection.deviceName ?? config?.host ?? '—'} />
          <RowDivider />
          <Row icon={LogOut} label={t('settings.connection.disconnect')} destructive onPress={handleDisconnect} />
        </View>

        {/* ── Versão ────────────────────────────────────────────────── */}
        {appVersion ? (
          <View style={s.footer}>
            <Text style={[s.footerText, { color: tokens.mutedForeground }]}>{t('settings.footer', { version: appVersion })}</Text>
          </View>
        ) : null}
      </ScrollView>
    </SafeScreen>
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
    marginHorizontal: 16,
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 17 },
  rowDivider: { height: 1, marginLeft: 46 },
  rowLabel: { fontSize: 14 },
  rowValue: { fontSize: 12, maxWidth: 160 },

  footer: { alignItems: 'center', paddingTop: 32 },
  footerText: { fontSize: 11 },
})
