import { describe, expect, it } from "vitest"

import { sameFolders, sessionFolders } from "./session-folders"

describe("sessionFolders", () => {
  it("puts the main one ahead of the extras", () => {
    expect(
      sessionFolders({ directory: "/repo", extraDirectories: ["/shared", "/docs"] }),
    ).toEqual(["/repo", "/shared", "/docs"])
  })

  it("a session with no folder does not become a list with an empty string", () => {
    expect(sessionFolders({ extraDirectories: ["/shared"] })).toEqual(["/shared"])
    expect(sessionFolders({})).toEqual([])
  })
})

describe("sameFolders", () => {
  it("the same main and the same extras are the same list", () => {
    expect(sameFolders(["/repo", "/b"], ["/repo", "/b"])).toBe(true)
  })

  it("the order among the extras does not count", () => {
    expect(sameFolders(["/repo", "/a", "/b"], ["/repo", "/b", "/a"])).toBe(true)
  })

  it("the main one rules: changing it is another list", () => {
    expect(sameFolders(["/repo", "/a"], ["/other", "/a"])).toBe(false)
  })

  it("an extra associated after the last save is a difference", () => {
    expect(sameFolders(["/repo"], ["/repo", "/new"])).toBe(false)
  })

  it("a removed extra is a difference", () => {
    expect(sameFolders(["/repo", "/old"], ["/repo"])).toBe(false)
  })
})
