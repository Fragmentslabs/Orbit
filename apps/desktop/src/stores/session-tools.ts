import { create } from "zustand"
import { sessionToolsApi } from "@/src/lib/ipc"

/**
 * MCP servers per conversation.
 *
 * The tools have no on/off: they exist whenever there is a server
 * on in the app. What changes from conversation to conversation is WHICH servers
 * enter the context — hence this store being only the selection, and living apart from the
 * mode overrides (which keep booleans and would not serve for a subset).
 *
 * - `null`   = all servers on in the app
 * - `[...]`  = only those (empty list = none in this conversation)
 *
 * Turning a SERVER off for real happens in the MCP & Skills page (`config.enabled`),
 * which applies to all conversations. Here it is only the local subset.
 */

const STORAGE_KEY = "orbit-session-tools"
/** Draft per device, as in mode-overrides */
const DRAFT_KEY = "draft"

type ToolsMap = Record<string, string[] | null>

function toStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((item): item is string => typeof item === "string")
}

function load(): ToolsMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== "object") return {}
    const map: ToolsMap = {}
    for (const [key, value] of Object.entries(parsed)) {
      // Old format (`{ enabled, servers }`), from when the control had a
      // general switch: it keeps only the subset and discards the boolean.
      if (Array.isArray(value)) map[key] = toStringList(value)
      else if (value && typeof value === "object" && "servers" in value) {
        map[key] = toStringList((value as { servers?: unknown }).servers)
      }
    }
    return map
  } catch {
    // corrupted prefs → no subset (all servers on)
    return {}
  }
}

function persist(bySession: ToolsMap) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(bySession))
}

interface SessionToolsState {
  bySession: ToolsMap
  /** Explicit subset; `null` goes back to "all the ones on in the app". */
  setServers: (sessionId: string | null | undefined, servers: string[] | null) => void
  /** Transfers the draft's preference to the newly created session */
  adopt: (sessionId: string) => void
}

export const useSessionTools = create<SessionToolsState>((set) => ({
  bySession: load(),

  setServers: (sessionId, servers) => {
    const key = sessionId ?? DRAFT_KEY
    set((state) => {
      const bySession = { ...state.bySession, [key]: servers }
      persist(bySession)
      return { bySession }
    })
  },

  adopt: (sessionId) => {
    set((state) => {
      if (!(DRAFT_KEY in state.bySession)) return {}
      const bySession = { ...state.bySession, [sessionId]: state.bySession[DRAFT_KEY] }
      delete bySession[DRAFT_KEY]
      persist(bySession)
      return { bySession }
    })
  },
}))

/** `null` = all servers on in the app. */
export function useToolsServers(sessionId: string | null | undefined): string[] | null {
  return useSessionTools((s) => s.bySession[sessionId ?? DRAFT_KEY] ?? null)
}

// ─── Sync with the companions (mobile) ─────────────────────────────────────
// The selection of each chat lives here (the renderer's localStorage), same as the
// model and the modes: it goes to main (HTTP + WS 'session:tools-change') on every
// change, so a conversation opened on the phone arrives with the same tools, and the
// selection made there comes back through 'companion:tools-select'.

/** The draft is a different new chat on each device: it does not travel. */
function withoutDraft(bySession: ToolsMap): ToolsMap {
  const out: ToolsMap = {}
  for (const [key, value] of Object.entries(bySession)) {
    if (key === DRAFT_KEY) continue
    out[key] = value
  }
  return out
}

function sync() {
  sessionToolsApi.sync(withoutDraft(useSessionTools.getState().bySession))
}

if (typeof window !== "undefined" && window.ipcRenderer) {
  // Initial push: after a renderer reload the main cache is empty and a phone
  // connecting before the first change would receive nothing.
  sync()
  useSessionTools.subscribe(sync)
  sessionToolsApi.onSelect(({ sessionId, servers }) => {
    useSessionTools.getState().setServers(sessionId ?? null, servers)
  })
}
