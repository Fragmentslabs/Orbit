import { create } from 'zustand'
import { Storage } from '~/lib/storage'

/**
 * Configurable defaults of the active modes, separated per chat/code mode —
 * mirror of the desktop model-mode-prefs. The effective value of each toggle is
 * `override ?? default`: the default comes from here and the override (per chat) comes from
 * mode-overrides / simple-prefs / brain-prefs.
 */

const CHAT_ACTIVE_MODES_KEY = 'orbit_chat_active_modes'
const CODE_ACTIVE_MODES_KEY = 'orbit_code_active_modes'
// Legacy keys of the global Vision mode (settings-store) — used only in the migration
// to the per-mode defaults; the mode became per-chat (mode-overrides)
const LEGACY_VISION_ENABLED_KEY = 'orbit_vision_enabled'
const LEGACY_VISION_MODEL_KEY = 'orbit_vision_model'

export interface ActiveModeDefaults {
  simple: boolean
  brain: boolean
  thinking: boolean
  search: boolean
  browser: boolean
  plan: boolean
  subagents: boolean
  orchestra: boolean
  vision: boolean
}

const DEFAULT_CHAT_MODES: ActiveModeDefaults = {
  simple: false,
  brain: true,
  thinking: false,
  search: false,
  browser: false,
  plan: false,
  subagents: false,
  orchestra: false,
  vision: false,
}

const DEFAULT_CODE_MODES: ActiveModeDefaults = {
  simple: false,
  brain: true,
  thinking: false,
  search: false,
  browser: false,
  plan: false,
  subagents: false,
  orchestra: false,
  vision: false,
}

/** Vision mode migration: the old global flag becomes the default of both modes.
 *  Without the flag, a configured vision model also counted as active. */
async function legacyVisionDefault(): Promise<boolean> {
  try {
    const raw = await Storage.getItem(LEGACY_VISION_ENABLED_KEY)
    if (raw !== null) return JSON.parse(raw) === true
  } catch {
    // ignore
  }
  return (await Storage.getItem(LEGACY_VISION_MODEL_KEY)) !== null
}

interface ModelModePrefsState {
  chatActiveModes: ActiveModeDefaults
  codeActiveModes: ActiveModeDefaults
  hydrated: boolean
  hydrate: () => Promise<void>
  setChatActiveMode: (key: keyof ActiveModeDefaults, value: boolean) => void
  setCodeActiveMode: (key: keyof ActiveModeDefaults, value: boolean) => void
}

export const useModelModePrefs = create<ModelModePrefsState>((set, get) => ({
  chatActiveModes: DEFAULT_CHAT_MODES,
  codeActiveModes: DEFAULT_CODE_MODES,
  hydrated: false,

  hydrate: async () => {
    try {
      const [legacyVision, rawChat, rawCode] = await Promise.all([
        legacyVisionDefault(),
        Storage.getItem(CHAT_ACTIVE_MODES_KEY),
        Storage.getItem(CODE_ACTIVE_MODES_KEY),
      ])
      let chatStored: Partial<ActiveModeDefaults> | null = null
      let codeStored: Partial<ActiveModeDefaults> | null = null
      try {
        chatStored = rawChat ? (JSON.parse(rawChat) as Partial<ActiveModeDefaults>) : null
        codeStored = rawCode ? (JSON.parse(rawCode) as Partial<ActiveModeDefaults>) : null
      } catch {
        // corrupted prefs → goes back to the default
      }
      const apply = (
        stored: Partial<ActiveModeDefaults> | null,
        fallback: ActiveModeDefaults,
      ): ActiveModeDefaults =>
        stored && typeof stored === 'object' && 'vision' in stored
          ? (stored as ActiveModeDefaults)
          : { ...fallback, ...stored, vision: legacyVision }
      set({
        chatActiveModes: apply(chatStored, DEFAULT_CHAT_MODES),
        codeActiveModes: apply(codeStored, DEFAULT_CODE_MODES),
        hydrated: true,
      })
    } catch {
      set({ hydrated: true })
    }
  },

  setChatActiveMode: (key, value) => {
    const next = { ...get().chatActiveModes, [key]: value }
    void Storage.setItem(CHAT_ACTIVE_MODES_KEY, JSON.stringify(next))
    set({ chatActiveModes: next })
  },

  setCodeActiveMode: (key, value) => {
    const next = { ...get().codeActiveModes, [key]: value }
    void Storage.setItem(CODE_ACTIVE_MODES_KEY, JSON.stringify(next))
    set({ codeActiveModes: next })
  },
}))
