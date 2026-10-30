import { create } from "zustand"
import type { PermissionMode } from "@shared/chat"
import { chatApi } from "@/src/lib/ipc"
import { useSessionStore } from "@/src/stores/session-store"

/**
 * Autonomy level PER CHAT, in the same design as the per-chat model.
 *
 * `defaultMode` is the default (the last level used in a new chat) and also the
 * fallback for whoever never chose anything — it is what the Preferences and the
 * companions see as the "app mode". `modes` keeps each session's choice:
 * switching to Unrestricted in one chat does NOT loosen the others (before it was a single key,
 * `orbit-permission-mode`, and the selector changed the whole app).
 */

const DEFAULT_KEY = "orbit-permission-mode"
const STORAGE_KEY = "orbit-session-permission"
const DRAFT_KEY = "draft"

function loadDefault(): PermissionMode {
  const stored = localStorage.getItem(DEFAULT_KEY)
  return stored === "approve" || stored === "full" ? stored : "ask"
}

function isMode(value: unknown): value is PermissionMode {
  return value === "ask" || value === "approve" || value === "full"
}

function loadModes(): Record<string, PermissionMode> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== "object") return {}
    const modes: Record<string, PermissionMode> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (isMode(value)) modes[key] = value
    }
    return modes
  } catch {
    // corrupted prefs → every chat follows the default
    return {}
  }
}

function persistModes(modes: Record<string, PermissionMode>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(modes))
}

interface PermissionPrefsState {
  /** Default of a new chat (and fallback for whoever has not chosen). */
  defaultMode: PermissionMode
  /** sessionId → level chosen in that chat */
  modes: Record<string, PermissionMode>
  /** Switch made on this screen: going to Unrestricted also releases the requests already
   *  open in the target chat. `null`/absent = new chat (draft). */
  setMode: (sessionId: string | null | undefined, mode: PermissionMode) => void
  /** Switch that came from outside (the phone): it only changes that chat's level. The
   *  draft does not travel — "draft" on the phone is another chat. */
  applyRemoteMode: (sessionId: string, mode: PermissionMode) => void
  /** Default coming from another device (app preferences). */
  setDefaultMode: (mode: PermissionMode) => void
  /** Moves the draft's choice to the newly created session. */
  adopt: (sessionId: string) => void
  clear: (sessionId: string) => void
}

/**
 * On switching to Unrestricted, the permission requests already open in the
 * target chat are approved (per turn) — the user has just said they do not
 * want to be asked anymore. The ones in other chats stay: whoever changed the level did not
 * see them. Requests that always ask (e.g.: removing a worktree) also stay.
 */
function releaseRequests(sessionId: string | null | undefined) {
  if (!sessionId) return
  const pending = useSessionStore.getState().pendingAsks[sessionId] ?? []
  for (const ask of pending) {
    if (ask.kind !== "permission" || ask.claim?.alwaysAsk) continue
    void chatApi.askReply(ask.requestId, "allow")
  }
}

export const usePermissionPrefs = create<PermissionPrefsState>((set, get) => ({
  defaultMode: loadDefault(),
  modes: loadModes(),

  setMode: (sessionId, mode) => {
    const key = sessionId ?? DRAFT_KEY
    const previous = get().modes[key] ?? get().defaultMode
    const modes = { ...get().modes, [key]: mode }
    persistModes(modes)

    // New chat: the chosen level also becomes the default, so the next new
    // chat already opens in it (same contract as the per-chat model).
    if (sessionId) {
      set({ modes })
    } else {
      localStorage.setItem(DEFAULT_KEY, mode)
      set({ modes, defaultMode: mode })
    }

    if (mode === "full" && previous !== "full") releaseRequests(sessionId)
  },

  applyRemoteMode: (sessionId, mode) => {
    if (!sessionId || !isMode(mode)) return
    const modes = { ...get().modes, [sessionId]: mode }
    persistModes(modes)
    set({ modes })
  },

  setDefaultMode: (mode) => {
    if (!isMode(mode)) return
    localStorage.setItem(DEFAULT_KEY, mode)
    set({ defaultMode: mode })
  },

  adopt: (sessionId) => {
    const { modes } = get()
    if (!(DRAFT_KEY in modes)) return
    const next = { ...modes, [sessionId]: modes[DRAFT_KEY] }
    delete next[DRAFT_KEY]
    persistModes(next)
    set({ modes: next })
  },

  clear: (sessionId) => {
    const modes = { ...get().modes }
    delete modes[sessionId]
    persistModes(modes)
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
