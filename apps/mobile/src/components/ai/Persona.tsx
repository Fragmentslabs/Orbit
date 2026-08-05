import { memo, useEffect } from 'react'
import type { ComponentType, FC } from 'react'
import { View } from 'react-native'
import Constants, { ExecutionEnvironment } from 'expo-constants'
import { PersonaFallback } from './PersonaFallback'
import { useThemeStore } from '~/stores/theme-store'
import {
  PERSONA_RIVE_SOURCE,
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
}

interface RiveModule {
  default: ComponentType<Record<string, unknown>>
  Fit: Record<string, string>
  AutoBind: (value: boolean) => { type: string; value: boolean }
  /** Retorna [refCallback, ref] — o ref só fica não-nulo após o load nativo. */
  useRive: () => [(node: RiveRefLike | null) => void, RiveRefLike | null]
  useRiveColor: (
    ref: RiveRefLike | null,
    path: string,
  ) => [RiveRGBA | undefined, (value: RiveRGBA | string) => void]
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

/** Mesmas cores do desktop/web (Persona.web.tsx). */
const LIGHT_RGB = [60, 65, 85] as const
const DARK_RGB = [255, 255, 255] as const

const RivePersona: FC<Required<PersonaProps>> = ({ state, size }) => {
  const rive = riveModule!
  const Rive = rive.default

  // `riveRef` só é preenchido quando o nativo emite `RiveReactNativeLoaded`, ou
  // seja, quando a ViewModel já está vinculada e as propriedades existem. Antes
  // disso qualquer setColor/setInputState é silenciosamente perdido — era o que
  // deixava a persona branca (invisível) no tema claro.
  const [setRiveRef, riveRef] = rive.useRive()
  const [, setColor] = rive.useRiveColor(riveRef, COLOR_PROPERTY)
  const isLight = useThemeStore((s) => s.resolved) === 'light'

  useEffect(() => {
    if (!riveRef) return
    const [r, g, b] = isLight ? LIGHT_RGB : DARK_RGB
    setColor({ r, g, b, a: 255 })
  }, [riveRef, setColor, isLight])

  useEffect(() => {
    if (!riveRef) return
    for (const input of BOOL_INPUTS) {
      try {
        riveRef.setInputState(PERSONA_STATE_MACHINE, input, state === input)
      } catch {
        // input pode não existir na state machine do asset
      }
    }
  }, [riveRef, state])

  return (
    <Rive
      ref={setRiveRef}
      source={PERSONA_RIVE_SOURCE}
      stateMachineName={PERSONA_STATE_MACHINE}
      autoplay
      fit={rive.Fit.Contain}
      // Equivalente nativo do `useDefault: true` usado no desktop/web: vincula a
      // instância padrão da ViewModel, sem a qual a propriedade `color` não existe.
      dataBinding={rive.AutoBind(true)}
      onError={(error: unknown) => {
        if (__DEV__) {
          console.warn('[RivePersona] Rive error:', error)
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
