import { useCallback, useRef, useState } from 'react'
import { Modal, View, Text, Pressable, StyleSheet, useWindowDimensions } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import { Image } from 'expo-image'
import { X } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

const MIN_SCALE = 1
const MAX_SCALE = 4
const DOUBLE_TAP_SCALE = 2.5
const CLAMP_MARGIN = 60

interface Transform {
  x: number
  y: number
  k: number
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/**
 * Lightbox fullscreen para imagens do chat — espelho do ImageLightbox do
 * desktop (abrir num viewer em tela cheia), com o extra nativo de zoom:
 * pinch/arrastar e double-tap. O toque simples fecha (ou reenquadra quando
 * ampliado); o X fecha direto.
 */
export function ImageLightbox({ src, alt, open, onOpenChange }: {
  src: string
  alt?: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const insets = useSafeAreaInsets()
  const { width, height } = useWindowDimensions()

  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, k: MIN_SCALE })
  const base = useRef<Transform>({ x: 0, y: 0, k: MIN_SCALE })

  // Fecha e reenquadra — na próxima abertura o viewer volta em 1x.
  const close = useCallback(() => {
    setTransform({ x: 0, y: 0, k: MIN_SCALE })
    onOpenChange(false)
  }, [onOpenChange])

  const clampToBounds = useCallback(() => {
    setTransform((current) => {
      const maxX = Math.max(0, (current.k - 1) * (width / 2) + CLAMP_MARGIN)
      const maxY = Math.max(0, (current.k - 1) * (height / 2) + CLAMP_MARGIN)
      return {
        k: current.k,
        x: clamp(current.x, -maxX, maxX),
        y: clamp(current.y, -maxY, maxY),
      }
    })
  }, [width, height])

  const pinch = Gesture.Pinch()
    .runOnJS(true)
    .onStart(() => {
      base.current = transform
    })
    .onUpdate((e) => {
      const b = base.current
      const k = clamp(b.k * e.scale, MIN_SCALE, MAX_SCALE)
      setTransform({
        k,
        x: e.focalX - ((e.focalX - b.x) / b.k) * k,
        y: e.focalY - ((e.focalY - b.y) / b.k) * k,
      })
    })
    .onEnd(() => {
      setTransform((current) => (current.k <= MIN_SCALE ? { x: 0, y: 0, k: MIN_SCALE } : current))
      clampToBounds()
    })

  const pan = Gesture.Pan()
    .runOnJS(true)
    .maxPointers(1)
    .onStart(() => {
      base.current = transform
    })
    .onUpdate((e) => {
      const b = base.current
      // Sem zoom não há para onde arrastar — deixa o enquadramento fixo.
      if (b.k <= MIN_SCALE) return
      setTransform({ ...b, x: b.x + e.translationX, y: b.y + e.translationY })
    })
    .onEnd(() => clampToBounds())

  const doubleTap = Gesture.Tap()
    .runOnJS(true)
    .numberOfTaps(2)
    .maxDistance(24)
    .onEnd((e, success) => {
      if (!success) return
      setTransform((current) => {
        if (current.k > MIN_SCALE) return { x: 0, y: 0, k: MIN_SCALE }
        const k = DOUBLE_TAP_SCALE
        return { k, x: e.x - e.x * k, y: e.y - e.y * k }
      })
      clampToBounds()
    })

  const singleTap = Gesture.Tap()
    .runOnJS(true)
    .numberOfTaps(1)
    .maxDistance(24)
    .onEnd((_e, success) => {
      if (!success) return
      // Ampliado → primeiro toque reenquadra; em 1x → fecha.
      if (transform.k > MIN_SCALE) {
        setTransform({ x: 0, y: 0, k: MIN_SCALE })
      } else {
        close()
      }
    })

  // Single tap espera o double tap; pinch/pan rodam em paralelo.
  const taps = Gesture.Exclusive(doubleTap, singleTap)
  const composed = Gesture.Simultaneous(pinch, pan, taps)

  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={close}
    >
      <View style={s.backdrop}>
        <GestureDetector gesture={composed}>
          <View style={s.stage}>
            <Image
              source={src}
              accessibilityLabel={alt ?? t('attachment.image')}
              contentFit="contain"
              style={[
                StyleSheet.absoluteFill,
                { transform: [{ translateX: transform.x }, { translateY: transform.y }, { scale: transform.k }] },
              ]}
            />
          </View>
        </GestureDetector>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('attachment.close')}
          hitSlop={12}
          onPress={close}
          style={[s.closeBtn, { top: insets.top + 8 }]}
        >
          <X size={22} color="#fff" />
        </Pressable>

        {alt ? (
          <View pointerEvents="none" style={[s.caption, { bottom: insets.bottom + 16 }]}>
            <Text style={s.captionText} numberOfLines={2}>{alt}</Text>
          </View>
        ) : null}
      </View>
    </Modal>
  )
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#000' },
  stage: { flex: 1 },
  closeBtn: {
    position: 'absolute',
    right: 16,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  caption: {
    position: 'absolute',
    left: 24,
    right: 24,
    alignItems: 'center',
  },
  captionText: { color: 'rgba(255,255,255,0.82)', fontSize: 13, textAlign: 'center' },
})
