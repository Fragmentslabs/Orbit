import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { Ellipsis, Pin, PinOff, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react-native'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { ListHeader, useTokens } from '~/components/list/parts'
import { ActionMenu } from '~/components/ui/action-menu'
import { PieceView } from '~/components/chat/PieceView'
import { FragmentAskBar } from '~/components/fragments/FragmentAskBar'
import { FragmentPermissionsSheet } from '~/components/fragments/FragmentPermissionsSheet'
import { fragmentsCall } from '~/lib/fragments-api'
import { fragmentHostUrl, parseFragmentMessage, replyScript, themeScript } from '~/lib/fragments-bridge'
import { useFragmentsStore } from '~/stores/fragments-store'
import { useThemeStore } from '~/stores/theme-store'

/**
 * A fragment on the phone: its page in a web view, and a courier between the page's `window.orbit`
 * and the desktop. Every call the page makes goes to the desktop's broker over the socket — the
 * declared-and-granted rule and the budgets are the desktop's, and nothing is granted from here.
 * The page reloads by itself when the agent rewrites it (the revision moves).
 */
export default function FragmentScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const tokens = useTokens()
  const insets = useSafeAreaInsets()
  const { id } = useLocalSearchParams<{ id: string }>()
  const resolved = useThemeStore((st) => st.resolved)
  const entry = useFragmentsStore((st) => st.entries.find((e) => e.id === id))
  const loaded = useFragmentsStore((st) => st.loaded)
  const refresh = useFragmentsStore((st) => st.refresh)
  const setPinned = useFragmentsStore((st) => st.setPinned)
  const [menuOpen, setMenuOpen] = useState(false)
  const [permissionsOpen, setPermissionsOpen] = useState(false)
  const [reloads, setReloads] = useState(0)
  const inject = useRef<((js: string) => void) | null>(null)

  useEffect(() => {
    // Opened from a deep link or a chat card before the list was ever read.
    if (!loaded) void refresh()
  }, [loaded, refresh])

  // The page is told the theme of the app again when it changes while it is open (the web view is also
  // remounted by its own address, which carries the theme; this keeps a live page in step).
  useEffect(() => {
    inject.current?.(themeScript(resolved))
  }, [resolved])

  const onMessage = useCallback(
    (raw: string) => {
      const message = parseFragmentMessage(raw)
      if (!message || message.type !== 'call' || !id) return
      void fragmentsCall(id, message.method, message.params).then((result) => {
        inject.current?.(replyScript(message.id, result))
      })
    },
    [id],
  )

  if (!entry) {
    return (
      <SafeScreen>
        <ListHeader title={t('fragments.title')} onBack={() => router.back()} />
        <View style={s.center}>
          {loaded ? <Text style={{ color: tokens.mutedForeground }}>{t('fragments.notFound')}</Text> : <ActivityIndicator color={tokens.mutedForeground} />}
        </View>
      </SafeScreen>
    )
  }

  return (
    <SafeScreen>
      <ListHeader
        title={entry.name}
        onBack={() => router.back()}
        right={
          <Pressable onPress={() => setMenuOpen(true)} hitSlop={8} style={s.iconBtn} accessibilityRole="button" accessibilityLabel={t('fragments.more')}>
            <Ellipsis size={22} color={tokens.foreground} />
          </Pressable>
        }
      />
      <View style={{ flex: 1 }}>
        <FragmentAskBar entry={entry} />
        <PieceView
          bare
          key={reloads}
          src={fragmentHostUrl(entry.url, resolved)}
          revision={entry.revision}
          title={entry.name}
          errorLabel={t('fragments.pageError')}
          onMessage={onMessage}
          onReady={(fn) => {
            inject.current = fn
          }}
        />
      </View>
      {entry.sessionId ? (
        <View style={[s.footer, { borderTopColor: tokens.border, paddingBottom: Math.max(insets.bottom, 10) }]}>
          <Pressable
            onPress={() => router.push({ pathname: '/(main)/chat/[id]', params: { id: entry.sessionId as string } })}
            accessibilityRole="button"
            style={[s.edit, { borderColor: tokens.border, backgroundColor: tokens.card }]}
          >
            <Sparkles size={15} color={tokens.mutedForeground} />
            <Text style={{ fontSize: 13.5, color: tokens.mutedForeground }}>{t('fragments.edit')}</Text>
          </Pressable>
        </View>
      ) : null}

      <ActionMenu
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        items={[
          { icon: RefreshCw, label: t('fragments.reload'), onPress: () => setReloads((n) => n + 1) },
          { icon: ShieldCheck, label: t('fragments.permissions'), onPress: () => setPermissionsOpen(true) },
          {
            icon: entry.pinned ? PinOff : Pin,
            label: t(entry.pinned ? 'fragments.unpin' : 'fragments.pin'),
            onPress: () => void setPinned(entry.id, !entry.pinned),
          },
        ]}
      />
      <FragmentPermissionsSheet entry={entry} open={permissionsOpen} onClose={() => setPermissionsOpen(false)} />
    </SafeScreen>
  )
}

const s = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  footer: { paddingHorizontal: 16, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth },
  edit: { height: 44, borderRadius: 22, borderWidth: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16 },
})
