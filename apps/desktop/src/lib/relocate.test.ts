import { describe, expect, it } from "vitest"

import {
  collectFolderPaths,
  folderBaseName,
  missingFolders,
  relocateAutoFolderEntry,
  relocateFolderWorkspace,
  relocateSessionFolders,
  relocatedFolderName,
  sessionFolderPaths,
} from "@/src/lib/relocate"

/**
 * Folder revalidation is what is left when the path is only a string: the
 * user renames the folder in Finder and the references keep pointing at
 * nothing. What is tested here is the judgment — what counts as gone, what
 * should be relinked and what must NOT be touched. Erring on the side of touching
 * too much is worse than not touching: the session data has no backup.
 */

describe("folderBaseName", () => {
  it("returns the last segment of the path", () => {
    expect(folderBaseName("/Users/me/Projects/meu-app")).toBe("meu-app")
  })

  it("tolerates a trailing slash and the Windows separator", () => {
    expect(folderBaseName("/Users/me/Projects/meu-app/")).toBe("meu-app")
    expect(folderBaseName("C:\\Users\\me\\meu-app")).toBe("meu-app")
  })
})

describe("sessionFolderPaths", () => {
  it("lists the main one before the extras and ignores empties", () => {
    expect(
      sessionFolderPaths({ directory: "/a", extraDirectories: ["/b", "/c"] }),
    ).toEqual(["/a", "/b", "/c"])
    expect(sessionFolderPaths({ extraDirectories: ["/b"] })).toEqual(["/b"])
    expect(sessionFolderPaths({})).toEqual([])
  })
})

describe("collectFolderPaths", () => {
  it("joins workspace and sessions without repeating, preserving the order", () => {
    const sessions = [
      { directory: "/proj/a", extraDirectories: ["/proj/shared"] },
      { directory: "/proj/a" },
    ]
    expect(collectFolderPaths(["/proj/a", "/proj/b"], sessions)).toEqual([
      "/proj/a",
      "/proj/b",
      "/proj/shared",
    ])
  })

  it("ignores sessions with no folder", () => {
    expect(collectFolderPaths(["/proj/a"], [{}, { extraDirectories: [] }])).toEqual(["/proj/a"])
  })
})

describe("missingFolders", () => {
  it("reports only what was checked and does not exist", () => {
    const existing = { "/viva": true, "/morta": false }
    expect(missingFolders(["/viva", "/morta", "/nao-checada"], existing)).toEqual([
      { path: "/morta", name: "morta" },
    ])
  })

  it("an unchecked path is a doubt, not an absence", () => {
    expect(missingFolders(["/sumiu"], {})).toEqual([])
  })
})

describe("relocateSessionFolders", () => {
  const session = { directory: "/old", extraDirectories: ["/another", "/old"] }

  it("reconnects the main directory", () => {
    expect(relocateSessionFolders({ directory: "/old" }, "/old", "/new")).toEqual({
      directory: "/new",
    })
  })

  it("reconnects the extra folder in the position it was in", () => {
    expect(relocateSessionFolders(session, "/old", "/new")).toEqual({
      directory: "/new",
      extraDirectories: ["/another", "/new"],
    })
  })

  it("leaves sessions that do not reference the path untouched", () => {
    expect(relocateSessionFolders({ directory: "/other" }, "/old", "/new")).toBeNull()
  })

  it("does not change the original session", () => {
    const original = { directory: "/old", extraDirectories: ["/old"] }
    relocateSessionFolders(original, "/old", "/new")
    expect(original).toEqual({ directory: "/old", extraDirectories: ["/old"] })
  })
})

describe("relocateAutoFolderEntry", () => {
  it("moves the entry to the new path", () => {
    expect(relocateAutoFolderEntry({ "/old": "f1" }, "/old", "/new")).toEqual({
      "/new": "f1",
    })
  })

  it("does not steal the owner when the destination already has a folder", () => {
    expect(
      relocateAutoFolderEntry({ "/old": "f1", "/new": "f2" }, "/old", "/new"),
    ).toEqual({ "/new": "f2" })
  })

  it("returns null when there was no entry", () => {
    expect(relocateAutoFolderEntry({ "/other": "f1" }, "/old", "/new")).toBeNull()
  })
})

describe("relocatedFolderName", () => {
  it("follows the project name while the name is still the derived one", () => {
    expect(relocatedFolderName("Meu App", "/x/meu-app", "/y/app-novo")).toBe("App Novo")
  })

  it("leaves a hand-edited name untouched", () => {
    expect(relocatedFolderName("Cliente X", "/x/meu-app", "/y/app-novo")).toBeNull()
  })

  it("returns nothing when the name would not change", () => {
    expect(relocatedFolderName("Meu App", "/x/meu-app", "/y/meu-app")).toBeNull()
  })
})

describe("relocateFolderWorkspace", () => {
  it("swaps the old path for the new one, in the position it was in", () => {
    expect(relocateFolderWorkspace(["/old/app", "/api"], "/old/app", "/new/app")).toEqual([
      "/new/app",
      "/api",
    ])
  })

  it("null when the memory does not reference the path (nothing unrelated is touched)", () => {
    expect(relocateFolderWorkspace(["/api"], "/old/app", "/new/app")).toBeNull()
    expect(relocateFolderWorkspace(undefined, "/old/app", "/new/app")).toBeNull()
  })
})
