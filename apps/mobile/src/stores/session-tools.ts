import { create } from 'zustand'
import { Storage } from '~/lib/storage'
import { pushToolsSelect } from '~/lib/tools-sync'
import { useConnectionStore } from '~/stores/connection-store'

/**
 * MCP servers of the conversation — mobile mirror of the desktop store of the same name.
 *
 * The tools have no on/off of their own: they exist while a server is enabled in the app.
 * What changes from chat to chat is WHICH servers enter the context, hence the selection
 * being a subset and not a boolean per server.
 *
 * - `null`  = every server enabled in the app (a new server joins automatically)
 * - `[...]` = only those (an empty list = none in this chat)
 *
 * Turning a server off for real stays in the MCP & Skills page, which applies to every chat.
 */

const STORAGE_KEY = 'orbit_session_tools'
/** New chat (no session yet) — transferred on the first send. */
export const DRAFT_KEY = 'draft'

type ToolsMap = Record<string, string[] | null>

function normalize(parsed: unknown): ToolsMap {
  if (!parsed || typeof parsed !== 'object') return {}
  const map: ToolsMap = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === null) map[key] = null
    else if (Array.isArray(value)) {
      map[key] = value.filter((item): item is string => typeof item === 'string')
    }
  }
  return map
}

interface SessionToolsState {
  bySession: ToolsMap
  hydrated: boolean
  hydrate: () => Promise<void>
  /** `null` goes back to "every server enabled in the app". */
  setServers: (sessionId: string | null | undefined, servers: string[] | null) => void
  /** Transfers the choice of the draft to the session created on the first send. */
  adopt: (sessionId: string) => void
  /** Applies a snapshot coming from the desktop (without sending the selection back there).
   *  In the connect snapshot (`authoritative`) the desktop wins for the chats that
   *  already exist — only the draft key stays local. */
  applySync: (map: ToolsMap, authoritative?: boolean) => void
  /** Snapshot of the desktop (HTTP). Run on connect. */
  fetchRemote: () => Promise<void>
}

export const useSessionTools = create<SessionToolsState>((set, get) => ({
  bySession: {},
  hydrated: false,

  hydrate: async () => {
    // The device read is asynchronous: applying it over a choice made meanwhile would
    // erase the choice — same guard as the per-chat model.
    if (!get().hydrated) {
      try {
        const raw = await Storage.getItem(STORAGE_KEY)
        if (raw) set({ bySession: normalize(JSON.parse(raw)) })
      } catch {
        // corrupted prefs → every server
      }
      set({ hydrated: true })
    }
    await get().fetchRemote()
  },

  setServers: (sessionId, servers) => {
    const key = sessionId ?? DRAFT_KEY
    const bySession = { ...get().bySession, [key]: servers }
    void Storage.setItem(STORAGE_KEY, JSON.stringify(bySession))
    set({ bySession })
    pushToolsSelect(sessionId, servers)
  },

  adopt: (sessionId) => {
    const { bySession } = get()
    if (!(DRAFT_KEY in bySession)) return
    const next = { ...bySession, [sessionId]: bySession[DRAFT_KEY] }
    delete next[DRAFT_KEY]
    void Storage.setItem(STORAGE_KEY, JSON.stringify(next))
    set({ bySession: next })
    // The session was born on the desktop with no selection of its own: it goes there,
    // otherwise the desktop's next snapshot (authoritative on connect) erases it.
    pushToolsSelect(sessionId, next[sessionId] ?? null)
  },

  applySync: (map, authoritative) => {
    const remote = normalize(map)
    if (authoritative) {
      const draft = get().bySession[DRAFT_KEY]
      const next: ToolsMap = { ...remote }
      if (draft !== undefined) next[DRAFT_KEY] = draft
      else delete next[DRAFT_KEY]
      if (JSON.stringify(next) === JSON.stringify(get().bySession)) return
      void Storage.setItem(STORAGE_KEY, JSON.stringify(next))
      set({ bySession: next })
      return
    }
    const next = { ...get().bySession }
    let changed = false
    for (const [key, value] of Object.entries(remote)) {
      if (!(key in next)) {
        next[key] = value
        changed = true
      }
    }
    if (!changed) return
    void Storage.setItem(STORAGE_KEY, JSON.stringify(next))
    set({ bySession: next })
  },

  fetchRemote: async () => {
    const { http } = useConnectionStore.getState()
    if (!http) return
    try {
      const res = await http.getSessionTools()
      if (res.ok && res.data) {
        const remote = (res.data as { overrides?: ToolsMap }).overrides
        if (remote) get().applySync(remote, true)
      }
    } catch {
      // Offline — keeps the local cache
    }
  },
}))

/** `null` = every server enabled in the app. */
export function useToolsServers(sessionId: string | null | undefined): string[] | null {
  return useSessionTools((s) => s.bySession[sessionId ?? DRAFT_KEY] ?? null)
}
