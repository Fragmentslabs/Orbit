import { create } from 'zustand'
import { Storage } from '~/lib/storage'
import { useThemeStore, type ThemePreference } from './theme-store'

const DISPLAY_MODE_KEY = 'orbit_display_mode'
const DEFAULT_DISPLAY_MODE: DisplayMode = 'both'

export type DisplayMode = 'toggles' | 'actions' | 'both'

interface AppearanceState {
  displayMode: DisplayMode
  setDisplayMode: (mode: DisplayMode) => Promise<void>
  /** Define tema e persiste (delega ao theme-store). */
  setTheme: (pref: ThemePreference) => void
}

export const useAppearanceStore = create<AppearanceState>((set) => ({
  displayMode: DEFAULT_DISPLAY_MODE,

  setDisplayMode: async (mode) => {
    set({ displayMode: mode })
    await Storage.setItem(DISPLAY_MODE_KEY, mode)
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
