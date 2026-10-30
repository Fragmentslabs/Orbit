import { create } from "zustand"
import { personaVisibilityFrom, type PersonaVisibility } from "@shared/appearance"

const MODES_IN_ROW_KEY = "orbit_modes_in_row"
const MODE_LABEL_STYLE_KEY = "orbit_mode_label_style"
const PERSONA_VISIBLE_KEY = "orbit_persona_visible"
const TAB_CLOSE_POSITION_KEY = "orbit_tab_close_position"
const DEFAULT_TAB_CLOSE_POSITION: TabClosePosition = "left"

export type ModeLabelStyle = "label" | "icon"

/** Modes that can show up as toggles in the input's bottom bar.
 *  "thinking" is not in the list: for models with reasoning it is always
 *  on and the level (or turning it off, when supported) is controlled by the
 *  reasoning selector — it is not a mode. */
export const MODE_IDS = [
  "search",
  "browser",
  "plan",
  "simple",
  "brain",
  "subagents",
  "orchestra",
  "loop",
  "vision",
  "computer",
] as const
export type ModeId = (typeof MODE_IDS)[number]
/** "brain" stays out of the bar by default: the Memory mode also comes
 *  disabled by default in the preferences (model-mode-prefs) — it only goes into the
 *  bar if the user enables it here or in the "+" menu. "computer" too: besides
 *  being opt-in in Preferences → Computer, controlling the computer is not an
 *  everyday mode, and whoever wants the shortcut in the bar turns it on in Appearance. */
export const DEFAULT_MODES_IN_ROW: ModeId[] = [
  "search",
  "browser",
  "plan",
  "simple",
  "subagents",
  "orchestra",
  "loop",
  "vision",
]

export type TabClosePosition = "left" | "right"

interface AppearanceState {
  /** Modes visible as toggles in the bottom bar (the "+" menu shows all of them) */
  modesInRow: ModeId[]
  setModesInRow: (modes: ModeId[]) => void
  /** Icon + text or icon only in the bottom bar */
  modeLabelStyle: ModeLabelStyle
  setModeLabelStyle: (style: ModeLabelStyle) => void
  /** Where the persona shows up — see PersonaVisibility in @shared. */
  personaVisibility: PersonaVisibility
  setPersonaVisibility: (visibility: PersonaVisibility) => void
  tabClosePosition: TabClosePosition
  setTabClosePosition: (position: TabClosePosition) => void
}

function loadModesInRow(): ModeId[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(MODES_IN_ROW_KEY) ?? "null")
    if (Array.isArray(raw)) {
      const valid = raw.filter((m): m is ModeId => MODE_IDS.includes(m as ModeId))
      if (valid.length > 0) return valid
    }
  } catch {
    /* corrupted localStorage → default */
  }
  return DEFAULT_MODES_IN_ROW
}

export const useAppearanceStore = create<AppearanceState>((set) => ({
  modesInRow: loadModesInRow(),
  setModesInRow: (modes) => {
    localStorage.setItem(MODES_IN_ROW_KEY, JSON.stringify(modes))
    set({ modesInRow: modes })
  },
  modeLabelStyle: (localStorage.getItem(MODE_LABEL_STYLE_KEY) as ModeLabelStyle) ?? "icon",
  setModeLabelStyle: (style) => {
    localStorage.setItem(MODE_LABEL_STYLE_KEY, style)
    set({ modeLabelStyle: style })
  },
  // The key is the same as when this was a boolean: personaVisibilityFrom
  // understands the "false" of whoever had already turned it off and keeps it off.
  personaVisibility: personaVisibilityFrom(localStorage.getItem(PERSONA_VISIBLE_KEY)),
  setPersonaVisibility: (visibility) => {
    localStorage.setItem(PERSONA_VISIBLE_KEY, visibility)
    set({ personaVisibility: visibility })
  },
  tabClosePosition: (localStorage.getItem(TAB_CLOSE_POSITION_KEY) as TabClosePosition) ?? DEFAULT_TAB_CLOSE_POSITION,
  setTabClosePosition: (position) => {
    localStorage.setItem(TAB_CLOSE_POSITION_KEY, position)
    set({ tabClosePosition: position })
  },
}))
