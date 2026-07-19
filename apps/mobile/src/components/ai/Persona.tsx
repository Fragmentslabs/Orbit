import { memo, useEffect, useRef } from 'react'
import type { ComponentType, FC } from 'react'
import { View, StyleSheet } from 'react-native'
import Constants, { ExecutionEnvironment } from 'expo-constants'
import { PersonaFallback } from './PersonaFallback'
import {
  PERSONA_RIVE_URL,
  PERSONA_STATE_MACHINE,
  type PersonaProps,
  type PersonaState,
} from './persona-types'
import { useThemeStore } from '~/stores/theme-store'

const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient

interface RiveRefLike {
  setInputState: (stateMachine: string, input: string, value: boolean) => void
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

const RivePersona: FC<Required<PersonaProps>> = ({ state, size }) => {
  const riveRef = useRef<RiveRefLike | null>(null)
  const Rive = riveModule!.default

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
      ref={riveRef}
      url={PERSONA_RIVE_URL}
      stateMachineName={PERSONA_STATE_MACHINE}
      autoplay
      fit={riveModule!.Fit.Contain}
      style={{ width: size, height: size }}
    />
  )
}

export const Persona: FC<PersonaProps> = memo(({ state = 'idle', size = 128 }) => {
  const isLight = useThemeStore((s) => s.resolved) === 'light'

  return (
    <View style={{ width: size, height: size, overflow: 'hidden' }}>
      {riveModule ? <RivePersona state={state} size={size} /> : <PersonaFallback state={state} size={size} />}
      {/* Light mode: overlay escuro para simular invert(1) brightness(0.85) do desktop */}
      {isLight && riveModule && (
        <View
          pointerEvents="none"
          style={{
            ...StyleSheet.absoluteFillObject,
            backgroundColor: 'rgba(25,28,40,0.72)',
          }}
        />
      )}
    </View>
  )
})

Persona.displayName = 'Persona'

export type { PersonaState } from './persona-types'
