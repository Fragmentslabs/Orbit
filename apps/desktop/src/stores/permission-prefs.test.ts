import { beforeEach, describe, expect, it, vi } from "vitest"

const replies = vi.hoisted(() => [] as Array<[string, unknown]>)
const sessions = vi.hoisted(() => ({
  pendingAsks: {} as Record<string, Array<Record<string, unknown>>>,
}))
vi.mock("@/src/lib/ipc", () => ({
  chatApi: { askReply: (id: string, value: unknown) => replies.push([id, value]) },
}))
vi.mock("@/src/stores/session-store", () => ({ useSessionStore: { getState: () => sessions } }))

const stored: Record<string, string> = {}
vi.stubGlobal("localStorage", {
  getItem: (k: string) => stored[k] ?? null,
  setItem: (k: string, v: string) => {
    stored[k] = v
  },
})

const { usePermissionPrefs, permissionFor } = await import("./permission-prefs")

beforeEach(() => {
  replies.length = 0
  stored["orbit-permission-mode"] = "ask"
  stored["orbit-session-permission"] = "{}"
  usePermissionPrefs.setState({ defaultMode: "ask", modes: {} })
  sessions.pendingAsks = {
    s_screen: [
      { requestId: "p1", kind: "permission", claim: { tool: "bash", title: "x" } },
      { requestId: "p2", kind: "permission", claim: { tool: "worktree_remove", title: "y", alwaysAsk: true } },
      { requestId: "q1", kind: "question", questions: [] },
    ],
    s_other: [{ requestId: "p3", kind: "permission", claim: { tool: "bash", title: "z" } }],
  }
})

describe("autonomy per chat", () => {
  it("changing it in one chat does NOT change the other or the default", () => {
    usePermissionPrefs.getState().setMode("s_a", "full")
    expect(permissionFor("s_a")).toBe("full")
    expect(permissionFor("s_b")).toBe("ask")
    expect(usePermissionPrefs.getState().defaultMode).toBe("ask")
  })

  it("a new chat (draft) becomes the default for the next new chat", () => {
    usePermissionPrefs.getState().setMode(null, "approve")
    expect(permissionFor(null)).toBe("approve")
    expect(usePermissionPrefs.getState().defaultMode).toBe("approve")
  })

  it("adopt carries the draft's choice to the created session", () => {
    usePermissionPrefs.getState().setMode(null, "full")
    usePermissionPrefs.getState().adopt("s_nova")
    expect(permissionFor("s_nova")).toBe("full")
    // The draft disappears: the next new chat is already born in the default (which the choice
    // in the current new chat updated, as happens with the model).
    expect(usePermissionPrefs.getState().modes.draft).toBeUndefined()
    expect(permissionFor(null)).toBe("full")
  })
})

describe("changing the level from the screen", () => {
  it("for Unrestricted it approves the open permission requests of THAT chat", () => {
    usePermissionPrefs.getState().setMode("s_screen", "full")
    expect(replies).toEqual([["p1", "allow"]])
  })

  it("for Ask or Approve it answers nothing", () => {
    usePermissionPrefs.getState().setMode("s_screen", "approve")
    expect(replies).toEqual([])
  })

  it("a change coming from the phone only changes the chat's level, without releasing requests", () => {
    usePermissionPrefs.getState().applyRemoteMode("s_other", "full")
    expect(permissionFor("s_other")).toBe("full")
    expect(permissionFor("s_screen")).toBe("ask")
    expect(replies).toEqual([])
  })
})
