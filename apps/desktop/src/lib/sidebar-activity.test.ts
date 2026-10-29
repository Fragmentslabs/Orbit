import { describe, expect, it } from "vitest"

import { sessionActivityMap, type SessionInfo } from "@shared/chat"

/**
 * A ordem da sidebar usa a atividade do BLOCO (pai + sub-chats/workers), não a
 * do pai sozinho: interagir com uma conversa lateral tem de subir o pai junto.
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
  it("chat sem filhos vale a própria atividade", () => {
    const root = session({ updatedAt: 10 })
    expect(sessionActivityMap([root]).get(root.id)).toBe(10)
  })

  it("sub-chat mais recente sobe o pai", () => {
    const root = session({ updatedAt: 10 })
    const child = session({ updatedAt: 50, parentId: root.id })
    const map = sessionActivityMap([root, child])
    expect(map.get(root.id)).toBe(50)
    expect(map.get(child.id)).toBe(50)
  })

  it("worker de outra modalidade também conta", () => {
    const root = session({ updatedAt: 10, mode: "chat" })
    const worker = session({
      updatedAt: 90,
      mode: "code",
      parentId: root.id,
      orchestration: { role: "worker" } as SessionInfo["orchestration"],
    })
    expect(sessionActivityMap([root, worker]).get(root.id)).toBe(90)
  })

  it("neto (sub-chat de sub-chat) sobe a cadeia inteira", () => {
    const root = session({ updatedAt: 10 })
    const child = session({ updatedAt: 20, parentId: root.id })
    const grandchild = session({ updatedAt: 70, parentId: child.id })
    const map = sessionActivityMap([root, child, grandchild])
    expect(map.get(root.id)).toBe(70)
    expect(map.get(child.id)).toBe(70)
  })

  it("filho arquivado não move o pai", () => {
    const root = session({ updatedAt: 10 })
    const child = session({ updatedAt: 80, parentId: root.id, archived: true })
    expect(sessionActivityMap([root, child]).get(root.id)).toBe(10)
  })

  it("parentId em ciclo não trava", () => {
    const a = session({ updatedAt: 5 })
    const b = session({ updatedAt: 7, parentId: a.id })
    a.parentId = b.id
    const map = sessionActivityMap([a, b])
    expect(map.get(a.id)).toBe(7)
    expect(map.get(b.id)).toBe(7)
  })
})
