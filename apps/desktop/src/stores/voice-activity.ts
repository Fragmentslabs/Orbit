import { create } from "zustand"

/**
 * Voice activity, global.
 *
 * Who KNOWS that voice is in progress are the buttons (the speech one and the dictation one), but
 * who needs to DRAW that is the persona — which lives in another branch of the tree, with
 * no link to them. A shared store avoids passing state through props
 * or raising a provider just for that.
 *
 * `speaking` wins over listening: with the audio going out, that is what the persona shows.
 */
interface VoiceActivityState {
  /** TTS audio playing right now. */
  speaking: boolean
  /** Microphone open, capturing dictation. */
  listening: boolean
  /** Call mode on: the dictation microphone steps aside meanwhile. */
  inCall: boolean
  /** Session that owns the call in progress (the sidebar shows the phone on it). */
  callSessionId: string | null
  setSpeaking: (speaking: boolean) => void
  setListening: (listening: boolean) => void
  setInCall: (inCall: boolean) => void
  setCallSessionId: (sessionId: string | null) => void
}

export const useVoiceActivity = create<VoiceActivityState>((set) => ({
  speaking: false,
  listening: false,
  inCall: false,
  callSessionId: null,
  setSpeaking: (speaking) => set({ speaking }),
  setListening: (listening) => set({ listening }),
  setInCall: (inCall) => set({ inCall }),
  setCallSessionId: (callSessionId) => set({ callSessionId }),
}))

/**
 * The state the persona should show, or `null` when there is no voice in progress (and then
 * its own states apply, such as "thinking" or "idle").
 */
export function voiceActivityState(activity: {
  speaking: boolean
  listening: boolean
}): "speaking" | "listening" | null {
  if (activity.speaking) return "speaking"
  if (activity.listening) return "listening"
  return null
}
