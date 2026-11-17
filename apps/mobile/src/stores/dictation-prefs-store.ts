import { create } from 'zustand'
import { Storage } from '~/lib/storage'

const STORAGE_KEY = 'orbit_dictation_prefs'

/**
 * Where the speech becomes text.
 * - `native`: the phone's own recognizer (iOS Speech / Android SpeechRecognizer), words appear as you speak.
 * - `desktop`: the audio goes to the desktop's voice model; partial text comes back every second or so.
 */
export type DictationMode = 'native' | 'desktop'

export const DEFAULT_DICTATION_MODE: DictationMode = 'native'

function isMode(value: unknown): value is DictationMode {
  return value === 'native' || value === 'desktop'
}

interface DictationPrefsStore {
  mode: DictationMode
  /**
   * The phone's own switch for the voice call button. It only narrows what the desktop allows:
   * the button shows when the desktop has the call on AND this is on.
   */
  callEnabled: boolean
  setMode: (mode: DictationMode) => Promise<void>
  setCallEnabled: (enabled: boolean) => Promise<void>
  loadPrefs: () => Promise<void>
}

export const useDictationPrefsStore = create<DictationPrefsStore>((set, get) => ({
  mode: DEFAULT_DICTATION_MODE,
  callEnabled: true,

  setMode: async (mode) => {
    set({ mode })
    await Storage.setItem(STORAGE_KEY, JSON.stringify({ mode, callEnabled: get().callEnabled }))
  },

  setCallEnabled: async (callEnabled) => {
    set({ callEnabled })
    await Storage.setItem(STORAGE_KEY, JSON.stringify({ mode: get().mode, callEnabled }))
  },

  loadPrefs: async () => {
    try {
      const raw = await Storage.getItem(STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as { mode?: unknown; callEnabled?: unknown }
      if (isMode(parsed.mode)) set({ mode: parsed.mode })
      if (typeof parsed.callEnabled === 'boolean') set({ callEnabled: parsed.callEnabled })
    } catch {
      // Corrupted or missing — keeps the default
    }
  },
}))
