import { useEffect, useState } from 'react'
import { Animated, Easing, View, type ViewProps } from 'react-native'
import { useTranslation } from 'react-i18next'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

/**
 * Indicador de resposta em andamento — texto "Pensando" com shimmer,
 * no mesmo espírito do desktop (lá é um gradiente animado sobre o texto;
 * aqui aproximamos com uma onda de opacidade por caractere, que o RN
 * consegue animar sem depender de masked-view/linear-gradient).
 */
export function StreamingIndicator({ style }: { style?: ViewProps['style'] }) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const [progress] = useState(() => new Animated.Value(0))

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: 1400,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }),
    )
    loop.start()
    return () => loop.stop()
  }, [progress])

  const chars = t('chatAssistant.thinking').split('')

  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center' }, style]}>
      {chars.map((char, i) => {
        // Cada caractere brilha um pouco depois do anterior — efeito de
        // varredura da esquerda pra direita, reiniciando a cada ciclo.
        // (i+1)/(n+1) mantém center em (0,1) e o inputRange estritamente
        // crescente — center=0 geraria [0,0,…], que o interpolate rejeita.
        const center = (i + 1) / (chars.length + 1)
        const opacity = progress.interpolate({
          inputRange: [
            Math.max(0, center - 0.25),
            center,
            Math.min(1, center + 0.25),
          ],
          outputRange: [0.35, 1, 0.35],
          extrapolate: 'clamp',
        })
        return (
          <Animated.Text
            key={i}
            style={{ fontSize: 14, fontWeight: '500', color: tokens.mutedForeground, opacity }}
          >
            {char}
          </Animated.Text>
        )
      })}
    </View>
  )
}
