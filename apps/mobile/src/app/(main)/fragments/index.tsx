import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { Pin, PinOff, Plus, Trash2 } from 'lucide-react-native'
import type { FragmentPhoneEntry } from '@orbit/shared'
import { SafeScreen } from '~/components/layout/SafeScreen'
import { ListHeader, SearchField, useTokens } from '~/components/list/parts'
import { BottomSheet } from '~/components/ui/bottom-sheet'
import { useConfirm } from '~/components/ui/confirm-dialog'
import { FragmentThumb } from '~/components/fragments/FragmentThumb'
import { shortAge } from '~/lib/git-format'
import { orderFragments } from '~/lib/fragments-order'
import { useDraftInput } from '~/stores/draft-input-store'
import { useFragmentsStore } from '~/stores/fragments-store'

/**
 * The fragments of the desktop, as a grid: the pages the agent builds with you (a tracker, a
 * dashboard, a tool). The phone only uses them — building and editing stay in the chat, which is
 * where the agent is. Pinned ones (the desktop's sidebar entry) come first.
 */
export default function FragmentsScreen() {
  const { t } = useTranslation()
  const router = useRouter()
  const tokens = useTokens()
  const insets = useSafeAreaInsets()
  const entries = useFragmentsStore((s) => s.entries)
  const loaded = useFragmentsStore((s) => s.loaded)
  const error = useFragmentsStore((s) => s.error)
  const refresh = useFragmentsStore((s) => s.refresh)
  const remove = useFragmentsStore((s) => s.remove)
  const confirm = useConfirm()
  const setPinned = useFragmentsStore((s) => s.setPinned)
  // The card the person is holding: the sheet offers to pin it here or delete it.
  const [held, setHeld] = useState<FragmentPhoneEntry | null>(null)
  const [query, setQuery] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const { width: screenWidth } = useWindowDimensions()
  // Two columns with 12px of margin on each side and 10px between them.
  const cardWidth = Math.floor((screenWidth - 24 - 10) / 2)

  useEffect(() => {
    void refresh()
  }, [refresh])

  const shown = useMemo(() => orderFragments(entries, query), [entries, query])

  const pull = useCallback(async () => {
    setRefreshing(true)
    await refresh()
    setRefreshing(false)
  }, [refresh])

  const ask = () => {
    // Creating is the agent's work: a new chat with the request started for the person to finish.
    useDraftInput.getState().setDraft(null, t('fragments.askPrefill'))
    router.push('/(main)')
  }

  const age = (entry: FragmentPhoneEntry) => {
    const a = shortAge(new Date(entry.updatedAt).toISOString())
    return a === 'now' ? t('fragments.justNow') : t('fragments.updated', { age: a })
  }

  return (
    <SafeScreen>
      <ListHeader title={t('fragments.title')} subtitle={t('fragments.subtitle')} onBack={() => router.back()} />
      <View style={{ flexDirection: 'row', paddingHorizontal: 12, paddingTop: 10, paddingBottom: 6 }}>
        <SearchField value={query} onChange={setQuery} placeholder={t('fragments.search')} />
      </View>

      {!loaded ? (
        <View style={s.center}>
          <ActivityIndicator color={tokens.mutedForeground} />
        </View>
      ) : error && entries.length === 0 ? (
        <View style={s.center}>
          <Text style={{ color: tokens.destructive, textAlign: 'center', paddingHorizontal: 24 }}>{t('fragments.loadFailed', { error })}</Text>
          <Pressable onPress={() => void refresh()} style={[s.retry, { borderColor: tokens.border }]}>
            <Text style={{ color: tokens.foreground, fontWeight: '600' }}>{t('filesBrowser.retry')}</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={shown}
          keyExtractor={(e) => e.id}
          numColumns={2}
          columnWrapperStyle={{ gap: 10, paddingHorizontal: 12 }}
          contentContainerStyle={{ gap: 10, paddingTop: 6, paddingBottom: 96 + insets.bottom }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={pull} />}
          ListEmptyComponent={
            <View style={s.center}>
              <Text style={{ color: tokens.foreground, fontWeight: '600', fontSize: 15 }}>{query ? t('fragments.noMatch') : t('fragments.emptyTitle')}</Text>
              {!query ? <Text style={{ color: tokens.mutedForeground, textAlign: 'center', paddingHorizontal: 32 }}>{t('fragments.emptyHint')}</Text> : null}
            </View>
          }
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push({ pathname: '/(main)/fragments/[id]', params: { id: item.id } })}
              onLongPress={() => setHeld(item)}
              delayLongPress={350}
              accessibilityRole="button"
              accessibilityHint={t('fragments.holdHint')}
              style={({ pressed }) => [s.card, { borderColor: tokens.border, backgroundColor: tokens.card }, pressed && { opacity: 0.7 }]}
            >
              <FragmentThumb entry={item} width={cardWidth - 2} height={COVER_HEIGHT} />
              <View style={{ paddingHorizontal: 12, paddingVertical: 10 }}>
                <Text numberOfLines={1} style={{ fontSize: 14, fontWeight: '600', color: tokens.foreground }}>
                  {item.name}
                </Text>
                <Text numberOfLines={1} style={{ marginTop: 2, fontSize: 11.5, color: tokens.mutedForeground }}>
                  {age(item)}
                </Text>
              </View>
            </Pressable>
          )}
        />
      )}

      <BottomSheet
        open={held !== null}
        onClose={() => setHeld(null)}
        title={<Text style={[s.sheetTitle, { color: tokens.foreground }]}>{held?.name}</Text>}
      >
        {held ? (
          <>
            <Pressable
              onPress={() => {
                void setPinned(held.id, !held.pinned)
                setHeld(null)
              }}
              accessibilityRole="button"
              style={[s.sheetRow, { borderBottomColor: tokens.border }]}
            >
              {held.pinned ? <PinOff size={18} color={tokens.foreground} /> : <Pin size={18} color={tokens.foreground} />}
              <Text style={{ fontSize: 15, color: tokens.foreground }}>{t(held.pinned ? 'fragments.unpin' : 'fragments.pin')}</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                const target = held
                setHeld(null)
                void confirm({
                  title: t('fragments.deleteTitle', { name: target.name }),
                  description: t('fragments.deleteBody'),
                  confirmLabel: t('fragments.delete'),
                  cancelLabel: t('sidebar.cancel'),
                  destructive: true,
                }).then((ok) => ok && remove(target.id))
              }}
              accessibilityRole="button"
              style={s.sheetRow}
            >
              <Trash2 size={18} color={tokens.destructive} />
              <Text style={{ fontSize: 15, color: tokens.destructive }}>{t('fragments.delete')}</Text>
            </Pressable>
          </>
        ) : null}
      </BottomSheet>

      <View style={[s.footer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <Pressable onPress={ask} accessibilityRole="button" style={[s.ask, { backgroundColor: tokens.primary }]}>
          <Plus size={18} color={tokens.primaryForeground} />
          <Text style={{ color: tokens.primaryForeground, fontWeight: '600', fontSize: 14.5 }}>{t('fragments.askNew')}</Text>
        </Pressable>
      </View>
    </SafeScreen>
  )
}

/** Height of the thumbnail: enough of the top of the page to recognize it. */
const COVER_HEIGHT = 132

const s = StyleSheet.create({
  sheetTitle: { fontSize: 16, fontWeight: '600', paddingBottom: 8 },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 15, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'transparent' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 48 },
  retry: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 10, marginTop: 8 },
  card: { flex: 1, maxWidth: '50%', borderWidth: 1, borderRadius: 16, overflow: 'hidden' },
  pin: { position: 'absolute', top: 8, right: 8, width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 16, paddingTop: 8 },
  ask: { height: 48, borderRadius: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
})
