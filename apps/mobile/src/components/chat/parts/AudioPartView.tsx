/**
 * Audio produced by the agent (tool audio_generate): inline player in the bubble.
 *
 * The `src` arrives ready from the desktop — absolute http URL with the token in the path
 * (phase 1, companion-assets). Here no URL is assembled: what came is used,
 * and when nothing came the part degrades to a card instead of vanishing (that was what
 * happened before: `case 'audio'` did not exist and it fell into `default`).
 *
 * Player: `expo-audio`, the same module as the dictation. `useAudioPlayer` already releases the
 * native player on unmount; the explicit pause in the cleanup exists because
 * unmounting is not the same as stopping — without it the audio kept playing after
 * leaving the screen.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio'
import { Pause, Play } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { AudioPart } from '@orbit/shared'
import { claimAudioFocus, releaseAudioFocus } from '~/lib/audio-focus'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { UnavailablePart } from './UnavailablePart'

/** `mm:ss` — the same format as the desktop player. */
export function formatClock(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  const minutes = Math.floor(total / 60)
  return `${minutes}:${String(total % 60).padStart(2, '0')}`
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/**
 * Draggable progress bar without a new dependency.
 *
 * The RN responder itself handles the gesture: `locationX` already comes relative to the
 * bar, so the drag becomes a fraction of 0..1 without measuring the page. During the
 * drag the displayed value comes from the finger (not from the player) — otherwise the bar would
 * go back to the old position on every status update.
 */
function SeekBar({
  progress,
  disabled,
  onSeek,
  label,
}: {
  progress: number
  disabled?: boolean
  onSeek: (ratio: number) => void
  label: string
}) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const [width, setWidth] = useState(0)
  const [dragging, setDragging] = useState<number | null>(null)
  const shown = dragging ?? clamp01(progress)

  const ratioOf = useCallback(
    (x: number) => (width > 0 ? clamp01(x / width) : 0),
    [width],
  )

  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      // Height greater than the bar: the finger target is what matters, not the line.
      style={styles.seekHitArea}
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(shown * 100) }}
      onStartShouldSetResponder={() => !disabled}
      onMoveShouldSetResponder={() => !disabled}
      onResponderGrant={(event) => setDragging(ratioOf(event.nativeEvent.locationX))}
      onResponderMove={(event) => setDragging(ratioOf(event.nativeEvent.locationX))}
      onResponderRelease={(event) => {
        const ratio = ratioOf(event.nativeEvent.locationX)
        setDragging(null)
        onSeek(ratio)
      }}
      onResponderTerminate={() => setDragging(null)}
    >
      <View style={[styles.track, { backgroundColor: tokens.muted }]}>
        <View
          style={[
            styles.fill,
            { backgroundColor: tokens.primary, width: `${shown * 100}%` },
          ]}
        />
      </View>
      <View
        pointerEvents="none"
        style={[
          styles.knob,
          { backgroundColor: tokens.primary, left: `${shown * 100}%` },
        ]}
      />
    </View>
  )
}

function AudioPlayerCard({ part, src }: { part: AudioPart; src: string }) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  // 250ms: fluid bar without a render per frame.
  const player = useAudioPlayer({ uri: src }, { updateInterval: 250 })
  const status = useAudioPlayerStatus(player)
  const [scrub, setScrub] = useState<number | null>(null)
  const released = useRef(false)

  // Leaving the screen with the audio playing: the native player is released by the hook, but before
  // that it keeps playing — pausing is what the user expects.
  useEffect(() => {
    released.current = false
    return () => {
      released.current = true
      releaseAudioFocus(player)
      try {
        player.pause()
      } catch {
        // Already released — nothing to do.
      }
    }
  }, [player])

  const duration = useMemo(() => {
    if (status.duration > 0) return status.duration
    return part.durationMs ? part.durationMs / 1000 : 0
  }, [status.duration, part.durationMs])

  const current = scrub ?? (Number.isFinite(status.currentTime) ? status.currentTime : 0)
  const progress = duration > 0 ? clamp01(current / duration) : 0
  const failed = Boolean(status.error)

  const toggle = useCallback(() => {
    if (released.current) return
    if (status.playing) {
      player.pause()
      releaseAudioFocus(player)
      return
    }
    claimAudioFocus(player)
    // Finished: playing again starts from the beginning, like any player.
    if (status.didJustFinish) void player.seekTo(0)
    player.play()
  }, [player, status.playing, status.didJustFinish])

  const seekTo = useCallback(
    (ratio: number) => {
      if (released.current || duration <= 0) return
      setScrub(null)
      void player.seekTo(ratio * duration)
    },
    [player, duration],
  )

  if (failed) {
    return (
      <UnavailablePart
        testID="audio-part-error"
        title={part.title}
        label={t('parts.audio.error')}
      />
    )
  }

  return (
    <View
      testID="audio-part"
      className="mt-2 w-full gap-1 rounded-lg px-3 py-2"
      style={{ borderWidth: 1, borderColor: tokens.border }}
    >
      {part.title ? (
        <Text numberOfLines={1} className="text-xs font-medium" style={{ color: tokens.foreground }}>
          {part.title}
        </Text>
      ) : null}

      <View className="flex-row items-center gap-2">
        <Pressable
          onPress={toggle}
          accessibilityRole="button"
          accessibilityLabel={status.playing ? t('parts.audio.pause') : t('parts.audio.play')}
          hitSlop={8}
          className="items-center justify-center rounded-full"
          style={{ width: 34, height: 34, backgroundColor: tokens.muted }}
        >
          {!status.isLoaded && !status.playing ? (
            <ActivityIndicator size="small" style={{ transform: [{ scale: 0.7 }] }} color={tokens.primary} />
          ) : status.playing ? (
            <Pause size={16} color={tokens.primary} />
          ) : (
            <Play size={16} color={tokens.primary} />
          )}
        </Pressable>

        <View className="flex-1 gap-1">
          <SeekBar
            progress={progress}
            disabled={duration <= 0}
            onSeek={seekTo}
            label={t('parts.audio.seek')}
          />
          <View className="flex-row items-center justify-between">
            <Text className="text-[10px]" style={{ color: tokens.mutedForeground }}>
              {formatClock(current)}
            </Text>
            <Text className="text-[10px]" style={{ color: tokens.mutedForeground }}>
              {formatClock(duration)}
            </Text>
          </View>
        </View>
      </View>
    </View>
  )
}

export function AudioPartView({ part }: { part: AudioPart }) {
  const { t } = useTranslation()
  const src = part.src?.trim()
  if (!src) {
    return (
      <UnavailablePart
        testID="audio-part-unavailable"
        title={part.title}
        label={t('parts.audio.unavailable')}
      />
    )
  }
  return <AudioPlayerCard part={part} src={src} />
}

const styles = StyleSheet.create({
  seekHitArea: { height: 22, justifyContent: 'center' },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 2 },
  knob: {
    position: 'absolute',
    width: 10,
    height: 10,
    borderRadius: 5,
    marginLeft: -5,
  },
})
