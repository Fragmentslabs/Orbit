import { memo, useCallback, useEffect, useRef } from 'react'
import type { ComponentType, FC } from 'react'
import { View, useColorScheme } from 'react-native'
import Constants, { ExecutionEnvironment } from 'expo-constants'
import { PersonaFallback } from './PersonaFallback'
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
}

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
  const riveRef = useRef<RiveRefLike | null>(null)
  const isLight = useColorScheme() === 'light'
  const Rive = riveModule!.default

  const applyColor = useCallback(
    (ref: RiveRefLike | null) => {
      if (!ref) return
      const [r, g, b] = isLight ? [60, 65, 85] : [255, 255, 255]
      try {
        ref.setColor(COLOR_PROPERTY, { r, g, b, a: 255 })
      } catch {
        // cor pode ainda não existir enquanto o asset carrega
      }
    },
    [isLight],
  )

  const setRiveRef = useCallback(
    (node: RiveRefLike | null) => {
      riveRef.current = node
      applyColor(node)
    },
    [applyColor],
  )

  useEffect(() => {
    applyColor(riveRef.current)
  }, [applyColor])

  useEffect(() => {
    const ref = riveRef.current
    if (!ref) return
    for (const input of BOOL_INPUTS) {
      try {
        ref.setInputState(PERSONA_STATE_MACHINE, input, state === input)
      } catch {
        // input pode ainda não existir enquanto o asset carrega
      }
    }
  }, [state])

  return (
    <Rive
      ref={setRiveRef}
      url={PERSONA_RIVE_URL}
      stateMachineName={PERSONA_STATE_MACHINE}
      autoplay
      fit={riveModule!.Fit.Contain}
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
