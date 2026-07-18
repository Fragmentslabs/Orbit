/**
 * Texto com brilho pulsante — equivalente RN do Shimmer do desktop
 * (usado em "Thinking…", "Pesquisando…", labels de tools em execução).
 */
import { useEffect, useState } from 'react'
import { Animated, Easing } from 'react-native'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

export function Shimmer({ children, className }: {
  children: React.ReactNode
  className?: string
}) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const [opacity] = useState(() => new Animated.Value(0.4))

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.4, duration: 700, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [opacity])

  return (
    <Animated.Text style={{ opacity, color: tokens.mutedForeground }}>
      {children}
    </Animated.Text>
  )
}
