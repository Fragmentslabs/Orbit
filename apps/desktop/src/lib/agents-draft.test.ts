import { describe, expect, it } from "vitest"
import { agentsAreValid, draftOf, emptyAgents, isTeam, newMember, soloAgent, storedFields, waitsFor, withoutMember } from "./agents-draft"

describe("agents draft", () => {
  it("starts as a single agent on the general setup", () => {
    const draft = emptyAgents()
    expect(isTeam(draft)).toBe(false)
    expect(soloAgent(draft)).toBeUndefined()
    expect(agentsAreValid(draft)).toBe(true)
    expect(storedFields(draft)).toEqual({})
  })

  it("stores a single agent as the routine's agent", () => {
    const draft = { members: [newMember({ agent: "agent:x" })] }
    expect(storedFields(draft)).toEqual({ agent: "agent:x" })
  })

  it("stores two or more as a team, with the limits only then", () => {
    const draft = {
      members: [newMember({ id: "a", name: "A", task: "x" }), newMember({ id: "b", name: "B", task: "y", dependsOn: ["a"] })],
      maxParallel: 2,
      tokenBudget: 1000,
      review: true,
    }
    expect(storedFields(draft)).toEqual({ team: { members: draft.members, maxParallel: 2 }, tokenBudget: 1000, review: true })
  })

  it("a team needs a name and an instruction on every member", () => {
    const base = [newMember({ id: "a", name: "A", task: "x" })]
    expect(agentsAreValid({ members: [...base, newMember({ id: "b", name: "B" })] })).toBe(false)
    expect(agentsAreValid({ members: [...base, newMember({ id: "b", name: "B", task: "y" })] })).toBe(true)
  })

  it("removing a member drops the dependencies on it; one left is a single agent again", () => {
    const draft = withoutMember(
      { members: [newMember({ id: "a", name: "A", task: "x", agent: "agent:x" }), newMember({ id: "b", name: "B", task: "y", dependsOn: ["a"] })] },
      "b",
    )
    expect(isTeam(draft)).toBe(false)
    expect(soloAgent(draft)).toBe("agent:x")
    const other = withoutMember({ members: [newMember({ id: "a" }), newMember({ id: "b", dependsOn: ["a"] }), newMember({ id: "c" })] }, "a")
    expect(other.members.find((m) => m.id === "b")?.dependsOn).toEqual([])
  })

  it("reads a routine back: a team, a single agent or nothing", () => {
    const team = { members: [newMember({ id: "a", name: "A", task: "x" }), newMember({ id: "b", name: "B", task: "y" })] }
    expect(isTeam(draftOf({ team, tokenBudget: 5 }))).toBe(true)
    expect(soloAgent(draftOf({ agent: "agent:z" }))).toBe("agent:z")
    expect(soloAgent(draftOf({}))).toBeUndefined()
  })

  it("lists the names a member waits for", () => {
    const a = newMember({ id: "a", name: "Writer" })
    const b = newMember({ id: "b", name: "" })
    const c = newMember({ id: "c", dependsOn: ["a", "b", "ghost"] })
    expect(waitsFor(a, [a, b, c])).toEqual([])
    expect(waitsFor(c, [a, b, c], "?")).toEqual(["Writer", "?"])
  })
})
