import { describe, expect, it } from "vitest"
import { applyAgentModes, modesFromAgentFeatures, routineOptions } from "@shared/routines"

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

const features = { vision: false, subagents: false, orchestra: false, loop: false, memories: false }

describe("abilities come from the agent", () => {
  it("maps what the agent allows to the routine's modes", () => {
    expect(modesFromAgentFeatures(features)).toEqual({})
    expect(modesFromAgentFeatures({ ...features, vision: true, orchestra: true, memories: true })).toEqual({
      vision: true,
      orchestrate: true,
      brain: true,
    })
  })

  it("replaces the governed modes, keeps autonomy and the modes the agent never governs", () => {
    const modes = { permissionMode: "full" as const, vision: true, loop: true, browser: true, search: true }
    expect(applyAgentModes(modes, { ...features, subagents: true })).toEqual({
      permissionMode: "full",
      browser: true,
      search: true,
      subagents: true,
      vision: undefined,
      loop: undefined,
      orchestrate: undefined,
      brain: undefined,
    })
  })
})
