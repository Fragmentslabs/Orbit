/**
 * Vídeo produzido pelo agente (video_render, motion_render, show_video): player
 * inline 16:9 com os controles nativos.
 *
 * O `src` chega pronto do desktop (URL http absoluta com token no caminho) e o
 * servidor responde com `Range`, então buscar posição funciona — sem isso um
 * player não é um player. Nada de URL montada aqui.
 *
 * O poster é o `thumb` da part, exibido por cima do player enquanto o vídeo não
 * está pronto. Vídeo de motion/design costuma ser curto e leve, mas o primeiro
 * quadro ainda demora: sem o poster a bolha abriria um retângulo preto.
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
  // O tipo compartilhado do vídeo não declara `thumb`, mas o desktop anexa a
  // miniatura quando ela existe (mesmo contrato do artefato). Lido de forma
  // defensiva: ausente é o caso normal, não um erro.
  const poster = (part as VideoPart & { thumb?: string }).thumb
  const player = useVideoPlayer({ uri: src })
  const { status, error } = useEvent(player, 'statusChange', { status: player.status })
  // Falha derivada do evento do player, sem espelho em estado: o status já é a
  // fonte da verdade, e o card de erro tem de aparecer no mesmo render em que o
  // player desiste (não um frame depois).
  const failed = status === 'error' || Boolean(error)

  // Sair da tela não pode deixar o vídeo tocando (nem o áudio dele).
  useEffect(() => {
    return () => {
      try {
        player.pause()
      } catch {
        // Player já liberado pelo hook.
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
          // Tela cheia é dos controles nativos — o botão do player basta.
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
  // 16:9 fixo: o player não pode mudar de altura quando o vídeo carrega (a
  // lista daria um salto embaixo do dedo).
  stage: { width: '100%', aspectRatio: 16 / 9, backgroundColor: '#000' },
  poster: fill,
  scrim: {
    ...fill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
})
