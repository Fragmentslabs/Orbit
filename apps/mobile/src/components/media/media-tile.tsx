import { memo, useCallback, useState } from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { Image } from 'expo-image'
import { AudioLines, Check, Clapperboard, CodeXml, FileText, ImageOff, Image as ImageIcon, Layers, PenTool, Pause, Play, Presentation, Video } from 'lucide-react-native'
import type { LucideIcon } from 'lucide-react-native'
import type { MediaEntry, MediaKind } from '@orbit/shared'
import { entryTitle, kindOf } from '~/lib/media'
import { useTokens } from '~/components/list/parts'
import { isMissingPiece } from '~/lib/media-availability'
import { useTranslation } from 'react-i18next'
import { InlineAudio } from './entry-viewer'

/** The icon of each type — the badge on every tile, as on the desktop. */
export const KIND_ICON: Record<MediaKind, LucideIcon> = {
  image: ImageIcon,
  artifact: CodeXml,
  document: FileText,
  video: Video,
  audio: AudioLines,
  motion: Clapperboard,
  design: PenTool,
  slides: Presentation,
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * One item of the grid — a square with the icon of its type in the corner. Only the image has a
 * thumbnail; the rest becomes a card with icon and title. An audio plays in the tile itself, and
 * a stack of versions shows how many images it holds.
 */
export const MediaTile = memo(function MediaTile({
  entry,
  size,
  versions,
  selecting,
  selected,
  onOpen,
  onToggle,
  onLongPress,
}: {
  entry: MediaEntry
  size: number
  versions: number
  selecting: boolean
  selected: boolean
  onOpen: () => void
  onToggle: () => void
  onLongPress: () => void
}) {
  const tokens = useTokens()
  const { t } = useTranslation()
  const kind = kindOf(entry)
  const missing = isMissingPiece(entry)
  const KindIcon = KIND_ICON[kind]
  const [playing, setPlaying] = useState(false)
  const stop = useCallback(() => setPlaying(false), [])
  const press = () => {
    if (selecting) onToggle()
    else if (kind === 'audio' && entry.url) setPlaying((p) => !p)
    else onOpen()
  }

  return (
    <Pressable
      onPress={press}
      onLongPress={onLongPress}
      accessibilityLabel={entryTitle(entry)}
      style={[s.tile, { width: size, height: size, borderColor: selected ? tokens.primary : tokens.border, backgroundColor: tokens.card }, selected && { borderWidth: 2 }]}
    >
      {kind === 'image' ? (
        entry.url ? (
          <Image source={entry.url} style={s.fill} contentFit="cover" transition={150} />
        ) : (
          <View style={s.center}>
            <ImageOff size={18} color={tokens.mutedForeground} />
          </View>
        )
      ) : kind === 'audio' ? (
        <View style={s.center}>
          <View style={[s.playBtn, { backgroundColor: tokens.primary }]}>{playing ? <Pause size={16} color={tokens.primaryForeground} /> : <Play size={16} color={tokens.primaryForeground} />}</View>
          <Text numberOfLines={1} style={[s.title, { color: tokens.foreground }]}>
            {entryTitle(entry)}
          </Text>
          {playing && entry.url ? <InlineAudio url={entry.url} onEnd={stop} /> : null}
        </View>
      ) : missing ? (
        // The registry no longer knows the piece: dim the tile and say so (opening it offers to remove it).
        <View style={[s.center, { opacity: 0.55 }]} testID="media-tile-missing">
          <ImageOff size={22} color={tokens.mutedForeground} />
          <Text numberOfLines={2} style={[s.title, { color: tokens.foreground }]}>
            {entryTitle(entry)}
          </Text>
          <Text numberOfLines={1} style={[s.title, { color: tokens.mutedForeground, fontSize: 10 }]}>
            {t('media.missingTile')}
          </Text>
        </View>
      ) : entry.thumbUrl && (kind === 'motion' || kind === 'design' || kind === 'slides') ? (
        // The piece's own face, as on the desktop; the icon and title are only for pieces without one.
        <>
          <Image source={entry.thumbUrl} style={s.fill} contentFit="cover" transition={150} />
          {kind === 'motion' ? (
            <View style={s.coverPlay} pointerEvents="none">
              <Play size={14} color="#fff" />
            </View>
          ) : null}
        </>
      ) : (
        <View style={s.center}>
          {kind === 'video' ? (
            <View style={s.videoPlay}>
              <Play size={16} color="#fff" />
            </View>
          ) : (
            <KindIcon size={24} color={tokens.mutedForeground} />
          )}
          <Text numberOfLines={2} style={[s.title, { color: tokens.foreground }]}>
            {entryTitle(entry)}
          </Text>
        </View>
      )}

      <View style={s.kindBadge}>
        <KindIcon size={12} color="#fff" />
      </View>
      {versions > 1 ? (
        <View style={s.versionBadge}>
          <Layers size={11} color="#fff" />
          <Text style={s.badgeText}>{versions}</Text>
        </View>
      ) : null}
      {(kind === 'video' || kind === 'motion') && entry.durationMs ? (
        <View style={s.durationBadge}>
          <Text style={s.badgeText}>{formatDuration(entry.durationMs)}</Text>
        </View>
      ) : null}
      {selecting ? (
        <View style={[s.check, selected ? { backgroundColor: tokens.primary, borderColor: tokens.primary } : { backgroundColor: 'rgba(0,0,0,0.35)', borderColor: '#fff' }]}>
          {selected ? <Check size={13} color={tokens.primaryForeground} /> : null}
        </View>
      ) : null}
    </Pressable>
  )
})

const s = StyleSheet.create({
  tile: { borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 8 },
  title: { fontSize: 11, fontWeight: '500', textAlign: 'center' },
  playBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  videoPlay: { width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
  coverPlay: { position: 'absolute', alignSelf: 'center', top: '50%', marginTop: -16, width: 32, height: 32, borderRadius: 16, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  kindBadge: { position: 'absolute', left: 6, top: 6, width: 22, height: 22, borderRadius: 7, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' },
  versionBadge: { position: 'absolute', right: 6, bottom: 6, height: 20, paddingHorizontal: 6, borderRadius: 7, backgroundColor: 'rgba(0,0,0,0.6)', flexDirection: 'row', alignItems: 'center', gap: 3 },
  durationBadge: { position: 'absolute', left: 6, bottom: 6, height: 20, paddingHorizontal: 6, borderRadius: 7, backgroundColor: 'rgba(0,0,0,0.6)', flexDirection: 'row', alignItems: 'center' },
  badgeText: { color: '#fff', fontSize: 11, fontVariant: ['tabular-nums'] },
  check: { position: 'absolute', right: 6, top: 6, width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
})
