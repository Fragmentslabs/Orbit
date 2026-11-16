import { useEffect } from 'react'
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { Image } from 'expo-image'
import { ImageOff, Maximize2, Music, Pause, Play } from 'lucide-react-native'
import { VIEWERS } from '~/components/chat/pieces/viewers'
import { useTranslation } from 'react-i18next'
import type { MediaEntry } from '@orbit/shared'
import { VideoView, useVideoPlayer } from 'expo-video'
import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from 'expo-audio'
import { WebView } from 'react-native-webview'
import { canOpen, entryTitle, kindOf } from '~/lib/media'
import { useTokens } from '~/components/list/parts'

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

/** Video: the native expo-video player, with the system controls. */
function VideoViewer({ url }: { url: string }) {
  const player = useVideoPlayer(url)
  return <VideoView player={player} style={s.fill} contentFit="contain" nativeControls />
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
export function EntryViewer({ entry, onExpand }: { entry: MediaEntry; onExpand: () => void }) {
  const { t } = useTranslation()
  const kind = kindOf(entry)
  if (!canOpen(entry)) {
    // Piece missing from the desktop registry: the item is in the index but the file is not.
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
  if (kind === 'motion' || kind === 'design' || kind === 'slides') {
    const Viewer = VIEWERS[kind]
    const seconds = entry.durationMs ? Math.max(1, Math.round(entry.durationMs / 1000)) : undefined
    return (
      <Viewer
        piece={{ kind, id: entry.motionId ?? entry.designId ?? entry.slidesId ?? entry.id, url, title: entryTitle(entry), ...(kind === 'motion' && seconds ? { count: seconds } : {}) }}
      />
    )
  }
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
  audioTime: { color: 'rgba(255,255,255,0.65)', fontSize: 12 },
  expandBadge: { position: 'absolute', bottom: 16, right: 16, width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
})
