import { useEffect, useState } from 'react'
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { FolderSearch } from 'lucide-react-native'
import { useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { useSessionStore } from '~/stores/session-store'
import { useInitProjectStore } from '~/stores/init-project-store'
import { shouldOfferInit } from '~/lib/init-project'
import { normalizePath } from '~/lib/known-folders'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

/**
 * Welcome card of code mode for a folder nobody analyzed yet — mirror of the desktop
 * InitProjectCard. "Analyze" opens a NEW chat in the folder and sends /init (the desktop runs its
 * analysis pipeline); progress is followed in that conversation, not here. "Later" hides the card
 * for this folder for 30 days.
 */
export function InitProjectCard({ directory, sessionId }: { directory: string; sessionId?: string }) {
  const { t } = useTranslation()
  const router = useRouter()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const sessions = useSessionStore((s) => s.sessions)
  const key = normalizePath(directory)
  const initialized = useInitProjectStore((s) => s.initialized[key])
  const running = useInitProjectStore((s) => s.running[key])
  const dismissed = useInitProjectStore((s) => s.dismissed)
  const hydrated = useInitProjectStore((s) => s.hydrated)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void useInitProjectStore.getState().hydrate()
    void useInitProjectStore.getState().check(directory)
  }, [directory])

  if (!hydrated || !shouldOfferInit({ directory, currentSessionId: sessionId, sessions, initialized, running, dismissed: Object.keys(dismissed) })) {
    return null
  }

  const analyze = async () => {
    if (busy) return
    setBusy(true)
    try {
      const store = useSessionStore.getState()
      const session = await store.createSession('code')
      if (!session) return
      useInitProjectStore.getState().dismiss(directory)
      await store.sendMessage('/init', { sessionId: session.id, directory, options: { initMode: true } })
      router.push({ pathname: '/(main)/chat/[id]', params: { id: session.id } })
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={[s.card, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
      <FolderSearch size={20} color={tokens.primary} style={{ marginTop: 2 }} />
      <View style={{ flex: 1 }}>
        <Text style={[s.title, { color: tokens.foreground }]}>{t('initProject.title')}</Text>
        <Text style={[s.desc, { color: tokens.mutedForeground }]}>{t('initProject.description')}</Text>
        <View style={s.actions}>
          <Pressable onPress={() => void analyze()} disabled={busy} style={[s.primaryBtn, { backgroundColor: tokens.primary }]} accessibilityRole="button">
            {busy ? <ActivityIndicator size="small" color={tokens.primaryForeground} /> : null}
            <Text style={[s.primaryText, { color: tokens.primaryForeground }]}>{t('initProject.analyze')}</Text>
          </Pressable>
          <Pressable onPress={() => useInitProjectStore.getState().dismiss(directory)} style={s.ghostBtn} accessibilityRole="button">
            <Text style={[s.ghostText, { color: tokens.mutedForeground }]}>{t('initProject.later')}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  card: { flexDirection: 'row', gap: 12, borderWidth: 1, borderRadius: 14, padding: 12, marginHorizontal: 12, marginBottom: 8 },
  title: { fontSize: 14, fontWeight: '600' },
  desc: { fontSize: 12.5, lineHeight: 17, marginTop: 2 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 10, paddingHorizontal: 14, height: 36, justifyContent: 'center' },
  primaryText: { fontSize: 13, fontWeight: '600' },
  ghostBtn: { paddingHorizontal: 10, height: 36, justifyContent: 'center' },
  ghostText: { fontSize: 13 },
})
