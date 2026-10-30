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
  /** Returns [refCallback, ref] — the ref only becomes non-null after the native load. */
  useRive: () => [(node: RiveRefLike | null) => void, RiveRefLike | null]
  useRiveColor: (
    ref: RiveRefLike | null,
    path: string,
  ) => [RiveRGBA | undefined, (value: RiveRGBA | string) => void]
}

let riveModule: RiveModule | null = null
if (!isExpoGo) {
  try {
    // Conditional loading of an optional module: a static import does not
    // work here (the module may not exist at runtime — Expo Go, web,
    // build without the native part) and that is exactly why the require is
    // inside the try/if.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    riveModule = require('rive-react-native') as RiveModule
  } catch {
    riveModule = null
  }
}

const BOOL_INPUTS: PersonaState[] = ['listening', 'thinking', 'speaking', 'asleep']
const COLOR_PROPERTY = 'color'

/** Same colors as the desktop/web (Persona.web.tsx). */
const LIGHT_RGB = [60, 65, 85] as const
const DARK_RGB = [255, 255, 255] as const

const RivePersona: FC<Required<PersonaProps>> = ({ state, size }) => {
  const rive = riveModule!
  const Rive = rive.default

  // `riveRef` is only filled when the native side emits `RiveReactNativeLoaded`, that
  // is, when the ViewModel is already bound and the properties exist. Before
  // that any setColor/setInputState is silently lost — that was what
  // left the persona white (invisible) in the light theme.
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
    let cancelled = false
    const apply = () => {
      if (cancelled) return
      for (const input of BOOL_INPUTS) {
        try {
          riveRef.setInputState(PERSONA_STATE_MACHINE, input, state === input)
        } catch {
          // the input may not exist in the asset's state machine
        }
      }
    }
    apply()
    // On Android the state machine inputs may become ready a few frames
    // after the native load event — reapply so the state is not lost
    // (that was what kept the persona stuck in 'asleep' on the initial screen).
    const retry = setTimeout(apply, 200)
    return () => {
      cancelled = true
      clearTimeout(retry)
    }
  }, [riveRef, state])

  return (
    <Rive
      ref={setRiveRef}
      source={PERSONA_RIVE_SOURCE}
      stateMachineName={PERSONA_STATE_MACHINE}
      autoplay
      fit={rive.Fit.Contain}
      // Native equivalent of `useDefault: true` used on desktop/web: binds the
      // default instance of the ViewModel, without which the `color` property does not exist.
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
