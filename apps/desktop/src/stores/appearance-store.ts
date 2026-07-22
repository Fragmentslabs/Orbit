import { create } from "zustand"

const DISPLAY_MODE_KEY = "orbit_display_mode"
const DEFAULT_DISPLAY_MODE: DisplayMode = "both"
const PERSONA_VISIBLE_KEY = "orbit_persona_visible"

export type DisplayMode = "toggles" | "actions" | "both"

interface AppearanceState {
  displayMode: DisplayMode
  setDisplayMode: (mode: DisplayMode) => void
  personaVisible: boolean
  setPersonaVisible: (visible: boolean) => void
}

export const useAppearanceStore = create<AppearanceState>((set) => ({
  displayMode: (localStorage.getItem(DISPLAY_MODE_KEY) as DisplayMode) ?? DEFAULT_DISPLAY_MODE,
  setDisplayMode: (mode) => {
    localStorage.setItem(DISPLAY_MODE_KEY, mode)
    set({ displayMode: mode })
  },
  personaVisible: localStorage.getItem(PERSONA_VISIBLE_KEY) !== "false",
  setPersonaVisible: (visible) => {
    localStorage.setItem(PERSONA_VISIBLE_KEY, String(visible))
    set({ personaVisible: visible })
  },
}))
