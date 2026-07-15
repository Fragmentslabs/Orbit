/**
 * Persona (nativo) — mesmo asset Rive do desktop via rive-react-native.
 *
 * Em Expo Go o módulo nativo do Rive não existe, então caímos no
 * PersonaFallback (halo animado com Animated API). Em dev/release builds
 * (expo run:android / eas build) o Rive real é usado.
 */
import { memo, useEffect, useRef } from 'react'
import type { ComponentType, FC } from 'react'
import Constants, { ExecutionEnvironment } from 'expo-constants'
import { PersonaFallback } from './PersonaFallback'
import {
  PERSONA_RIVE_URL,
  PERSONA_STATE_MACHINE,
  type PersonaProps,
  type PersonaState,
} from './persona-types'

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
    // require dinâmico: import estático quebraria no Expo Go (módulo nativo ausente)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
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
  if (riveModule) {
    return <RivePersona state={state} size={size} />
  }
  return <PersonaFallback state={state} size={size} />
})

Persona.displayName = 'Persona'

export type { PersonaState } from './persona-types'
