import { describe, expect, it } from "vitest"
import type { MediaEntry } from "@shared/media"
import { expandToGroups, groupMediaByRoot } from "./media-groups"

/**
 * The gallery is the person's collection, not the agent's draft. What is tested
 * here is what they see: how many items the grid shows and what is stacked
 * behind each one.
 */

let relogio = 0
function img(id: string, parentId?: string, source: MediaEntry["source"] = "chat"): MediaEntry {
  return {
    id,
    path: `/media/${id}`,
    size: 100,
    createdAt: ++relogio,
    source,
    kind: "image",
    parentId,
  }
}

/** The gallery delivers the most recent first. */
const grade = (entries: MediaEntry[]) => [...entries].sort((a, b) => b.createdAt - a.createdAt)

describe("groupMediaByRoot", () => {
  it("a photo edited over consecutive turns is a single item", () => {
    const anexo = img("anexo", undefined, "user")
    const v2 = img("v2", "anexo")
    const v3 = img("v3", "v2")
    const all = [anexo, v2, v3]

    const { covers, versions } = groupMediaByRoot(all, grade(all))
    expect(covers.map((c) => c.id)).toEqual(["v3"])
    expect(versions.get("v3")?.map((v) => v.id)).toEqual(["anexo", "v2", "v3"])
  })

  it("two options to choose from are v3 and v4 of the same item, not two items", () => {
    // "you have this one and that one, which do you prefer": both come from the same base and none
    // succeeds the other. Grouping by the end would make two tiles of a single edit.
    const anexo = img("anexo", undefined, "user")
    const v2 = img("v2", "anexo")
    const optionA = img("optionA", "v2")
    const optionB = img("optionB", "v2")
    const all = [anexo, v2, optionA, optionB]

    const { covers, versions } = groupMediaByRoot(all, grade(all))
    expect(covers.map((c) => c.id)).toEqual(["optionB"])
    expect(versions.get("optionB")?.map((v) => v.id)).toEqual(["anexo", "v2", "optionA", "optionB"])
  })

  it("editing the original again is still the same photo", () => {
    const anexo = img("anexo", undefined, "user")
    const v2 = img("v2", "anexo")
    const v3 = img("v3", "anexo")
    const all = [anexo, v2, v3]

    const { covers } = groupMediaByRoot(all, grade(all))
    expect(covers.map((c) => c.id)).toEqual(["v3"])
  })

  it("unrelated photos stay as separate items", () => {
    const a = img("a", undefined, "user")
    const b = img("b", undefined, "user")
    const all = [a, b]

    const { covers, versions } = groupMediaByRoot(all, grade(all))
    expect(covers.map((c) => c.id).sort()).toEqual(["a", "b"])
    expect(versions.size).toBe(0)
  })

  it("a link hidden by the filter does not split the group in two", () => {
    // The "Chat" filter hides the user's attachment; v2 and v3 stay together.
    const anexo = img("anexo", undefined, "user")
    const v2 = img("v2", "anexo")
    const v3 = img("v3", "v2")
    const all = [anexo, v2, v3]

    const { covers, versions } = groupMediaByRoot(all, grade([v2, v3]))
    expect(covers.map((c) => c.id)).toEqual(["v3"])
    expect(versions.get("v3")?.map((v) => v.id)).toEqual(["v2", "v3"])
  })
})

describe("expandToGroups", () => {
  it("deleting the item takes the versions, except the photo the user attached", () => {
    const anexo = img("anexo", undefined, "user")
    const v2 = img("v2", "anexo")
    const v3 = img("v3", "v2")
    const other = img("other", undefined, "user")

    expect(expandToGroups(["v3"], [anexo, v2, v3, other]).sort()).toEqual(["v2", "v3"])
  })

  it("does not touch a group that was not selected", () => {
    const a1 = img("a1", undefined, "user")
    const a2 = img("a2", "a1")
    const b1 = img("b1", undefined, "user")
    const b2 = img("b2", "b1")

    expect(expandToGroups(["a2"], [a1, a2, b1, b2])).toEqual(["a2"])
  })
})
