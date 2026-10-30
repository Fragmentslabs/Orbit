import { create } from 'zustand'
import { Storage } from '~/lib/storage'
import { pushModeSelect } from '~/lib/mode-sync'

/**
 * Brain mode preference (persistent memory): the effective value is
 * `override ?? default` — the default, active for new users,
 * comes from model-mode-prefs; only the per-chat overrides are persisted here
 * (Storage) — no override = follows the default.
 *
 * New chats (without a session) use the "draft" key; when the session is created on the
 * first send, the session-store calls adopt() to transfer the override.
 */

const STORAGE_KEY = 'orbit_brain_prefs'
const DRAFT_KEY = 'draft'

type Overrides = Record<string, boolean>

interface BrainPrefsState {
  overrides: Overrides
  hydrated: boolean
  hydrate: () => Promise<void>
  setEnabled: (sessionId: string | null | undefined, enabled: boolean) => void
  /** Applies the map coming from the desktop (without sending the toggle back there). */
  applySync: (overrides: Overrides) => void
  /** Transfers the draft override to the newly created session */
  adopt: (sessionId: string) => void
}

export const useBrainPrefs = create<BrainPrefsState>((set, get) => ({
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
      // corrupted prefs — goes back to the default (comes from model-mode-prefs)
    }
    set({ hydrated: true })
  },

  setEnabled: (sessionId, enabled) => {
    const key = sessionId ?? DRAFT_KEY
    const overrides = { ...get().overrides }
    if (enabled) delete overrides[key]
    else overrides[key] = false
    void Storage.setItem(STORAGE_KEY, JSON.stringify(overrides))
    set({ overrides })
    pushModeSelect('brain', sessionId, enabled)
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
    pushModeSelect('brain', sessionId, value ?? true)
  },
}))

export function useBrainEnabled(sessionId?: string | null, fallback = true): boolean {
  return useBrainPrefs((s) => s.overrides[sessionId ?? DRAFT_KEY] ?? fallback)
}

/** Read outside React components (send callbacks) */
export function brainEnabledFor(sessionId?: string | null, fallback = true): boolean {
  return useBrainPrefs.getState().overrides[sessionId ?? DRAFT_KEY] ?? fallback
}
