import { useEffect } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, Switch } from 'react-native'
import { useRouter } from 'expo-router'
import { ArrowLeft, Bell, MessageCircle, AlertTriangle } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { useNotificationPrefsStore } from '~/stores/notification-prefs-store'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { SafeScreen } from '~/components/layout/SafeScreen'

export default function NotificationsScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const notificationPrefs = useNotificationPrefsStore((s) => s.prefs)
  const setNotificationPref = useNotificationPrefsStore((s) => s.setPref)
  const loadPrefs = useNotificationPrefsStore((s) => s.loadPrefs)

  useEffect(() => {
    void loadPrefs()
  }, [loadPrefs])

  return (
    <SafeScreen style={s.container}>
      <View style={[s.header, { borderBottomColor: tokens.border }]}>
        <Pressable onPress={() => router.back()} style={s.headerBtn}>
          <ArrowLeft size={22} color={tokens.foreground} />
        </Pressable>
        <Text style={[s.headerTitle, { color: tokens.foreground }]}>{t('notificationsScreen.title')}</Text>
        <View style={s.headerBtn} />
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <View style={[s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
          <SwitchRow
            icon={Bell}
            label={t('notificationsScreen.pendingAsk')}
            description={t('notificationsScreen.pendingAskDescription')}
            value={notificationPrefs.pendingAsk}
            onChange={(v) => setNotificationPref('pendingAsk', v)}
          />
          <RowDivider />
          <SwitchRow
            icon={MessageCircle}
            label={t('notificationsScreen.newMessage')}
            description={t('notificationsScreen.newMessageDescription')}
            value={notificationPrefs.newMessage}
            onChange={(v) => setNotificationPref('newMessage', v)}
          />
          <RowDivider />
          <SwitchRow
            icon={AlertTriangle}
            label={t('notificationsScreen.chatError')}
            description={t('notificationsScreen.chatErrorDescription')}
            value={notificationPrefs.chatError}
            onChange={(v) => setNotificationPref('chatError', v)}
          />
        </View>
      </ScrollView>
    </SafeScreen>
  )
}

function SwitchRow({
  icon: Icon,
  label,
  description,
  value,
  onChange,
}: {
  icon: typeof Bell
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
})
