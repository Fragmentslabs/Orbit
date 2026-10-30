import { describe, expect, it } from "vitest"
import { INITIAL_TURNS, defaultWindowStart, turnStart, windowStartFor } from "./message-window"

const conv = (pattern: string) => [...pattern].map((c) => ({ role: c === "u" ? "user" : "assistant" }))

describe("message-window", () => {
  it("starts at the Nth question counting from the end", () => {
    const msgs = conv("uauauaua")
    expect(turnStart(msgs, msgs.length, 1)).toBe(6)
    expect(turnStart(msgs, msgs.length, 2)).toBe(4)
  })

  it("with not enough turns, it starts from zero", () => {
    expect(turnStart(conv("aua"), 3, 5)).toBe(0)
    expect(turnStart([], 0, 3)).toBe(0)
  })

  it("extending from the current start adds turns above it", () => {
    const msgs = conv("uauauauaua")
    const start = turnStart(msgs, msgs.length, 2) // 6
    expect(turnStart(msgs, start, 2)).toBe(2)
  })

  it("never opens with half a reply: the window starts at a user message", () => {
    const msgs = conv("uaaauaaua")
    expect(msgs[turnStart(msgs, msgs.length, 2)].role).toBe("user")
  })

  it("the default window builds only the last turns", () => {
    const msgs = conv("ua".repeat(INITIAL_TURNS + 30))
    expect(defaultWindowStart(msgs)).toBe(60)
    expect(msgs.length - defaultWindowStart(msgs)).toBe(INITIAL_TURNS * 2)
  })

  it("revealing an old reply includes its question", () => {
    const msgs = conv("uauaaua")
    expect(windowStartFor(msgs, 4)).toBe(2)
    expect(windowStartFor(msgs, 2)).toBe(2)
  })
})
