import { describe, expect, it } from "vitest"
import { resolvePanelSession } from "./panel-session"

const parents: Record<string, string> = { child: "parent", grandchild: "child", loopA: "loopB", loopB: "loopA" }
const parentOf = (id: string) => parents[id]

describe("resolvePanelSession", () => {
  it("keeps a chat without a parent", () => {
    expect(resolvePanelSession("solo", "other", parentOf)).toBe("solo")
  })

  it("routes a subchat to the parent the person is looking at", () => {
    expect(resolvePanelSession("child", "parent", parentOf)).toBe("parent")
  })

  it("keeps the subchat when the person opened it", () => {
    expect(resolvePanelSession("child", "child", parentOf)).toBe("child")
  })

  it("picks the active ancestor in the middle of a chain", () => {
    expect(resolvePanelSession("grandchild", "child", parentOf)).toBe("child")
  })

  it("falls back to the topmost ancestor when the person is elsewhere", () => {
    expect(resolvePanelSession("grandchild", "unrelated", parentOf)).toBe("parent")
    expect(resolvePanelSession("grandchild", null, parentOf)).toBe("parent")
  })

  it("survives a parent cycle", () => {
    expect(resolvePanelSession("loopA", null, parentOf)).toBe("loopB")
  })
})
