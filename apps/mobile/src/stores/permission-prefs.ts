import { create } from 'zustand'
import type { PermissionMode } from '@orbit/shared'
import { Storage } from '~/lib/storage'
import { useConnectionStore } from '~/stores/connection-store'

/**
 * Autonomy level PER CHAT, mirror of the desktop.
 *
 * `defaultMode` is the new-chat default (and the fallback of whoever never chose);
 * `modes` holds the choice of each session — switching to Unrestricted in one chat does not
 * loosen the others. It lives outside the PromptInput because the plan review card
 * also reads the level of the chat.
 */

const DEFAULT_KEY = 'orbit-permission-mode'
const STORAGE_KEY = 'orbit_session_permission'
export const DRAFT_KEY = 'draft'

function isMode(value: unknown): value is PermissionMode {
  return value === 'ask' || value === 'approve' || value === 'full'
}

interface PermissionPrefsState {
  defaultMode: PermissionMode
  modes: Record<string, PermissionMode>
  hydrated: boolean
  hydrate: () => Promise<void>
  /** Choice made here: notifies the desktop (source of truth) and waits for the map
   *  to come back through 'session:prefs-change'. The draft is per device. */
  setMode: (sessionId: string | null | undefined, mode: PermissionMode) => void
  /** Change that came from the desktop (snapshot or event). */
  applyRemoteMode: (sessionId: string, mode: PermissionMode) => void
  /** App preference coming from the desktop: new-chat default. */
  setDefaultMode: (mode: PermissionMode) => void
  adopt: (sessionId: string) => void
  clear: (sessionId: string) => void
}

async function write(modes: Record<string, PermissionMode>) {
  await Storage.setItem(STORAGE_KEY, JSON.stringify(modes))
}

function normalizar(map: unknown): Record<string, PermissionMode> {
  const out: Record<string, PermissionMode> = {}
  if (!map || typeof map !== 'object') return out
  for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
    if (isMode(value)) out[key] = value
  }
  return out
}

export const usePermissionPrefs = create<PermissionPrefsState>((set, get) => ({
  defaultMode: 'ask',
  modes: {},
  hydrated: false,

  hydrate: async () => {
    try {
      const stored = await Storage.getItem(DEFAULT_KEY)
      if (isMode(stored)) set({ defaultMode: stored })
    } catch {
      // unreadable preference — goes on with the most conservative default (ask)
    }
    try {
      const raw = await Storage.getItem(STORAGE_KEY)
      if (raw) set({ modes: normalizar(JSON.parse(raw)) })
    } catch {
      // corrupted map — every chat follows the default
    }
    set({ hydrated: true })
  },

  setMode: (sessionId, mode) => {
    if (!isMode(mode)) return
    const key = sessionId ?? DRAFT_KEY
    const modes = { ...get().modes, [key]: mode }
    void write(modes)

    if (sessionId) {
      set({ modes })
      const { wsClient } = useConnectionStore.getState()
      try {
        void wsClient.send({ type: 'session:prefs-select', sessionId, permission: mode }).catch(() => {})
      } catch {
        // Offline: the turn from here carries the level of this session.
      }
      return
    }

    // New chat: it also becomes the default of the device (same contract as the desktop).
    void Storage.setItem(DEFAULT_KEY, mode)
    set({ modes, defaultMode: mode })
  },

  applyRemoteMode: (sessionId, mode) => {
    if (!sessionId || !isMode(mode)) return
    const modes = { ...get().modes, [sessionId]: mode }
    void write(modes)
    set({ modes })
  },

  setDefaultMode: (mode) => {
    if (!isMode(mode)) return
    void Storage.setItem(DEFAULT_KEY, mode)
    set({ defaultMode: mode })
  },

  adopt: (sessionId) => {
    const { modes } = get()
    if (!(DRAFT_KEY in modes)) return
    const next = { ...modes, [sessionId]: modes[DRAFT_KEY] }
    delete next[DRAFT_KEY]
    void write(next)
    set({ modes: next })
  },

  clear: (sessionId) => {
    const modes = { ...get().modes }
    delete modes[sessionId]
    void write(modes)
    set({ modes })
  },
}))

/** Effective level of the chat: session override > app default. */
export function permissionFor(sessionId?: string | null): PermissionMode {
  const { modes, defaultMode } = usePermissionPrefs.getState()
  return modes[sessionId ?? DRAFT_KEY] ?? defaultMode
}

export function usePermissionMode(sessionId?: string | null): PermissionMode {
  const key = sessionId ?? DRAFT_KEY
  return usePermissionPrefs((s) => s.modes[key] ?? s.defaultMode)
}
