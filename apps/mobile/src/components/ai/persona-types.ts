/** Estados do Persona — idênticos ao desktop (apps/desktop/src/components/ai/persona.tsx). */
export type PersonaState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'asleep'

/** Asset Rive compartilhado com o desktop. */
export const PERSONA_RIVE_URL =
  'https://ejiidnob33g9ap1r.public.blob.vercel-storage.com/halo-2.0.riv'

/** State machine do asset. */
export const PERSONA_STATE_MACHINE = 'default'

export interface PersonaProps {
  state?: PersonaState
  /** Lado do quadrado em px (o desktop usa size-32 = 128). */
  size?: number
}
