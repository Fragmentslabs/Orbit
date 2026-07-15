/**
 * Persona (web) — port exato do componente do desktop
 * (apps/desktop/src/components/ai/persona.tsx) usando o mesmo asset
 * Rive, state machine e binding de cor por tema.
 */
import {
  useRive,
  useStateMachineInput,
  useViewModel,
  useViewModelInstance,
  useViewModelInstanceColor,
} from '@rive-app/react-webgl2'
import { memo, useEffect, useState } from 'react'
import type { FC } from 'react'
import {
  PERSONA_RIVE_URL,
  PERSONA_STATE_MACHINE,
  type PersonaProps,
} from './persona-types'

const getCurrentTheme = (): 'light' | 'dark' => {
  if (typeof document !== 'undefined') {
    if (document.documentElement.classList.contains('dark')) return 'dark'
    if (document.documentElement.classList.contains('light')) return 'light'
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
      return 'dark'
    }
  }
  // Mobile é dark por padrão
  return 'dark'
}

function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark'>(getCurrentTheme)

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(getCurrentTheme()))
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })
    return () => observer.disconnect()
  }, [])

  return theme
}

export const Persona: FC<PersonaProps> = memo(({ state = 'idle', size = 128 }) => {
  const theme = useTheme()

  const { rive, RiveComponent } = useRive({
    src: PERSONA_RIVE_URL,
    stateMachines: PERSONA_STATE_MACHINE,
    autoplay: true,
  })

  const viewModel = useViewModel(rive, { useDefault: true })
  const viewModelInstance = useViewModelInstance(viewModel, { rive, useDefault: true })
  const viewModelInstanceColor = useViewModelInstanceColor('color', viewModelInstance)

  useEffect(() => {
    if (!viewModelInstanceColor) return
    const [r, g, b] = theme === 'dark' ? [255, 255, 255] : [60, 65, 85]
    viewModelInstanceColor.setRgb(r, g, b)
    // alpha é 0-255 (não 0-1) — ver fix equivalente no desktop
    viewModelInstanceColor.setAlpha?.(255)
  }, [viewModelInstanceColor, theme])

  const listeningInput = useStateMachineInput(rive, PERSONA_STATE_MACHINE, 'listening')
  const thinkingInput = useStateMachineInput(rive, PERSONA_STATE_MACHINE, 'thinking')
  const speakingInput = useStateMachineInput(rive, PERSONA_STATE_MACHINE, 'speaking')
  const asleepInput = useStateMachineInput(rive, PERSONA_STATE_MACHINE, 'asleep')

  useEffect(() => {
    // Atribuir input.value é a API oficial do Rive (mesmo padrão do desktop)
    /* eslint-disable react-hooks/immutability */
    if (listeningInput) listeningInput.value = state === 'listening'
    if (thinkingInput) thinkingInput.value = state === 'thinking'
    if (speakingInput) speakingInput.value = state === 'speaking'
    if (asleepInput) asleepInput.value = state === 'asleep'
    /* eslint-enable react-hooks/immutability */
  }, [state, listeningInput, thinkingInput, speakingInput, asleepInput])

  return (
    <div style={{ width: size, height: size, flexShrink: 0 }}>
      <RiveComponent style={{ width: '100%', height: '100%' }} />
    </div>
  )
})

Persona.displayName = 'Persona'

export type { PersonaState } from './persona-types'
