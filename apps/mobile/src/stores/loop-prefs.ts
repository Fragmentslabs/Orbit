import { create } from 'zustand'

/**
 * Loop of the chat (the agent repeats the turn while the task is open).
 *
 * It was local state of the input; now the header also reads it to show the active
 * modes and the sheet turns it on — so it lives in a store. No persistence and no
 * per-chat key: it is the same behavior as before, where the input kept the flag
 * while the screen was mounted.
 */
interface LoopPrefsState {
  enabled: boolean
  setEnabled: (value: boolean) => void
}

export const useLoopPrefs = create<LoopPrefsState>((set) => ({
  enabled: false,
  setEnabled: (value) => set({ enabled: value }),
}))
