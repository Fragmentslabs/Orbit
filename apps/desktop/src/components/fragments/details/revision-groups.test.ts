import { describe, expect, it } from "vitest"
import type { FragmentRevisionInfo } from "@shared/fragment-details"
import { groupRevisionsByTurn } from "./revision-groups"

const rev = (revision: number, turn: string, path = "index.html"): FragmentRevisionInfo => ({
  revision,
  at: revision * 1000,
  turn,
  path,
  kind: "edit",
})

describe("groupRevisionsByTurn", () => {
  it("groups the writes of one turn, oldest write first, and the newest turn on top", () => {
    const turns = groupRevisionsByTurn([rev(5, "b", "style.css"), rev(4, "b"), rev(3, "a"), rev(2, "a")])
    expect(turns.map((t) => t.turn)).toEqual(["b", "a"])
    expect(turns[0].changes.map((c) => c.revision)).toEqual([4, 5])
    expect(turns[0].firstRevision).toBe(4)
    expect(turns[1].firstRevision).toBe(2)
  })

  it("is empty without history", () => {
    expect(groupRevisionsByTurn([])).toEqual([])
  })
})
