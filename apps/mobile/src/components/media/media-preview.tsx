import { View, Text, Pressable, ScrollView, Modal, StyleSheet } from 'react-native'
import { Image } from 'expo-image'
import { ChevronLeft, ChevronRight, MessageSquare, Trash2, X } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { MediaEntry } from '@orbit/shared'
import { entryTitle } from '~/lib/media'
import { tint, useTokens } from '~/components/list/parts'
import { EntryViewer } from './entry-viewer'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * The viewer of an item: the file at the top, then (for an image with history) the versions — arrows,
 * the v2/3 counter and a strip of thumbnails —, the file's data and the actions. Same content as the
 * desktop's dialog.
 */
export function MediaPreview({
  entry,
  chain,
  locale,
  onStep,
  onPick,
  onClose,
  onExpand,
  onOpenInChat,
  onDelete,
}: {
  entry: MediaEntry | null
  /** Versions of the group, oldest to current; null when the item has only itself. */
  chain: MediaEntry[] | null
  locale: string
  onStep: (delta: number) => void
  onPick: (version: MediaEntry) => void
  onClose: () => void
  onExpand: () => void
  onOpenInChat: (entry: MediaEntry) => void
  onDelete: (entry: MediaEntry) => void
}) {
  const { t } = useTranslation()
  const tokens = useTokens()
  const insets = useSafeAreaInsets()
  const index = entry && chain ? chain.findIndex((v) => v.id === entry.id) : -1
  const when = entry ? new Date(entry.createdAt).toLocaleString(locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''

  return (
    <Modal visible={!!entry} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={s.wrap}>
        <View style={{ height: insets.top }} />
        <View style={s.top}>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel={t('media.close')} style={s.close}>
            <X size={22} color="#fff" />
          </Pressable>
          {chain && index >= 0 ? (
            <View style={s.counter}>
              <Text style={s.counterText}>
                v{index + 1}/{chain.length}
              </Text>
            </View>
          ) : null}
        </View>
        {entry ? (
          <>
            <View style={s.viewer}>
              <EntryViewer entry={entry} onExpand={onExpand} />
              {/* Arrows only when there is somewhere to go. */}
              {chain && index > 0 ? (
                <Pressable onPress={() => onStep(-1)} accessibilityLabel={t('media.previousVersion')} style={[s.arrow, { left: 10 }]}>
                  <ChevronLeft size={22} color="#fff" />
                </Pressable>
              ) : null}
              {chain && index >= 0 && index < chain.length - 1 ? (
                <Pressable onPress={() => onStep(1)} accessibilityLabel={t('media.nextVersion')} style={[s.arrow, { right: 10 }]}>
                  <ChevronRight size={22} color="#fff" />
                </Pressable>
              ) : null}
            </View>

            {chain && chain.length > 1 ? (
              <View style={s.strip}>
                <Text style={s.stripLabel}>{t('media.versions', { count: chain.length })}</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, alignItems: 'center' }}>
                  {chain.map((version, i) => (
                    <Pressable key={version.id} onPress={() => onPick(version)} accessibilityLabel={`v${i + 1}`} style={[s.thumb, version.id === entry.id && { borderColor: tokens.primary }]}>
                      {version.url ? <Image source={version.url} style={{ flex: 1 }} contentFit="cover" /> : null}
                      <Text style={s.thumbLabel}>v{i + 1}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </View>
            ) : null}

            <View style={[s.meta, { paddingBottom: insets.bottom + 14 }]}>
              <Text style={s.name} numberOfLines={1}>
                {entryTitle(entry)}
              </Text>
              <Text style={s.sub}>
                {t(`media.source.${entry.source}`)} · {when}
                {entry.width && entry.height ? ` · ${entry.width}×${entry.height}` : ''} · {formatBytes(entry.size)}
              </Text>
              {entry.credit ? (
                <Text style={s.sub} numberOfLines={1}>
                  {entry.credit.license}
                  {entry.credit.creator ? ` · ${entry.credit.creator}` : ''}
                </Text>
              ) : null}
              <View style={s.actions}>
                {entry.sessionId ? (
                  <Pressable onPress={() => onOpenInChat(entry)} accessibilityRole="button" style={s.action}>
                    <MessageSquare size={15} color="#fff" />
                    <Text style={s.actionText}>{t('media.openInChat')}</Text>
                  </Pressable>
                ) : null}
                <Pressable onPress={() => onDelete(entry)} accessibilityRole="button" style={[s.action, { borderColor: tint(tokens.destructive, '80') }]}>
                  <Trash2 size={15} color={tokens.destructive} />
                  <Text style={[s.actionText, { color: tokens.destructive }]}>{t('media.delete')}</Text>
                </Pressable>
              </View>
            </View>
          </>
        ) : null}
      </View>
    </Modal>
  )
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.94)' },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8, height: 52 },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  counter: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 99, backgroundColor: 'rgba(255,255,255,0.14)', marginRight: 8 },
  counterText: { color: '#fff', fontSize: 12 },
  viewer: { flex: 1, overflow: 'hidden' },
  arrow: { position: 'absolute', top: '50%', marginTop: -22, width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
  strip: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 10 },
  stripLabel: { color: 'rgba(255,255,255,0.65)', fontSize: 12 },
  thumb: { width: 46, height: 46, borderRadius: 9, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.25)', overflow: 'hidden' },
  thumbLabel: { position: 'absolute', left: 0, right: 0, bottom: 0, textAlign: 'center', fontSize: 10, color: '#fff', backgroundColor: 'rgba(0,0,0,0.6)' },
  meta: { paddingHorizontal: 18, paddingTop: 6 },
  name: { color: '#fff', fontSize: 15, fontWeight: '600' },
  sub: { color: 'rgba(255,255,255,0.6)', fontSize: 12, marginTop: 3 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 14 },
  action: { flex: 1, minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)' },
  actionText: { color: '#fff', fontSize: 13.5, fontWeight: '500' },
})
