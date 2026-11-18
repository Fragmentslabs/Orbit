import { useEffect, useMemo } from 'react'
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { Image } from 'expo-image'
import { ImageOff, Maximize2, Music, Pause, Play, Trash2 } from 'lucide-react-native'
import { VIEWERS } from '~/components/chat/pieces/viewers'
import { useTranslation } from 'react-i18next'
import type { MediaEntry } from '@orbit/shared'
import { VideoView, useVideoPlayer } from 'expo-video'
import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from 'expo-audio'
import { WebView } from 'react-native-webview'
import { buildMarkdownHtml } from '~/lib/document-markdown'
import { parseDocMessage } from '~/lib/document-web-script'
import { openExternal } from '~/lib/external-link'
import { useRemoteMarkdown } from '~/hooks/useRemoteMarkdown'
import { canOpen, entryTitle, kindOf } from '~/lib/media'
import { useTokens } from '~/components/list/parts'
import { isPieceKind, usePieceAvailability } from '~/lib/media-availability'
import { VideoGate } from './video-gate'

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const total = Math.floor(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** Page (artifact, document, piece): the WebView loads the URL already with the token. */
function PageViewer({ url }: { url: string }) {
  const tokens = useTokens()
  return (
    <WebView
      source={{ uri: url }}
      style={s.pageViewer}
      // The artifact comes from the desktop, on a local http: only http/https navigate here, no
      // external scheme (tel:, intent:) becoming a system action.
      originWhitelist={['http://*', 'https://*']}
      startInLoadingState
      renderLoading={() => (
        <View style={[s.pageViewer, s.center, { backgroundColor: tokens.background }]}>
          <ActivityIndicator color={tokens.primary} />
        </View>
      )}
      setSupportMultipleWindows={false}
    />
  )
}

/**
 * A live document is Markdown: drawn in the app's theme, as the desktop does, instead of the
 * white-sheet HTML preview. The preview stays when the desktop sends no source or it fails to load.
 */
function DocumentEntry({ entry }: { entry: MediaEntry }) {
  const tokens = useTokens()
  const markdown = useRemoteMarkdown(entry.sourceUrl, entry.createdAt)
  const html = useMemo(
    () =>
      markdown.status === 'ready'
        ? buildMarkdownHtml(markdown.text, {
            background: tokens.background,
            foreground: tokens.foreground,
            muted: tokens.mutedForeground,
            border: tokens.border,
            accent: tokens.primary,
            highlight: tokens.border,
          })
        : null,
    [markdown, tokens],
  )
  if (markdown.status === 'loading') {
    return (
      <View style={[s.pageViewer, s.center, { backgroundColor: tokens.background }]}>
        <ActivityIndicator color={tokens.primary} />
      </View>
    )
  }
  if (!html) return <PageViewer url={entry.url as string} />
  return (
    <WebView
      source={{ html }}
      style={[s.pageViewer, { backgroundColor: tokens.background }]}
      originWhitelist={['about:*', 'data:*']}
      setSupportMultipleWindows={false}
      onMessage={(e) => {
        const msg = parseDocMessage(e.nativeEvent.data)
        if (msg?.type === 'link') void openExternal(msg.url)
      }}
    />
  )
}

/** Video: the native expo-video player, with the system controls. */
function VideoPlayerView({ url }: { url: string }) {
  const player = useVideoPlayer(url)
  return <VideoView player={player} style={s.fill} contentFit="contain" nativeControls />
}

function VideoViewer({ url }: { url: string }) {
  // The player only mounts once the desktop says the file is playable on iOS (AV1 → H.264 copy).
  return (
    <VideoGate url={url}>
      <VideoPlayerView url={url} />
    </VideoGate>
  )
}

/** The piece (or its file) is gone: say so, and offer to drop the entry. */
function GoneState({ onRemove }: { onRemove?: () => void }) {
  const { t } = useTranslation()
  return (
    <View style={s.center} testID="piece-gone">
      <ImageOff size={28} color="#fff" />
      <Text style={s.audioTitle}>{t('media.pieceGone')}</Text>
      <Text style={s.audioTime}>{t('media.pieceGoneHint')}</Text>
      {onRemove ? (
        <Pressable onPress={onRemove} accessibilityRole="button" style={s.removeBtn} testID="piece-gone-remove">
          <Trash2 size={15} color="#fff" />
          <Text style={s.removeText}>{t('media.removeEntry')}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

/** A piece's player; swapped for the "no longer exists" state if the desktop answers 404/410. */
function PieceEntry({ entry, onRemove }: { entry: MediaEntry; onRemove?: () => void }) {
  const kind = kindOf(entry) as 'motion' | 'design' | 'slides'
  const url = entry.url as string
  // The player mounts at once (its own loading state shows immediately); the check runs beside it.
  const availability = usePieceAvailability(url)
  if (availability === 'gone') return <GoneState onRemove={onRemove} />
  const Viewer = VIEWERS[kind]
  const seconds = entry.durationMs ? Math.max(1, Math.round(entry.durationMs / 1000)) : undefined
  return (
    <Viewer
      piece={{ kind, id: entry.motionId ?? entry.designId ?? entry.slidesId ?? entry.id, url, title: entryTitle(entry), ...(kind === 'motion' && seconds ? { count: seconds } : {}) }}
    />
  )
}

/** Audio: there is no image to show, so the card becomes a minimal player. */
function AudioViewer({ url, title }: { url: string; title: string }) {
  const player = useAudioPlayer(url)
  const status = useAudioPlayerStatus(player)
  useEffect(() => {
    // On iOS the silent switch would mute the player — the gallery is for listening.
    void setAudioModeAsync({ playsInSilentMode: true }).catch(() => {})
  }, [])
  return (
    <View style={s.audioWrap}>
      <Music size={44} color="#fff" />
      <Text style={s.audioTitle} numberOfLines={2}>
        {title}
      </Text>
      <Pressable onPress={() => (status.playing ? player.pause() : player.play())} style={s.audioPlay} accessibilityRole="button">
        {status.playing ? <Pause size={22} color="#000" /> : <Play size={22} color="#000" />}
      </Pressable>
      <Text style={s.audioTime}>
        {formatClock(status.currentTime)} / {formatClock(status.duration)}
      </Text>
    </View>
  )
}

/** What opens in place of the preview, chosen by the type of the entry. */
export function EntryViewer({ entry, onExpand, onRemove }: { entry: MediaEntry; onExpand: () => void; onRemove?: () => void }) {
  const { t } = useTranslation()
  const kind = kindOf(entry)
  if (!canOpen(entry)) {
    // A piece missing from the desktop registry: say it no longer exists and offer to drop the entry.
    if (isPieceKind(kind)) return <GoneState onRemove={onRemove} />
    // Anything else: the item is in the index but the file is not.
    return (
      <View style={s.center}>
        <ImageOff size={28} color="#fff" />
        <Text style={s.audioTime}>{t('media.fileUnavailable')}</Text>
      </View>
    )
  }
  const url = entry.url as string
  if (kind === 'image') {
    return (
      <Pressable style={s.imgWrap} onPress={onExpand}>
        <Image source={url} style={s.img} contentFit="contain" />
        <View style={s.expandBadge}>
          <Maximize2 size={14} color="#fff" />
        </View>
      </Pressable>
    )
  }
  if (kind === 'video') return <VideoViewer url={url} />
  if (kind === 'audio') return <AudioViewer url={url} title={entryTitle(entry)} />
  // The pieces have their own players (clock, ruler, screens, slides): the same ones the chat
  // opens, so a motion from the gallery plays instead of sitting there as a still page.
  if (isPieceKind(kind)) return <PieceEntry entry={entry} onRemove={onRemove} />
  if (kind === 'document' && entry.sourceUrl) return <DocumentEntry entry={entry} />
  // The rest is page: artifact and document (.html preview).
  return <PageViewer url={url} />
}

/** Plays an audio in the tile itself: mounted when the tile starts it, unmounted when it stops. */
export function InlineAudio({ url, onEnd }: { url: string; onEnd: () => void }) {
  const player = useAudioPlayer(url)
  const status = useAudioPlayerStatus(player)
  useEffect(() => {
    void setAudioModeAsync({ playsInSilentMode: true }).catch(() => {})
    player.play()
  }, [player])
  useEffect(() => {
    if (status.didJustFinish) onEnd()
  }, [status.didJustFinish, onEnd])
  return null
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  pageViewer: { flex: 1, backgroundColor: 'transparent' },
  imgWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  img: { width: '100%', height: '100%' },
  audioWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 },
  audioTitle: { color: '#fff', fontSize: 15, fontWeight: '600', textAlign: 'center', paddingHorizontal: 24 },
  audioPlay: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  removeBtn: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 6, paddingHorizontal: 16, minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)' },
  removeText: { color: '#fff', fontSize: 13.5, fontWeight: '500' },
  audioTime: { color: 'rgba(255,255,255,0.65)', fontSize: 12 },
  expandBadge: { position: 'absolute', bottom: 16, right: 16, width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
})
