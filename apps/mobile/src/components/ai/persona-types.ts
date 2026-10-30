/** Persona states — identical to the desktop (apps/desktop/src/components/ai/persona.tsx). */
export type PersonaState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'asleep'

/** Rive asset bundled in the app to avoid download failures on Android. */
export const PERSONA_RIVE_SOURCE = require('../../../assets/halo-2.0.riv') as number

/** URL kept as a reference for the web version. */
export const PERSONA_RIVE_URL =
  'https://ejiidnob33g9ap1r.public.blob.vercel-storage.com/halo-2.0.riv'

/** State machine of the asset. */
export const PERSONA_STATE_MACHINE = 'default'

export interface PersonaProps {
  state?: PersonaState
  /** Side of the square in px (the desktop uses size-32 = 128). */
  size?: number
}
