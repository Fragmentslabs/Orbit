import type { ReactNode } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { AlertCircle } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'

import { useVideoPreparation } from '~/lib/media-availability'

/**
 * Holds the player back until the desktop says the video can be played on iOS.
 *
 * An AV1/VP9 download is converted to H.264 on the desktop the first time it is asked for; until
 * then this shows a "preparing" state with the progress, and if the conversion fails, a message
 * (instead of a black player that never starts).
 */
export function VideoGate({
  url,
  children,
  fallback,
}: {
  url: string
  children: ReactNode
  /** Wraps the preparing/failed content (the chat puts it on its own 16:9 stage). */
  fallback?: (content: ReactNode) => ReactNode
}) {
  const { t } = useTranslation()
  const prep = useVideoPreparation(url)
  const color = '#fff'

  if (prep.state === 'ready') return <>{children}</>

  const content = (
    <View style={s.center} testID={`video-gate-${prep.state}`}>
      {prep.state === 'failed' ? (
        <>
          <AlertCircle size={26} color={color} />
          <Text style={[s.text, { color }]}>{t('media.videoFailed')}</Text>
          {prep.message ? (
            <Text style={[s.sub]} numberOfLines={3}>
              {prep.message}
            </Text>
          ) : null}
        </>
      ) : (
        <>
          <ActivityIndicator color={color} />
          {prep.state === 'preparing' && prep.progress > 0 ? (
            <Text style={[s.text, { color }]}>{t('media.videoPreparingPercent', { percent: Math.round(prep.progress * 100) })}</Text>
          ) : prep.state === 'preparing' ? (
            <Text style={[s.text, { color }]}>{t('media.videoPreparing')}</Text>
          ) : null}
        </>
      )}
    </View>
  )
  return <>{fallback ? fallback(content) : content}</>
}

const s = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 20 },
  text: { fontSize: 13, textAlign: 'center' },
  sub: { color: 'rgba(255,255,255,0.55)', fontSize: 11, textAlign: 'center' },
})
