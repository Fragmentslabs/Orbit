import { create } from "zustand"

const STORAGE_KEY = "orbit-simple-prefs"
const DRAFT_KEY = "draft"

function load(): Record<string, boolean | undefined> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    // prefs corrompidas — volta ao default (desativado)
  }
  return {}
}

function persist(overrides: Record<string, boolean | undefined>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides))
}

interface SimplePrefsState {
  overrides: Record<string, boolean | undefined>
  setEnabled: (sessionId: string | null | undefined, value: boolean) => void
  adopt: (sessionId: string) => void
  clear: (sessionId: string) => void
}

export const useSimplePrefs = create<SimplePrefsState>((set, get) => ({
  overrides: load(),
  setEnabled: (sessionId, value) => {
    const key = sessionId ?? DRAFT_KEY
    const overrides = { ...get().overrides }
    if (value) overrides[key] = true
    else delete overrides[key]
    persist(overrides)
    set({ overrides })
  },
  adopt: (sessionId) => {
    const overrides = { ...get().overrides }
    if (overrides[DRAFT_KEY] === undefined) return
    overrides[sessionId] = overrides[DRAFT_KEY]
    delete overrides[DRAFT_KEY]
    persist(overrides)
    set({ overrides })
  },
  clear: (sessionId) => {
    const overrides = { ...get().overrides }
    delete overrides[sessionId]
    persist(overrides)
    set({ overrides })
  },
}))

export function useSimpleMode(sessionId?: string | null): boolean {
  return useSimplePrefs((s) => s.overrides[sessionId ?? DRAFT_KEY] ?? false)
}

export function simpleModeFor(sessionId?: string | null): boolean {
  return useSimplePrefs.getState().overrides[sessionId ?? DRAFT_KEY] ?? false
}
