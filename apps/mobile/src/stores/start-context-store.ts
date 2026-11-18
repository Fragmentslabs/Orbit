/**
 * What the start screen asks of the desktop: the name it learned and which resources are on. The
 * phone never decides these — it follows. Until the desktop answers (or if it is an older one
 * without the route) everything counts as on and there is no name, so the screen still works.
 */
import { create } from 'zustand'
import type { StartContextResponse } from '@orbit/shared'
import { useConnectionStore } from './connection-store'

const DEFAULTS: StartContextResponse = { userName: null, features: { tts: true, stt: true, browser: true } }

interface StartContextState extends StartContextResponse {
  refresh: () => Promise<void>
}

export const useStartContextStore = create<StartContextState>((set) => ({
  ...DEFAULTS,
  refresh: async () => {
    const http = useConnectionStore.getState().http
    if (!http) return
    const res = await http.getStartContext().catch(() => null)
    if (!res?.ok || !res.data) return
    set({
      userName: typeof res.data.userName === 'string' ? res.data.userName : null,
      features: { ...DEFAULTS.features, ...res.data.features },
    })
  },
}))
