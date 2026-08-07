import { create } from "zustand"

const DISPLAY_MODE_KEY = "orbit_display_mode"
const DEFAULT_DISPLAY_MODE: DisplayMode = "both"
const PERSONA_VISIBLE_KEY = "orbit_persona_visible"
const TAB_CLOSE_POSITION_KEY = "orbit_tab_close_position"
const DEFAULT_TAB_CLOSE_POSITION: TabClosePosition = "left"

export type DisplayMode = "toggles" | "actions" | "both"
export type TabClosePosition = "left" | "right"

interface AppearanceState {
  displayMode: DisplayMode
  setDisplayMode: (mode: DisplayMode) => void
  personaVisible: boolean
  setPersonaVisible: (visible: boolean) => void
  tabClosePosition: TabClosePosition
  setTabClosePosition: (position: TabClosePosition) => void
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
  tabClosePosition: (localStorage.getItem(TAB_CLOSE_POSITION_KEY) as TabClosePosition) ?? DEFAULT_TAB_CLOSE_POSITION,
  setTabClosePosition: (position) => {
    localStorage.setItem(TAB_CLOSE_POSITION_KEY, position)
    set({ tabClosePosition: position })
  },
}))
