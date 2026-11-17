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
  setMode: (mode: DictationMode) => Promise<void>
  loadPrefs: () => Promise<void>
}

export const useDictationPrefsStore = create<DictationPrefsStore>((set) => ({
  mode: DEFAULT_DICTATION_MODE,

  setMode: async (mode) => {
    set({ mode })
    await Storage.setItem(STORAGE_KEY, JSON.stringify({ mode }))
  },

  loadPrefs: async () => {
    try {
      const raw = await Storage.getItem(STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as { mode?: unknown }
      if (isMode(parsed.mode)) set({ mode: parsed.mode })
    } catch {
      // Corrupted or missing — keeps the default
    }
  },
}))
