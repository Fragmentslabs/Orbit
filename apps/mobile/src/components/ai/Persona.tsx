import { memo, useEffect } from 'react'
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
  const isLight = useThemeStore((s) => s.resolved) === 'light'
  const [r, g, b] = isLight ? [60, 65, 85] : [255, 255, 255]

  // useRive() só popula riveRef depois que o Rive terminou de carregar e o
  // view model (propriedade "color") existe. Por isso a cor é aplicada aqui,
  // e não no momento em que o componente monta — se aplicada antes, o asset
  // ainda não tem o binding da cor e a queda seria no branco padrão.
  useEffect(() => {
    if (!riveRef) return
    try {
      riveRef.setColor(COLOR_PROPERTY, { r, g, b, a: 255 })
    } catch {
      // cor pode ainda não existir; o efeito re-executa quando o estado muda
    }
  }, [riveRef, r, g, b])

  useEffect(() => {
    if (!riveRef) return
    for (const input of BOOL_INPUTS) {
      try {
        riveRef.setInputState(PERSONA_STATE_MACHINE, input, state === input)
      } catch {
        // input pode ainda não existir enquanto o asset carrega
      }
    }
  }, [riveRef, state])

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
