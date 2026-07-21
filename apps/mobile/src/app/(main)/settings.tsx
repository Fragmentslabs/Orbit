import { useEffect, useState } from 'react'
import { View, Text, ScrollView, Pressable, Switch, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { Image } from 'expo-image'
import { Appearance, useColorScheme } from 'react-native'
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
  AlertTriangle,
  ChevronRight,
  Sun,
  Moon,
  List,
  Square,
  Layers,
} from 'lucide-react-native'
import { useConnectionStore } from '~/stores/connection-store'
import { useSettingsStore } from '~/stores/settings-store'
import { useAppearanceStore } from '~/stores/appearance-store'
import { useThemeStore, type ThemePreference } from '~/stores/theme-store'
import { Spin } from '~/components/ui/spin'
import { getThemeTokens, type ThemeTokens } from '~/lib/theme-tokens'
import { useNotificationPrefsStore } from '~/stores/notification-prefs-store'

interface CompanionPreferences {
  brain: boolean
  brainContext: boolean
  permissionMode: 'ask' | 'approve' | 'full'
  reasoning: boolean
  reasoningLevel: 'off' | 'low' | 'medium' | 'high'
  simple: boolean
}

const PERMISSION_MODES: { id: CompanionPreferences['permissionMode']; label: string }[] = [
  { id: 'ask', label: 'Perguntar' },
  { id: 'approve', label: 'Aprovar' },
  { id: 'full', label: 'Total' },
]

const REASONING_LEVELS: { id: CompanionPreferences['reasoningLevel']; label: string }[] = [
  { id: 'low', label: 'Baixo' },
  { id: 'medium', label: 'Médio' },
  { id: 'high', label: 'Alto' },
]

export default function SettingsScreen() {
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

  const notificationPrefs = useNotificationPrefsStore((s) => s.prefs)
  const setNotificationPref = useNotificationPrefsStore((s) => s.setPref)

  const systemScheme = useColorScheme()
  const systemIsDark = systemScheme !== 'light'
  const themePref = useThemeStore((s) => s.preference)
  const setThemePref = useThemeStore((s) => s.setPreference)
  const displayMode = useAppearanceStore((s) => s.displayMode)
  const setDisplayMode = useAppearanceStore((s) => s.setDisplayMode)

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
      : 'Não definido'

  return (
    <SafeAreaView style={[s.container, { backgroundColor: tokens.background }]} edges={['top']}>
      {/* Header */}
      <View style={[s.header, { borderBottomColor: tokens.border, backgroundColor: tokens.background }]}>
        <Pressable onPress={() => router.back()} style={s.headerBtn}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <Text style={[s.headerTitle, { color: tokens.foreground }]}>Configurações</Text>
        <Pressable onPress={handleRefresh} disabled={refreshing || loading} style={s.headerBtn}>
          <Spin active={refreshing || loading}>
            <RefreshCw size={18} color={tokens.mutedForeground} />
          </Spin>
        </Pressable>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 48 }}>
        {/* ── Conexão ─────────────────────────────────────────────── */}
        <Text style={[s.sectionLabel, { color: tokens.mutedForeground }]}>Conexão</Text>
        <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          <Row icon={Wifi} label="Status" value={connection.status === 'connected' ? 'Conectado' : 'Desconectado'} />
          <RowDivider />
          <Row icon={Monitor} label="Desktop" value={connection.deviceName ?? config?.host ?? '—'} />
          <RowDivider />
          <Row icon={LogOut} label="Desconectar" destructive onPress={handleDisconnect} />
        </View>

        {/* ── Provedores ──────────────────────────────────────────── */}
        <Text style={[s.sectionLabel, { color: tokens.mutedForeground }]}>Provedores</Text>
        <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          {connectedProviders.length === 0 ? (
            <Text style={[s.emptyText, { color: tokens.mutedForeground }]}>
              Nenhum provedor conectado. As credenciais são gerenciadas no Orbit Desktop.
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
            Para adicionar ou remover provedores, use as configurações do Orbit Desktop.
          </Text>
        </View>

        {/* ── Modelo ──────────────────────────────────────────────── */}
        <Text style={[s.sectionLabel, { color: tokens.mutedForeground }]}>Modelo</Text>
        <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          <Row icon={Cpu} label="Modelo ativo" value={selectedModelName} />
        </View>

        {/* ── Preferências (sincronizadas com o desktop) ──────────── */}
        <Text style={[s.sectionLabel, { color: tokens.mutedForeground }]}>Preferências</Text>
        <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          <SwitchRow
            icon={BrainCircuit}
            label="Memória (Brain)"
            value={preferences?.brain ?? true}
            onChange={(v) => setPref({ brain: v })}
          />
          <RowDivider />
          <SwitchRow
            icon={BrainCircuit}
            label="Contexto automático"
            description="Injeta memórias relevantes no prompt"
            value={preferences?.brainContext ?? true}
            onChange={(v) => setPref({ brainContext: v })}
          />
          <RowDivider />
          <SwitchRow
            icon={Brain}
            label="Raciocínio"
            value={preferences?.reasoning ?? false}
            onChange={(v) => setPref({ reasoning: v })}
          />
          {preferences?.reasoning ? (
            <>
              <RowDivider />
              <View style={s.segmentRow}>
                <Text style={[s.segmentLabel, { color: tokens.foreground }]}>Nível</Text>
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
            label="Modo simples"
            description="Respostas diretas, sem formatação"
            value={preferences?.simple ?? false}
            onChange={(v) => setPref({ simple: v })}
          />
          <RowDivider />
          <View style={s.segmentRow}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Shield size={18} color={tokens.mutedForeground} />
              <Text style={[s.rowLabel, { color: tokens.foreground }]}>Permissões</Text>
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
        </View>

        {/* ── Notificações ──────────────────────────────────────────── */}
        <Text style={[s.sectionLabel, { color: tokens.mutedForeground }]}>Notificações</Text>
        <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          <SwitchRow
            icon={Bell}
            label="Perguntas do desktop"
            description="Quando o Orbit precisar de permissão ou resposta"
            value={notificationPrefs.pendingAsk}
            onChange={(v) => setNotificationPref('pendingAsk', v)}
          />
          <RowDivider />
          <SwitchRow
            icon={MessageCircle}
            label="Nova mensagem"
            description="Quando o assistente responder (sessão inativa)"
            value={notificationPrefs.newMessage}
            onChange={(v) => setNotificationPref('newMessage', v)}
          />
          <RowDivider />
          <SwitchRow
            icon={AlertTriangle}
            label="Erro no chat"
            description="Quando ocorrer um erro durante o processamento"
            value={notificationPrefs.chatError}
            onChange={(v) => setNotificationPref('chatError', v)}
          />
        </View>

        {/* ── Ferramentas ─────────────────────────────────────────── */}
        <Text style={[s.sectionLabel, { color: tokens.mutedForeground }]}>Ferramentas</Text>
        <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          <Row
            icon={Puzzle}
            label="MCPs e Skills"
            onPress={() => router.push('/(main)/tools')}
            chevron
          />
        </View>

        {/* ── Aparência ──────────────────────────────────────────── */}
        <Text style={[s.sectionLabel, { color: tokens.mutedForeground }]}>Aparência</Text>
        <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card, padding: 16, gap: 12 }]}>
          <Text style={[s.cardLabel, { color: tokens.foreground }]}>Tema</Text>
          <View style={s.permissionRow}>
            {(['light', 'dark', 'system'] as ThemePreference[]).map((value) => {
              const active = themePref === value
              const icons = { light: Sun, dark: Moon, system: Monitor }
              const labels = { light: 'Claro', dark: 'Escuro', system: 'Sistema' }
              const Icon = icons[value]
              return (
                <Pressable
                  key={value}
                  onPress={() => {
                    setThemePref(value, systemIsDark)
                    Appearance.setColorScheme(value === 'system' ? (systemIsDark ? 'dark' : 'light') : value)
                  }}
                  style={[
                    s.permissionChip,
                    active
                      ? { backgroundColor: tokens.background, borderColor: tokens.border }
                      : { backgroundColor: tokens.muted, borderColor: tokens.border },
                  ]}
                >
                  <Icon size={16} color={active ? tokens.primary : tokens.mutedForeground} />
                  <Text style={[s.permissionChipLabel, { color: active ? tokens.primary : tokens.mutedForeground }]}>
                    {labels[value]}
                  </Text>
                </Pressable>
              )
            })}
          </View>

          <RowDivider />

          <Text style={[s.cardLabel, { color: tokens.foreground }]}>Modos de exibição</Text>
          <View style={s.permissionRow}>
            {(['toggles', 'actions', 'both'] as const).map((value) => {
              const active = displayMode === value
              const icons = { toggles: List, actions: Square, both: Layers }
              const labels = { toggles: 'Toggles', actions: 'Ações', both: 'Ambos' }
              const Icon = icons[value]
              return (
                <Pressable
                  key={value}
                  onPress={() => setDisplayMode(value)}
                  style={[
                    s.permissionChip,
                    active
                      ? { backgroundColor: tokens.background, borderColor: tokens.border }
                      : { backgroundColor: tokens.muted, borderColor: tokens.border },
                  ]}
                >
                  <Icon size={16} color={active ? tokens.primary : tokens.mutedForeground} />
                  <Text style={[s.permissionChipLabel, { color: active ? tokens.primary : tokens.mutedForeground }]}>
                    {labels[value]}
                  </Text>
                </Pressable>
              )
            })}
          </View>
        </View>

        {/* ── Informações ──────────────────────────────────────────── */}
        <Text style={[s.sectionLabel, { color: tokens.mutedForeground }]}>Informações</Text>
        <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          <Row icon={BookOpen} label="Como funciona" onPress={() => router.push('/(main)/howto')} chevron />
        </View>

        <View style={s.footer}>
          <Text style={[s.footerText, { color: tokens.mutedForeground }]}>Orbit Mobile v1.0.0</Text>
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
  cardLabel: { fontSize: 13, fontWeight: '600' },
  permissionRow: {
    flexDirection: 'row',
    gap: 6,
  },
  permissionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flex: 1,
    justifyContent: 'center',
    borderWidth: 1,
  },
  permissionChipLabel: { fontSize: 12, fontWeight: '500' },
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
