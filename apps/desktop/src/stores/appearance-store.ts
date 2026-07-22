import { create } from "zustand"

const DISPLAY_MODE_KEY = "orbit_display_mode"
const DEFAULT_DISPLAY_MODE: DisplayMode = "both"

export type DisplayMode = "toggles" | "actions" | "both"

interface AppearanceState {
  displayMode: DisplayMode
  setDisplayMode: (mode: DisplayMode) => void
}

export const useAppearanceStore = create<AppearanceState>((set) => ({
  displayMode: (localStorage.getItem(DISPLAY_MODE_KEY) as DisplayMode) ?? DEFAULT_DISPLAY_MODE,
  setDisplayMode: (mode) => {
    localStorage.setItem(DISPLAY_MODE_KEY, mode)
    set({ displayMode: mode })
  },
}))
