import { describe, expect, it } from "vitest"
import { embeddedChatFields, isOwnArtifact } from "./artifact-session"

describe("embeddedChatFields", () => {
  it("marks a fragment chat with its own field and the artifact", () => {
    expect(embeddedChatFields("fragment", { kind: "fragment", id: "frag-1" }, "widget")).toEqual({
      fragment: { kind: "widget" },
      artifact: { kind: "fragment", id: "frag-1" },
    })
  })

  it("marks the other kinds by profile and leaves the id out until the artifact exists", () => {
    expect(embeddedChatFields("motion")).toEqual({ profile: "motion", artifact: { kind: "motion" } })
  })
})

describe("isOwnArtifact", () => {
  it("matches the artifact the chat was made for", () => {
    expect(isOwnArtifact({ artifact: { kind: "fragment", id: "frag-1" } }, "fragment", "frag-1")).toBe(true)
  })

  it("does not match another artifact of the same kind", () => {
    expect(isOwnArtifact({ artifact: { kind: "fragment", id: "frag-1" } }, "fragment", "frag-2")).toBe(false)
  })

  it("treats every piece of a not-yet-created artifact as its own", () => {
    expect(isOwnArtifact({ artifact: { kind: "fragment" } }, "fragment", "frag-9")).toBe(true)
  })

  it("never matches a chat outside an artifact or of another kind", () => {
    expect(isOwnArtifact({}, "fragment", "frag-1")).toBe(false)
    expect(isOwnArtifact(null, "fragment", "frag-1")).toBe(false)
    expect(isOwnArtifact({ artifact: { kind: "motion", id: "frag-1" } }, "fragment", "frag-1")).toBe(false)
  })
})
