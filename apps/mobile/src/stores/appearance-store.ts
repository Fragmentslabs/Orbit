import { create } from 'zustand'
import { Storage } from '~/lib/storage'
import { useThemeStore, type ThemePreference } from './theme-store'

const DISPLAY_MODE_KEY = 'orbit_display_mode'
const DEFAULT_DISPLAY_MODE: DisplayMode = 'both'
const PERSONA_VISIBLE_KEY = 'orbit_persona_visible'

export type DisplayMode = 'toggles' | 'actions' | 'both'

interface AppearanceState {
  displayMode: DisplayMode
  setDisplayMode: (mode: DisplayMode) => Promise<void>
  personaVisible: boolean
  setPersonaVisible: (visible: boolean) => Promise<void>
  /** Define tema e persiste (delega ao theme-store). */
  setTheme: (pref: ThemePreference) => void
}

export const useAppearanceStore = create<AppearanceState>((set) => ({
  displayMode: DEFAULT_DISPLAY_MODE,
  personaVisible: true,

  setDisplayMode: async (mode) => {
    set({ displayMode: mode })
    await Storage.setItem(DISPLAY_MODE_KEY, mode)
  },

  setPersonaVisible: async (visible) => {
    set({ personaVisible: visible })
    await Storage.setItem(PERSONA_VISIBLE_KEY, String(visible))
  },

  setTheme: (pref) => {
    useThemeStore.getState().setPreference(pref)
  },
}))

/** Carrega preferência persistida (chamar no root). */
export async function hydrateDisplayMode(): Promise<DisplayMode> {
  try {
    const raw = await Storage.getItem(DISPLAY_MODE_KEY)
    if (raw === 'toggles' || raw === 'actions' || raw === 'both') return raw
  } catch { /* ignore */ }
  return DEFAULT_DISPLAY_MODE
}

export async function hydratePersonaVisible(): Promise<boolean> {
  try {
    const raw = await Storage.getItem(PERSONA_VISIBLE_KEY)
    if (raw === 'false') return false
  } catch { /* ignore */ }
  return true
}
