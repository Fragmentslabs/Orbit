import { describe, expect, it } from "vitest"
import type { QueuedMessage } from "@shared/chat"
import { EMPTY_SYNC, applySyncEvent, queueOf } from "./remote-sync"

const item = (id: string): QueuedMessage => ({ id, text: id, options: {}, mode: "chat", createdAt: 1 })

describe("applySyncEvent", () => {
  it("replaces each mirror with what the other machine pushed", () => {
    let s = applySyncEvent(EMPTY_SYNC, { type: "queue:change", queues: { a: [item("1")] } })
    expect(queueOf({ ...s }, "a").map((m) => m.id)).toEqual(["1"])
    s = applySyncEvent(s, { type: "session:model-change", overrides: { a: { providerId: "p", modelId: "m" } } })
    s = applySyncEvent(s, { type: "session:prefs-change", prefs: { reasoning: {}, permission: { a: "full" } } })
    expect(s.models.a.modelId).toBe("m")
    expect(s.prefs.permission.a).toBe("full")
    expect(s.queues.a).toHaveLength(1)
  })

  it("ignores events that are not settings (notifications)", () => {
    const s = applySyncEvent(EMPTY_SYNC, { type: "notify:new-message", sessionId: "a", title: "t", preview: "p" } as never)
    expect(s).toBe(EMPTY_SYNC)
  })

  it("queueOf never answers a new array for an empty queue (stable selector)", () => {
    expect(queueOf(undefined, "a")).toBe(queueOf(EMPTY_SYNC, "b"))
  })
})
