import { describe, expect, it } from "vitest"
import type { SessionInfo } from "@shared/chat"
import { isRoutineSession, lastUsedChat } from "./last-chat"

function session(over: Partial<SessionInfo>): SessionInfo {
  return { id: "s", title: "t", mode: "chat", pinned: false, archived: false, folderId: null, createdAt: 0, updatedAt: 0, ...over }
}

describe("lastUsedChat", () => {
  it("is the most recently touched chat of the same mode", () => {
    const sessions = [session({ id: "a", updatedAt: 1 }), session({ id: "b", updatedAt: 5 }), session({ id: "c", mode: "code", updatedAt: 9 })]
    expect(lastUsedChat(sessions, "chat")?.id).toBe("b")
  })

  it("skips the new chat itself, archived chats, workers and routine runs", () => {
    const sessions = [
      session({ id: "me", updatedAt: 10 }),
      session({ id: "old", archived: true, updatedAt: 9 }),
      session({ id: "worker", parentId: "x", updatedAt: 8 }),
      session({ id: "run", routineId: "r", updatedAt: 7 }),
      session({ id: "real", updatedAt: 1 }),
    ]
    expect(lastUsedChat(sessions, "chat", "me")?.id).toBe("real")
  })

  it("knows a routine's conversation — its chat and a run's session — apart from a normal one", () => {
    expect(isRoutineSession(session({ routineId: "r" }))).toBe(true)
    expect(isRoutineSession(session({ parentId: "chat", routineId: "r" }))).toBe(true)
    expect(isRoutineSession(session({}))).toBe(false)
    expect(isRoutineSession(undefined)).toBe(false)
  })

  it("falls back to another mode when there is none of this one", () => {
    expect(lastUsedChat([session({ id: "code", mode: "code", updatedAt: 3 })], "chat")?.id).toBe("code")
    expect(lastUsedChat([], "chat")).toBeUndefined()
  })
})
