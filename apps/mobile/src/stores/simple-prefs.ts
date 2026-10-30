import { create } from 'zustand'
import { Storage } from '~/lib/storage'
import { pushModeSelect } from '~/lib/mode-sync'

/**
 * Simple mode preference (answer in plain text): disabled by default
 * in every chat; the user can turn it on per chat. Only the activations are persisted
 * (Storage) — no override = disabled.
 *
 * New chats (without a session) use the "draft" key; when the session is created on the
 * first send, the session-store calls adopt() to transfer the override.
 */

const STORAGE_KEY = 'orbit_simple_prefs'
const DRAFT_KEY = 'draft'

type Overrides = Record<string, boolean | undefined>

interface SimplePrefsState {
  overrides: Overrides
  hydrated: boolean
  hydrate: () => Promise<void>
  setEnabled: (sessionId: string | null | undefined, value: boolean) => void
  /** Applies the map coming from the desktop (without sending the toggle back there). */
  applySync: (overrides: Overrides) => void
  adopt: (sessionId: string) => void
  clear: (sessionId: string) => void
}

export const useSimplePrefs = create<SimplePrefsState>((set, get) => ({
  overrides: {},
  hydrated: false,

  hydrate: async () => {
    try {
      const raw = await Storage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as Overrides
        if (parsed && typeof parsed === 'object') {
          set({ overrides: parsed, hydrated: true })
          return
        }
      }
    } catch {
      // corrupted prefs — goes back to the default (disabled)
    }
    set({ hydrated: true })
  },

  setEnabled: (sessionId, value) => {
    const key = sessionId ?? DRAFT_KEY
    const overrides = { ...get().overrides }
    if (value) overrides[key] = true
    else delete overrides[key]
    void Storage.setItem(STORAGE_KEY, JSON.stringify(overrides))
    set({ overrides })
    pushModeSelect('simple', sessionId, value)
  },

  applySync: (overrides) => {
    void Storage.setItem(STORAGE_KEY, JSON.stringify(overrides))
    set({ overrides })
  },

  adopt: (sessionId) => {
    const overrides = { ...get().overrides }
    if (overrides[DRAFT_KEY] === undefined) return
    const value = overrides[DRAFT_KEY]
    overrides[sessionId] = value
    delete overrides[DRAFT_KEY]
    void Storage.setItem(STORAGE_KEY, JSON.stringify(overrides))
    set({ overrides })
    pushModeSelect('simple', sessionId, value ?? false)
  },

  clear: (sessionId) => {
    const overrides = { ...get().overrides }
    delete overrides[sessionId]
    void Storage.setItem(STORAGE_KEY, JSON.stringify(overrides))
    set({ overrides })
  },
}))

export function useSimpleMode(sessionId?: string | null, fallback = false): boolean {
  return useSimplePrefs((s) => s.overrides[sessionId ?? DRAFT_KEY] ?? fallback)
}

export function simpleModeFor(sessionId?: string | null, fallback = false): boolean {
  return useSimplePrefs.getState().overrides[sessionId ?? DRAFT_KEY] ?? fallback
}
