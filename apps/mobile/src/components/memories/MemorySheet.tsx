/**
 * Sheet of the memory cited in the conversation — the "hover card + panel tab" of the
 * desktop in a single gesture, because on the phone there is no hover.
 *
 * Tapping the chip opens this summary; the main button leads to the Memories screen already
 * focused on that memory (the `id` parameter selects the node in the graph). Closing
 * returns the person to the conversation at the same point — no lost navigation.
 *
 * It is mounted ONCE in the ChatScreen: the chips only ask the store for the id, so an
 * answer with several citations still has a single sheet.
 */
import { useEffect, useMemo, useRef } from 'react'
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { Brain, ExternalLink } from 'lucide-react-native'
import { useMemoryStore } from '~/stores/memory-store'
import { useMemorySheetStore } from '~/stores/memory-sheet-store'
import { BottomSheet } from '~/components/ui/bottom-sheet'
import { kindLabel, categoryLabel, KIND_COLOR, formatDate } from './meta'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

export function MemorySheet() {
  const { t } = useTranslation()
  const router = useRouter()
  const memoryId = useMemorySheetStore((s) => s.memoryId)
  const close = useMemorySheetStore((s) => s.close)
  const index = useMemoryStore((s) => s.index)
  const loading = useMemoryStore((s) => s.loading)
  const fetch = useMemoryStore((s) => s.fetch)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  const memory = useMemo(
    () => (memoryId ? index.find((m) => m.id === memoryId) : undefined),
    [index, memoryId],
  )

  // Citation of a memory the local index does not have (it arrived later, or the
  // list was never fetched): asks once per id. The ref avoids the loop
  // fetch → same index → fetch again while the memory does not exist.
  const fetchedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!memoryId || memory) return
    if (fetchedFor.current === memoryId) return
    fetchedFor.current = memoryId
    void fetch()
  }, [memoryId, memory, fetch])

  const openInScreen = () => {
    if (!memoryId) return
    close()
    router.push({ pathname: '/memories', params: { id: memoryId } })
  }

  const kindColor = memory ? KIND_COLOR[memory.kind] : tokens.mutedForeground

  return (
    <BottomSheet
      open={memoryId != null}
      onClose={close}
      title={
        <View style={s.title}>
          <Brain size={15} color={tokens.primary} />
          <Text style={[s.titleText, { color: tokens.foreground }]}>{t('memorySheet.title')}</Text>
        </View>
      }
    >
      {memory ? (
        <View style={s.content}>
          <Text style={[s.text, { color: tokens.foreground }]}>{memory.text}</Text>

          <View style={s.badges}>
            <View style={[s.kindBadge, { backgroundColor: `${kindColor}26` }]}>
              <Text style={[s.kindBadgeText, { color: kindColor }]}>{kindLabel(memory.kind)}</Text>
            </View>
            {memory.kind === 'project' && memory.category && (
              <View style={[s.outlineBadge, { borderColor: tokens.muted }]}>
                <Text style={[s.outlineBadgeText, { color: tokens.mutedForeground }]}>
                  {categoryLabel(memory.category)}
                </Text>
              </View>
            )}
            {memory.projectName && (
              <View style={[s.outlineBadge, { borderColor: tokens.muted }]}>
                <Text style={[s.outlineBadgeText, { color: tokens.mutedForeground }]}>
                  {memory.projectName}
                </Text>
              </View>
            )}
            {memory.tags.slice(0, 4).map((tag) => (
              <Text key={tag} style={[s.tag, { color: tokens.mutedForeground }]}>#{tag}</Text>
            ))}
          </View>

          <Text style={[s.meta, { color: tokens.mutedForeground }]}>
            {t('memoryCard.uses', { count: memory.hits })} · {formatDate(memory.createdAt)}
          </Text>

          <View style={[s.actions, { borderTopColor: tokens.border }]}>
            <Pressable onPress={close} style={s.secondary}>
              <Text style={[s.secondaryText, { color: tokens.mutedForeground }]}>
                {t('memorySheet.close')}
              </Text>
            </Pressable>
            <Pressable
              onPress={openInScreen}
              style={({ pressed }) => [
                s.primary,
                { backgroundColor: tokens.primary, opacity: pressed ? 0.85 : 1 },
              ]}
            >
              <ExternalLink size={13} color={tokens.primaryForeground} />
              <Text style={[s.primaryText, { color: tokens.primaryForeground }]}>
                {t('memorySheet.openInScreen')}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : loading ? (
        <View style={s.state}>
          <ActivityIndicator color={tokens.primary} />
        </View>
      ) : (
        <View style={s.state}>
          <Text style={[s.text, { color: tokens.mutedForeground, textAlign: 'center' }]}>
            {t('memorySheet.notFound')}
          </Text>
          <Text style={[s.meta, { color: tokens.mutedForeground }]}>{memoryId}</Text>
        </View>
      )}
    </BottomSheet>
  )
}

const s = StyleSheet.create({
  title: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 12 },
  titleText: { fontSize: 15, fontWeight: '600' },

  content: { gap: 10 },
  text: { fontSize: 14, lineHeight: 20 },

  badges: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  kindBadge: { borderRadius: 9999, paddingHorizontal: 8, paddingVertical: 2 },
  kindBadgeText: { fontSize: 10, fontWeight: '600' },
  outlineBadge: { borderRadius: 9999, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 2 },
  outlineBadgeText: { fontSize: 10 },
  tag: { fontSize: 11 },
  meta: { fontSize: 11 },

  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
    borderTopWidth: 1,
    paddingTop: 12,
    marginTop: 2,
  },
  secondary: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 8 },
  secondaryText: { fontSize: 13, fontWeight: '500' },
  primary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 8,
  },
  primaryText: { fontSize: 13, fontWeight: '600' },

  state: { alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 24 },
})
