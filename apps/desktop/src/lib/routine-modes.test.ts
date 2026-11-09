import { describe, expect, it } from "vitest"
import { restrictModesToChat, routineModeFor, routineOptions } from "@shared/routines"

describe("routineModeFor", () => {
  it("runs as a chat without folders and as code with at least one", () => {
    expect(routineModeFor([])).toBe("chat")
    expect(routineModeFor(["/repo"])).toBe("code")
    expect(routineModeFor(["/a", "/b"])).toBe("code")
  })
})

describe("restrictModesToChat", () => {
  it("keeps the chat modes and the permission, drops the code-only ones", () => {
    const out = restrictModesToChat({ brain: true, browser: true, loop: true, orchestrate: true, plan: true, subagents: true, permissionMode: "full" })
    expect(out).toEqual({ brain: true, browser: true, permissionMode: "full" })
  })

  it("leaves nothing but the permission when no chat mode was on", () => {
    expect(restrictModesToChat({ loop: true, permissionMode: "approve" })).toEqual({ permissionMode: "approve" })
  })
})

describe("routineOptions with a team", () => {
  it("runs the team unattended, with the ceiling when there is one", () => {
    expect(routineOptions({ orchestrate: true }).orchestrate).toEqual({ unattended: {} })
    expect(routineOptions({ orchestrate: true }, { tokenBudget: 50000 }).orchestrate).toEqual({
      unattended: { tokenBudget: 50000 },
    })
  })
  it("leaves a single-agent routine alone", () => {
    expect(routineOptions({ brain: true }, { tokenBudget: 50000 }).orchestrate).toBeUndefined()
  })
})
