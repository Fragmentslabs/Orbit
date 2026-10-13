import { create } from "zustand"

/**
 * Atividade de voz, global.
 *
 * Quem SABE que a voz está em curso são os botões (o de fala e o de ditado), mas
 * quem precisa DESENHAR isso é a persona — que vive em outro ramo da árvore, sem
 * qualquer ligação com eles. Um store compartilhado evita passar estado por props
 * ou subir um provider só para isso.
 *
 * `speaking` ganha da escuta: com o áudio saindo, é isso que a persona mostra.
 */
interface VoiceActivityState {
  /** Áudio do TTS tocando agora. */
  speaking: boolean
  /** Microfone aberto, capturando ditado. */
  listening: boolean
  /** Modo chamada ligado: o microfone de ditado sai de cena enquanto isso. */
  inCall: boolean
  setSpeaking: (speaking: boolean) => void
  setListening: (listening: boolean) => void
  setInCall: (inCall: boolean) => void
}

export const useVoiceActivity = create<VoiceActivityState>((set) => ({
  speaking: false,
  listening: false,
  inCall: false,
  setSpeaking: (speaking) => set({ speaking }),
  setListening: (listening) => set({ listening }),
  setInCall: (inCall) => set({ inCall }),
}))

/**
 * O estado que a persona deve mostrar, ou `null` quando não há voz em curso (e aí
 * valem os estados dela, como "thinking" ou "idle").
 */
export function voiceActivityState(activity: {
  speaking: boolean
  listening: boolean
}): "speaking" | "listening" | null {
  if (activity.speaking) return "speaking"
  if (activity.listening) return "listening"
  return null
}
