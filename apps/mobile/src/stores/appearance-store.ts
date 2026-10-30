import { create } from 'zustand'
import {
  personaVisibilityFrom,
  DEFAULT_PERSONA_VISIBILITY,
  type PersonaVisibility,
} from '@orbit/shared'
import { Storage } from '~/lib/storage'
import { useThemeStore, type ThemePreference } from './theme-store'

const MODES_IN_ROW_KEY = 'orbit_modes_in_row'
const PERSONA_VISIBLE_KEY = 'orbit_persona_visible'

/** Modes that can show up as toggles in the bottom bar of the input.
 *  "thinking" is not in the list: for models with reasoning it is always
 *  active and the level (or turning it off, when supported) is controlled by
 *  the reasoning picker — it is not a mode. */
export const MODE_IDS = [
  'search',
  'browser',
  'plan',
  'simple',
  'brain',
  'subagents',
  'orchestra',
  'loop',
  'vision',
] as const
export type ModeId = (typeof MODE_IDS)[number]
/** "brain" stays out of the bar by default: the Memory mode also comes
 *  disabled by default in the preferences (model-mode-prefs) — it only enters the
 *  bar if the user enables it here or in the "+" menu. */
export const DEFAULT_MODES_IN_ROW: ModeId[] = [
  'search',
  'browser',
  'plan',
  'simple',
  'subagents',
  'orchestra',
  'loop',
  'vision',
]

interface AppearanceState {
  /** Modes visible as toggles in the bottom bar (the "+" menu shows all of them) */
  modesInRow: ModeId[]
  setModesInRow: (modes: ModeId[]) => Promise<void>
  /** Where the persona shows up — see PersonaVisibility in @orbit/shared. */
  personaVisibility: PersonaVisibility
  setPersonaVisibility: (visibility: PersonaVisibility) => Promise<void>
  /** Sets the theme and persists it (delegates to theme-store). */
  setTheme: (pref: ThemePreference) => void
}

export const useAppearanceStore = create<AppearanceState>((set) => ({
  modesInRow: DEFAULT_MODES_IN_ROW,
  personaVisibility: DEFAULT_PERSONA_VISIBILITY,

  setModesInRow: async (modes) => {
    set({ modesInRow: modes })
    await Storage.setItem(MODES_IN_ROW_KEY, JSON.stringify(modes))
  },

  setPersonaVisibility: async (visibility) => {
    set({ personaVisibility: visibility })
    await Storage.setItem(PERSONA_VISIBLE_KEY, visibility)
  },

  setTheme: (pref) => {
    useThemeStore.getState().setPreference(pref)
  },
}))

/** Loads the persisted preference (call in the root). */
export async function hydrateModesInRow(): Promise<ModeId[]> {
  try {
    const raw = await Storage.getItem(MODES_IN_ROW_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        const valid = parsed.filter((m): m is ModeId => MODE_IDS.includes(m as ModeId))
        if (valid.length > 0) return valid
      }
    }
  } catch { /* ignore */ }
  return DEFAULT_MODES_IN_ROW
}

/** The key is the same as when this was a boolean: personaVisibilityFrom
 *  understands the "false" of whoever had already turned it off and keeps it off. */
export async function hydratePersonaVisibility(): Promise<PersonaVisibility> {
  try {
    return personaVisibilityFrom(await Storage.getItem(PERSONA_VISIBLE_KEY))
  } catch {
    return DEFAULT_PERSONA_VISIBILITY
  }
}
