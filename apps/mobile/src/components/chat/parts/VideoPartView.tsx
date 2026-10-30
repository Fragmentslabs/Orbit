/**
 * Video produced by the agent (video_render, motion_render, show_video): inline
 * 16:9 player with the native controls.
 *
 * The `src` arrives ready from the desktop (absolute http URL with the token in the path) and the
 * server answers with `Range`, so seeking works — without that a
 * player is not a player. No URL assembled here.
 *
 * The poster is the `thumb` of the part, displayed over the player while the video is not
 * ready. Video from motion/design is usually short and light, but the first
 * frame still takes a while: without the poster the bubble would open a black rectangle.
 */
import { useEffect } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { Image } from 'expo-image'
import { VideoView, useVideoPlayer } from 'expo-video'
import { useEvent } from 'expo'
import { useTranslation } from 'react-i18next'
import type { VideoPart } from '@orbit/shared'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { UnavailablePart } from './UnavailablePart'

function VideoPlayerCard({ part, src }: { part: VideoPart; src: string }) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  // The shared type of the video does not declare `thumb`, but the desktop attaches the
  // thumbnail when it exists (same contract as the artifact). Read defensively:
  // absent is the normal case, not an error.
  const poster = (part as VideoPart & { thumb?: string }).thumb
  const player = useVideoPlayer({ uri: src })
  const { status, error } = useEvent(player, 'statusChange', { status: player.status })
  // Failure derived from the player event, without a mirror in state: the status is already the
  // source of truth, and the error card has to appear in the same render in which the
  // player gives up (not a frame later).
  const failed = status === 'error' || Boolean(error)

  // Leaving the screen cannot leave the video playing (nor its audio).
  useEffect(() => {
    return () => {
      try {
        player.pause()
      } catch {
        // Player already released by the hook.
      }
    }
  }, [player])

  if (failed) {
    return (
      <UnavailablePart
        testID="video-part-error"
        title={part.title}
        label={
          error?.message
            ? t('parts.video.errorWithReason', { reason: error.message })
            : t('parts.video.error')
        }
      />
    )
  }

  return (
    <View
      testID="video-part"
      className="mt-2 w-full overflow-hidden rounded-lg"
      style={{ borderWidth: 1, borderColor: tokens.border, backgroundColor: '#000' }}
    >
      <View style={styles.stage}>
        <VideoView
          player={player}
          style={StyleSheet.absoluteFill}
          nativeControls
          contentFit="contain"
          // Fullscreen belongs to the native controls — the player button is enough.
          fullscreenOptions={{ enable: true }}
          allowsPictureInPicture={false}
          accessibilityLabel={part.title}
        />

        {status !== 'readyToPlay' ? (
          <View style={styles.poster} pointerEvents="none">
            {poster ? (
              <Image source={poster} style={StyleSheet.absoluteFill} contentFit="cover" />
            ) : null}
            <View style={styles.scrim}>
              <ActivityIndicator color={tokens.primary} />
            </View>
          </View>
        ) : null}
      </View>
    </View>
  )
}

export function VideoPartView({ part }: { part: VideoPart }) {
  const { t } = useTranslation()
  const src = part.src?.trim()
  if (!src) {
    return (
      <UnavailablePart
        testID="video-part-unavailable"
        title={part.title}
        label={t('parts.video.unavailable')}
      />
    )
  }
  return <VideoPlayerCard part={part} src={src} />
}

const fill = { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 } as const

const styles = StyleSheet.create({
  // Fixed 16:9: the player cannot change height when the video loads (the
  // list would jump under the finger).
  stage: { width: '100%', aspectRatio: 16 / 9, backgroundColor: '#000' },
  poster: fill,
  scrim: {
    ...fill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
})
