import { create } from "zustand"

/**
 * Brain mode preference (persistent memory): on by default in every
 * chat, in both modes; the user can turn it off per chat. Only the opt-outs
 * are persisted (localStorage) — no override = on.
 *
 * New chats (without a session) use the "draft" key; when the session is created on
 * the first send, the session-store calls adopt() to transfer the override.
 *
 * GENERAL preferences (not per session):
 * - chatContext / codeContext: context injection in the prompt
 *   "off" = off
 *   "all" = on in all chats
 *   "memory" = on only in chats with memory mode on
 */

export type BrainContextMode = "off" | "all" | "memory"

const STORAGE_KEY = "orbit-brain-prefs"
const DRAFT_KEY = "draft"
const CHAT_CONTEXT_KEY = "orbit-chat-brain-context"
const CODE_CONTEXT_KEY = "orbit-code-brain-context"

function load(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    // corrupted prefs — back to the default (everything on)
  }
  return {}
}

function persist(overrides: Record<string, boolean>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides))
}

function loadContext(key: string, fallback: BrainContextMode): BrainContextMode {
  try {
    const raw = localStorage.getItem(key)
    if (raw !== null) {
      const v = JSON.parse(raw) as BrainContextMode
      if (v === "off" || v === "all" || v === "memory") return v
    }
  } catch {
    // ignore
  }
  return fallback
}

interface BrainPrefsState {
  overrides: Record<string, boolean>
  chatContext: BrainContextMode
  codeContext: BrainContextMode
  setEnabled: (sessionId: string | null | undefined, enabled: boolean) => void
  setChatContext: (mode: BrainContextMode) => void
  setCodeContext: (mode: BrainContextMode) => void
  /** Transfers the draft's override to the newly created session */
  adopt: (sessionId: string) => void
}

export const useBrainPrefs = create<BrainPrefsState>((set, get) => ({
  overrides: load(),
  chatContext: loadContext(CHAT_CONTEXT_KEY, "all"),
  codeContext: loadContext(CODE_CONTEXT_KEY, "all"),
  setEnabled: (sessionId, enabled) => {
    const key = sessionId ?? DRAFT_KEY
    const overrides = { ...get().overrides }
    if (enabled) delete overrides[key]
    else overrides[key] = false
    persist(overrides)
    set({ overrides })
  },
  setChatContext: (mode) => {
    localStorage.setItem(CHAT_CONTEXT_KEY, JSON.stringify(mode))
    set({ chatContext: mode })
  },
  setCodeContext: (mode) => {
    localStorage.setItem(CODE_CONTEXT_KEY, JSON.stringify(mode))
    set({ codeContext: mode })
  },
  adopt: (sessionId) => {
    const overrides = { ...get().overrides }
    if (overrides[DRAFT_KEY] === undefined) return
    overrides[sessionId] = overrides[DRAFT_KEY]
    delete overrides[DRAFT_KEY]
    persist(overrides)
    set({ overrides })
  },
}))

export function useBrainEnabled(sessionId?: string | null, fallback = true): boolean {
  return useBrainPrefs((s) => s.overrides[sessionId ?? DRAFT_KEY] ?? fallback)
}

/** Read outside React components (send callbacks) */
export function brainEnabledFor(sessionId?: string | null, fallback = true): boolean {
  return useBrainPrefs.getState().overrides[sessionId ?? DRAFT_KEY] ?? fallback
}

export function useChatContext(): BrainContextMode {
  return useBrainPrefs((s) => s.chatContext)
}

export function useCodeContext(): BrainContextMode {
  return useBrainPrefs((s) => s.codeContext)
}
