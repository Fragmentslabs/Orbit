import { create } from "zustand"

/**
 * Per-chat enablement of the modes that used to be input-local state
 * (research, browser, plan, subagents, orchestration and vision).
 *
 * Same semantics as brain-prefs/simple-prefs: the effective value is
 * `override ?? default`, where the default comes from the preferences
 * (model-mode-prefs, split by chat/code mode). New chats (without a session)
 * use the "draft" key; when the session is created on the first send, the
 * session-store calls adopt() to transfer the overrides.
 */

// "computer" is not part of the mode sync with the phone (session-modes-sync):
// controlling the computer is a decision for whoever is in front of it.
export type OverridableMode = "search" | "browser" | "plan" | "subagents" | "orchestra" | "vision" | "computer"

const STORAGE_KEY = "orbit-mode-overrides"
const DRAFT_KEY = "draft"

type OverrideMap = Partial<Record<OverridableMode, Record<string, boolean>>>

function load(): OverrideMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as OverrideMap
      if (parsed && typeof parsed === "object") return parsed
    }
  } catch {
    // corrupted prefs → no overrides
  }
  return {}
}

function persist(overrides: OverrideMap) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides))
}

interface ModeOverridesState {
  overrides: OverrideMap
  setMode: (mode: OverridableMode, sessionId: string | null | undefined, value: boolean) => void
  /** Transfers the draft's overrides to the newly created session */
  adopt: (sessionId: string) => void
}

export const useModeOverrides = create<ModeOverridesState>((set) => ({
  overrides: load(),
  setMode: (mode, sessionId, value) => {
    const key = sessionId ?? DRAFT_KEY
    set((state) => {
      const bySession = { ...state.overrides[mode], [key]: value }
      const overrides = { ...state.overrides, [mode]: bySession }
      persist(overrides)
      return { overrides }
    })
  },
  adopt: (sessionId) => {
    set((state) => {
      const overrides: OverrideMap = {}
      let changed = false
      for (const mode of Object.keys(state.overrides) as OverridableMode[]) {
        const bySession = state.overrides[mode]
        if (!bySession || bySession[DRAFT_KEY] === undefined) {
          overrides[mode] = bySession
          continue
        }
        changed = true
        overrides[mode] = { ...bySession, [sessionId]: bySession[DRAFT_KEY] }
        delete overrides[mode]![DRAFT_KEY]
      }
      if (!changed) return {}
      persist(overrides)
      return { overrides }
    })
  },
}))

export function useModeActive(mode: OverridableMode, sessionId?: string | null, fallback = false): boolean {
  return useModeOverrides((s) => s.overrides[mode]?.[sessionId ?? DRAFT_KEY] ?? fallback)
}

/** Read outside React components (send callbacks) */
export function modeActiveFor(mode: OverridableMode, sessionId?: string | null, fallback = false): boolean {
  return useModeOverrides.getState().overrides[mode]?.[sessionId ?? DRAFT_KEY] ?? fallback
}
