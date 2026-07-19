import { useEffect, useState } from 'react'
import { Animated, Easing, View, useColorScheme } from 'react-native'
import type { PersonaState } from './persona-types'

interface Props {
  state: PersonaState
  size: number
}

export function PersonaFallback({ state, size }: Props) {
  const isLight = useColorScheme() === 'light'
  const [pulse] = useState(() => new Animated.Value(1))
  const [glow] = useState(() => new Animated.Value(0.4))

  useEffect(() => {
    const loop = (scaleTo: number, glowTo: number, duration: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.parallel([
            Animated.timing(pulse, { toValue: scaleTo, duration, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
            Animated.timing(glow, { toValue: glowTo, duration, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
          ]),
          Animated.parallel([
            Animated.timing(pulse, { toValue: 1, duration, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
            Animated.timing(glow, { toValue: 0.4, duration, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
          ]),
        ]),
      )

    let animation: Animated.CompositeAnimation | null = null
    switch (state) {
      case 'idle':
        animation = loop(1.04, 0.65, 2200)
        break
      case 'listening':
        animation = loop(1.1, 0.9, 700)
        break
      case 'thinking':
        animation = loop(1.06, 0.8, 1100)
        break
      case 'speaking':
        animation = loop(1.08, 1, 450)
        break
      case 'asleep':
        animation = null
        Animated.parallel([
          Animated.timing(pulse, { toValue: 0.96, duration: 400, useNativeDriver: true }),
          Animated.timing(glow, { toValue: 0.15, duration: 400, useNativeDriver: true }),
        ]).start()
        break
    }
    animation?.start()
    return () => animation?.stop()
  }, [state, pulse, glow])

  const ring = size * 0.62
  const border = Math.max(2, size * 0.02)

  // Desktop light: invert(1) brightness(0.85) → mapeamos branco para cinza-azulado escuro
  // Desktop dark: keep white with glow
  const c = isLight ? '60,65,85' : '255,255,255'
  const shadowC = isLight ? '#3c4155' : '#ffffff'
  const glowBg = isLight ? `rgba(60,65,85,0.06)` : 'rgba(255,255,255,0.06)'
  const ringMain = isLight ? `rgba(60,65,85,0.92)` : 'rgba(255,255,255,0.92)'
  const ringInner = isLight ? `rgba(60,65,85,0.14)` : 'rgba(255,255,255,0.14)'

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View
        style={{
          position: 'absolute',
          width: ring * 1.35,
          height: ring * 1.35,
          borderRadius: (ring * 1.35) / 2,
          backgroundColor: glowBg,
          opacity: glow,
          transform: [{ scale: pulse }],
        }}
      />
      <Animated.View
        style={{
          width: ring,
          height: ring,
          borderRadius: ring / 2,
          borderWidth: border,
          borderColor: ringMain,
          opacity: glow.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] }),
          transform: [{ scale: pulse }],
          shadowColor: shadowC,
          shadowOffset: { width: 0, height: 0 },
          shadowOpacity: isLight ? 0.3 : 0.7,
          shadowRadius: size * 0.12,
          elevation: 8,
        }}
      />
      <Animated.View
        style={{
          position: 'absolute',
          width: ring * 0.86,
          height: ring * 0.86,
          borderRadius: (ring * 0.86) / 2,
          borderWidth: border * 2,
          borderColor: ringInner,
          transform: [{ scale: pulse }],
        }}
      />
    </View>
  )
}
