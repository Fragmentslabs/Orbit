/**
 * Áudio produzido pelo agente (tool audio_generate): player inline na bolha.
 *
 * O `src` chega pronto do desktop — URL http absoluta com token no caminho
 * (fase 1, companion-assets). Aqui não se monta URL nenhuma: usa-se o que veio,
 * e quando não veio nada a part degrada para um card em vez de sumir (era o que
 * acontecia antes: `case 'audio'` não existia e caía no `default`).
 *
 * Player: `expo-audio`, o mesmo módulo do ditado. `useAudioPlayer` já libera o
 * player nativo ao desmontar; o pause explícito no cleanup existe porque
 * desmontar não é o mesmo que parar — sem ele o áudio continuava tocando depois
 * de sair da tela.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { useAudioPlayer, useAudioPlayerStatus, type AudioPlayer } from 'expo-audio'
import { Pause, Play } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { AudioPart } from '@orbit/shared'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { UnavailablePart } from './UnavailablePart'

/**
 * Um player por vez na conversa. Sem isto, dois áudios tocariam juntos — e o
 * usuário não teria como saber qual pausar, porque cada bolha só conhece o
 * próprio player.
 */
let activePlayer: AudioPlayer | null = null

function claimPlayback(player: AudioPlayer) {
  if (activePlayer && activePlayer !== player) {
    try {
      activePlayer.pause()
    } catch {
      // Player já liberado (bolha desmontada no meio): nada a pausar.
    }
  }
  activePlayer = player
}

function releasePlayback(player: AudioPlayer) {
  if (activePlayer === player) activePlayer = null
}

/** `mm:ss` — o mesmo formato do player do desktop. */
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
 * Barra de progresso arrastável sem dependência nova.
 *
 * O responder do próprio RN resolve o gesto: `locationX` já vem relativo à
 * barra, então o arrasto vira uma fração de 0..1 sem medir a página. Durante o
 * arrasto o valor exibido vem do dedo (não do player) — senão a barra voltaria
 * para a posição antiga a cada atualização de status.
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
      // Altura maior que a barra: o alvo do dedo é o que importa, não a linha.
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
  // 250ms: barra fluida sem um render por quadro.
  const player = useAudioPlayer({ uri: src }, { updateInterval: 250 })
  const status = useAudioPlayerStatus(player)
  const [scrub, setScrub] = useState<number | null>(null)
  const released = useRef(false)

  // Sair da tela para o áudio: o player nativo é liberado pelo hook, mas antes
  // disso ele segue tocando — pausar é o que o usuário espera.
  useEffect(() => {
    released.current = false
    return () => {
      released.current = true
      releasePlayback(player)
      try {
        player.pause()
      } catch {
        // Já liberado — nada a fazer.
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
      releasePlayback(player)
      return
    }
    claimPlayback(player)
    // Terminou: tocar de novo começa do início, como qualquer player.
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
