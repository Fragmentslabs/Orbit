/**
 * What the desktop says about the voice features: whether the call is on there, the pause that
 * ends a turn, and whether dictation and speech are on. The phone never decides these — it asks
 * (`GET /api/voice/status`) and follows, so turning the call off on the desktop removes the
 * button from the phone too.
 */
import { create } from 'zustand'
import type { VoiceStatusResponse } from '@orbit/shared'
import { useConnectionStore } from './connection-store'

/** Same default as the desktop's `VOICE_DEFAULTS.call.silenceMs`. */
export const DEFAULT_CALL_SILENCE_MS = 1300

interface VoiceDesktopState {
  /** Nothing answered yet: the call stays hidden until the desktop says it is on. */
  loaded: boolean
  callEnabled: boolean
  silenceMs: number
  refresh: () => Promise<void>
}

/** The call needs the desktop's call switch AND its dictation on (the same rule as its own button). */
export function callAllowedByDesktop(status: VoiceStatusResponse): boolean {
  // A desktop older than these fields has no way to say no: the call keeps working there.
  return (status.call?.enabled ?? true) && (status.stt?.enabled ?? true)
}

export const useVoiceDesktopStore = create<VoiceDesktopState>((set) => ({
  loaded: false,
  callEnabled: false,
  silenceMs: DEFAULT_CALL_SILENCE_MS,

  refresh: async () => {
    const http = useConnectionStore.getState().http
    if (!http) return
    const res = await http.getVoiceStatus().catch(() => null)
    if (!res?.ok || !res.data) return
    set({
      loaded: true,
      callEnabled: callAllowedByDesktop(res.data),
      silenceMs: res.data.call?.silenceMs ?? DEFAULT_CALL_SILENCE_MS,
    })
  },
}))
