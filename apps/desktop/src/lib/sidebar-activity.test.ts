import { describe, expect, it } from "vitest"

import { sessionActivityMap, type SessionInfo } from "@shared/chat"

/**
 * The sidebar order uses the BLOCK's activity (parent + sub-chats/workers), not the
 * parent's alone: interacting with a side conversation has to bring the parent up with it.
 */

let nextId = 0

function session(over: Partial<SessionInfo> & { updatedAt: number }): SessionInfo {
  nextId += 1
  return {
    id: `s${nextId}`,
    title: `chat ${nextId}`,
    mode: "chat",
    pinned: false,
    archived: false,
    folderId: null,
    createdAt: over.updatedAt,
    ...over,
  }
}

describe("sessionActivityMap", () => {
  it("a chat with no children counts its own activity", () => {
    const root = session({ updatedAt: 10 })
    expect(sessionActivityMap([root]).get(root.id)).toBe(10)
  })

  it("the most recent sub-chat lifts the parent", () => {
    const root = session({ updatedAt: 10 })
    const child = session({ updatedAt: 50, parentId: root.id })
    const map = sessionActivityMap([root, child])
    expect(map.get(root.id)).toBe(50)
    expect(map.get(child.id)).toBe(50)
  })

  it("a worker of another modality also counts", () => {
    const root = session({ updatedAt: 10, mode: "chat" })
    const worker = session({
      updatedAt: 90,
      mode: "code",
      parentId: root.id,
      orchestration: { role: "worker" } as SessionInfo["orchestration"],
    })
    expect(sessionActivityMap([root, worker]).get(root.id)).toBe(90)
  })

  it("a grandchild (sub-chat of a sub-chat) lifts the whole chain", () => {
    const root = session({ updatedAt: 10 })
    const child = session({ updatedAt: 20, parentId: root.id })
    const grandchild = session({ updatedAt: 70, parentId: child.id })
    const map = sessionActivityMap([root, child, grandchild])
    expect(map.get(root.id)).toBe(70)
    expect(map.get(child.id)).toBe(70)
  })

  it("an archived child does not move the parent", () => {
    const root = session({ updatedAt: 10 })
    const child = session({ updatedAt: 80, parentId: root.id, archived: true })
    expect(sessionActivityMap([root, child]).get(root.id)).toBe(10)
  })

  it("a parentId in a cycle does not hang", () => {
    const a = session({ updatedAt: 5 })
    const b = session({ updatedAt: 7, parentId: a.id })
    a.parentId = b.id
    const map = sessionActivityMap([a, b])
    expect(map.get(a.id)).toBe(7)
    expect(map.get(b.id)).toBe(7)
  })
})
