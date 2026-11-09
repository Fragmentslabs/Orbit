import { describe, expect, it } from "vitest"
import { teamIsValid, withoutMember } from "./team-draft"

describe("team editor helpers", () => {
  it("removing a member also removes the dependencies on it", () => {
    const team = withoutMember(
      {
        members: [
          { id: "a", name: "A", task: "x" },
          { id: "b", name: "B", task: "y", dependsOn: ["a"] },
        ],
      },
      "a",
    )
    expect(team.members).toHaveLength(1)
    expect(team.members[0].dependsOn).toEqual([])
  })

  it("needs a name and an instruction on every member", () => {
    expect(teamIsValid({ team: { members: [] } })).toBe(true)
    expect(teamIsValid({ team: { members: [{ id: "a", name: "A", task: "" }] } })).toBe(false)
    expect(teamIsValid({ team: { members: [{ id: "a", name: "A", task: "x" }] } })).toBe(true)
  })
})
