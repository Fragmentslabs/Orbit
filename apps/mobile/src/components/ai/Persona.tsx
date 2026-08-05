import { memo, useCallback, useEffect, useRef } from 'react'
import type { ComponentType, FC } from 'react'
import { View } from 'react-native'
import Constants, { ExecutionEnvironment } from 'expo-constants'
import { PersonaFallback } from './PersonaFallback'
import { useThemeStore } from '~/stores/theme-store'
import {
  PERSONA_RIVE_URL,
  PERSONA_STATE_MACHINE,
  type PersonaProps,
  type PersonaState,
} from './persona-types'

const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient

interface RiveRGBA {
  r: number
  g: number
  b: number
  a: number
}

interface RiveRefLike {
  setInputState: (stateMachine: string, input: string, value: boolean) => void
  setColor: (path: string, color: RiveRGBA | string) => void
}

interface RiveModule {
  default: ComponentType<Record<string, unknown>>
  Fit: Record<string, string>
  /** Ref que só é populado após o Rive terminar de carregar (evento nativo "loaded"). */
  useRive: () => [(node: RiveRefLike | null) => void, RiveRefLike | null]
}

/**
 * Vincula a "ViewModel instance" padrão ao artboard. É o que faz o `setColor`
 * de fato surtir efeito no nativo (`getColorProperty` operam sobre a instance
 * vinculada). Equivale ao `useDefault: true` do desktop — sem isso o comando
 * `setColorPropertyValue` é um no-op silencioso e a persona fica presa no
 * estado inicial do .riv (branca sobre branco no tema claro).
 */
const DATA_BINDING = { type: 'index', value: 0 } as const

let riveModule: RiveModule | null = null
if (!isExpoGo) {
  try {
    riveModule = require('rive-react-native') as RiveModule
  } catch {
    riveModule = null
  }
}

const BOOL_INPUTS: PersonaState[] = ['listening', 'thinking', 'speaking', 'asleep']
const COLOR_PROPERTY = 'color'

const RivePersona: FC<Required<PersonaProps>> = ({ state, size }) => {
  const Rive = riveModule!.default
  const [setRiveRef, riveRef] = riveModule!.useRive()
  const loadedRef = useRef<RiveRefLike | null>(null)
  const isLight = useThemeStore((s) => s.resolved) === 'light'
  const [r, g, b] = isLight ? [60, 65, 85] : [255, 255, 255]

  const applyColor = useCallback(
    (ref: RiveRefLike) => {
      try {
        ref.setColor(COLOR_PROPERTY, { r, g, b, a: 255 })
      } catch {
        // a propriedade pode não existir enquanto o asset ainda carrega
      }
    },
    [r, g, b],
  )

  const applyInputs = useCallback(
    (ref: RiveRefLike) => {
      for (const input of BOOL_INPUTS) {
        try {
          ref.setInputState(PERSONA_STATE_MACHINE, input, state === input)
        } catch {
          // input pode não existir enquanto o asset carrega
        }
      }
    },
    [state],
  )

  // Aplica color/inputs IMEDIATAMENTE (via ref normal) E reaplica quando o
  // riveRef popular. O caminho via useRive() depende do evento nativo
  // "RiveReactNativeLoaded", que no New Architecture (Fabric) pode nunca
  // casar com o viewTag do lado nativo — sem o retry imediato a persona
  // ficaria presa no estado inicial do .riv (invisível).
  const setCombinedRef = useCallback(
    (node: RiveRefLike | null) => {
      loadedRef.current = node
      setRiveRef(node)
      if (node) {
        applyColor(node)
        applyInputs(node)
      }
    },
    [setRiveRef, applyColor, applyInputs],
  )

  // Reaplica quando riveRef popula (evento de load) ou tema/estado mudam.
  useEffect(() => {
    if (!loadedRef.current) return
    applyColor(loadedRef.current)
    applyInputs(loadedRef.current)
  }, [riveRef, applyColor, applyInputs])

  // Rede de segurança: reaplica em delays escalonados para cobrir o caso em que
  // o evento nativo "RiveReactNativeLoaded" não casa com o viewTag (Fabric) —
  // nesse cenário o riveRef nunca popula e a única janela de aplicar a cor é
  // depender do ViewModel já vinculado, que acontece um pouco depois do load.
  useEffect(() => {
    const apply = () => {
      if (!loadedRef.current) return
      applyColor(loadedRef.current)
      applyInputs(loadedRef.current)
    }
    apply()
    const timers = [400, 1000, 2400].map((t) => setTimeout(apply, t))
    return () => timers.forEach(clearTimeout)
  }, [riveRef, applyColor, applyInputs])

  return (
    <Rive
      ref={setCombinedRef}
      url={PERSONA_RIVE_URL}
      stateMachineName={PERSONA_STATE_MACHINE}
      dataBinding={DATA_BINDING}
      autoplay
      fit={riveModule!.Fit.Contain}
      onError={(event: unknown) => {
        if (__DEV__) {
          console.warn('[RivePersona] Rive error:', (event as { nativeEvent?: unknown })?.nativeEvent ?? event)
        }
      }}
      style={{ width: size, height: size }}
    />
  )
}

export const Persona: FC<PersonaProps> = memo(({ state = 'idle', size = 128 }) => {
  return (
    <View style={{ width: size, height: size, overflow: 'hidden' }}>
      {riveModule ? <RivePersona state={state} size={size} /> : <PersonaFallback state={state} size={size} />}
    </View>
  )
})

Persona.displayName = 'Persona'

export type { PersonaState } from './persona-types'
