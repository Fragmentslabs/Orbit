import { create } from 'zustand'
import { Storage } from '~/lib/storage'
import { pushModeSelect } from '~/lib/mode-sync'

/**
 * Per-chat activation of the modes that used to be local state of the inputs
 * (research, browser, plan, subagents, orchestration and vision) — mirror of the
 * desktop mode-overrides.
 *
 * Same semantics as brain-prefs/simple-prefs: the effective value is
 * `override ?? default`, where the default comes from the preferences
 * (model-mode-prefs, separate per chat/code mode). New chats (without a session)
 * use the "draft" key; when the session is created on the first send, the
 * session-store calls adopt() to transfer the overrides.
 */

export type OverridableMode =
  | 'search'
  | 'browser'
  | 'plan'
  | 'subagents'
  | 'orchestra'
  | 'vision'

const STORAGE_KEY = 'orbit_mode_overrides'
const DRAFT_KEY = 'draft'

type OverrideMap = Partial<Record<OverridableMode, Record<string, boolean>>>

function normalize(parsed: unknown): OverrideMap {
  if (!parsed || typeof parsed !== 'object') return {}
  return parsed as OverrideMap
}

interface ModeOverridesState {
  overrides: OverrideMap
  hydrated: boolean
  hydrate: () => Promise<void>
  setMode: (
    mode: OverridableMode,
    sessionId: string | null | undefined,
    value: boolean,
  ) => void
  /** Applies the map coming from the desktop (without sending the toggle back there). */
  applySync: (overrides: OverrideMap) => void
  /** Transfers the overrides of the draft to the newly created session */
  adopt: (sessionId: string) => void
}

export const useModeOverrides = create<ModeOverridesState>((set, get) => ({
  overrides: {},
  hydrated: false,

  hydrate: async () => {
    try {
      const raw = await Storage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = normalize(JSON.parse(raw))
        set({ overrides: parsed, hydrated: true })
        return
      }
    } catch {
      // corrupted prefs → no overrides
    }
    set({ hydrated: true })
  },

  setMode: (mode, sessionId, value) => {
    const key = sessionId ?? DRAFT_KEY
    const bySession = { ...get().overrides[mode], [key]: value }
    const overrides = { ...get().overrides, [mode]: bySession }
    void Storage.setItem(STORAGE_KEY, JSON.stringify(overrides))
    set({ overrides })
    pushModeSelect(mode, sessionId, value)
  },

  applySync: (overrides) => {
    void Storage.setItem(STORAGE_KEY, JSON.stringify(overrides))
    set({ overrides })
  },

  adopt: (sessionId) => {
    const current = get().overrides
    const overrides: OverrideMap = {}
    let changed = false
    for (const mode of Object.keys(current) as OverridableMode[]) {
      const bySession = current[mode]
      if (!bySession || bySession[DRAFT_KEY] === undefined) {
        overrides[mode] = bySession
        continue
      }
      changed = true
      const next = { ...bySession, [sessionId]: bySession[DRAFT_KEY] }
      delete next[DRAFT_KEY]
      overrides[mode] = next
    }
    if (!changed) return
    void Storage.setItem(STORAGE_KEY, JSON.stringify(overrides))
    set({ overrides })
    // The session has just been born on the desktop with no mode at all: it sends the ones from
    // the draft, otherwise the chat opens there on the defaults.
    for (const mode of Object.keys(overrides) as OverridableMode[]) {
      const value = overrides[mode]?.[sessionId]
      if (value !== undefined) pushModeSelect(mode, sessionId, value)
    }
  },
}))

export function useModeActive(
  mode: OverridableMode,
  sessionId?: string | null,
  fallback = false,
): boolean {
  return useModeOverrides((s) => s.overrides[mode]?.[sessionId ?? DRAFT_KEY] ?? fallback)
}

/** Read outside React components (send callbacks) */
export function modeActiveFor(
  mode: OverridableMode,
  sessionId?: string | null,
  fallback = false,
): boolean {
  return useModeOverrides.getState().overrides[mode]?.[sessionId ?? DRAFT_KEY] ?? fallback
}
