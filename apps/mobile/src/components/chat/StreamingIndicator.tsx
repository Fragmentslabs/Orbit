import { useEffect, useState } from 'react'
import { Animated, Easing, View, type ViewProps } from 'react-native'
import { useTranslation } from 'react-i18next'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

/**
 * In-progress answer indicator — "Thinking" text with shimmer,
 * in the same spirit as the desktop (there it is an animated gradient over the text;
 * here we approximate it with a wave of opacity per character, which RN
 * can animate without depending on masked-view/linear-gradient).
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
        // Each character glows a little after the previous one — a sweep effect
        // from left to right, restarting on every cycle.
        // (i+1)/(n+1) keeps center in (0,1) and the inputRange strictly
        // increasing — center=0 would generate [0,0,…], which interpolate rejects.
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
