import { describe, expect, it } from "vitest"

import {
  folderForPath,
  groupByFolder,
  repoForPath,
  type GitRepoEntry,
} from "@/src/lib/folders"

/**
 * The owner of a path decides where the branch selector, the pull/push
 * and the diff lens go. The case that matters is the root folder that is ALSO a repo: its
 * path is a prefix of every nested repo, and taking the first one that matches
 * would send a file from `front/` to the repository above.
 */

const repo = (path: string, name: string, relative: string): GitRepoEntry => ({
  path,
  name,
  relative,
})

const rootIsRepo = [
  repo("/ws", "ws", ""),
  repo("/ws/front", "front", "front"),
  repo("/ws/back", "back", "back"),
]

describe("repoForPath", () => {
  it("prefers the deepest repo when the root is a repo too", () => {
    expect(repoForPath(rootIsRepo, "/ws/front/src/app.tsx")).toBe("/ws/front")
    expect(repoForPath(rootIsRepo, "/ws/back/api/index.ts")).toBe("/ws/back")
  })

  it("returns the root for whatever is not in a nested repo", () => {
    expect(repoForPath(rootIsRepo, "/ws/README.md")).toBe("/ws")
  })

  it("returns null when no repo contains the path", () => {
    expect(repoForPath(rootIsRepo, "/other/lugar/x.ts")).toBeNull()
    expect(repoForPath([], "/ws/front/x.ts")).toBeNull()
  })

  it("does not confuse a sibling folder with a similar name", () => {
    // `/ws/frontend` is not `/ws/front` — the separator is what closes the prefix.
    expect(repoForPath(rootIsRepo, "/ws/frontend/x.ts")).toBe("/ws")
  })

  it("matches a path with the Windows separator", () => {
    const repos = [repo("C:\\ws", "ws", ""), repo("C:\\ws\\front", "front", "front")]
    expect(repoForPath(repos, "C:\\ws\\front\\src\\a.ts")).toBe("C:\\ws\\front")
  })
})

/**
 * The list of changes shows the chat's folders — the main one and the attached ones.
 * The file has to show up under its folder, only once.
 */

describe("folderForPath", () => {
  const folders = ["/ws", "/ws/app", "/other"]

  it("prefers the deepest folder when one is inside the other", () => {
    expect(folderForPath(folders, "/ws/app/src/x.ts")).toBe("/ws/app")
    expect(folderForPath(folders, "/ws/README.md")).toBe("/ws")
  })

  it("returns null when the file is in no folder", () => {
    expect(folderForPath(folders, "/fora/x.ts")).toBeNull()
    expect(folderForPath([], "/ws/x.ts")).toBeNull()
  })
})

describe("groupByFolder", () => {
  const file = (path: string) => ({ path })

  it("splits the changes per folder, in the order of the folders", () => {
    const groups = groupByFolder(
      ["/ws", "/other"],
      [file("/other/src/b.ts"), file("/ws/src/a.ts")],
      "/ws",
    )
    expect(groups.map((g) => g.folder)).toEqual(["/ws", "/other"])
    expect(groups[0].files.map((f) => f.path)).toEqual(["/ws/src/a.ts"])
    expect(groups[1].files.map((f) => f.path)).toEqual(["/other/src/b.ts"])
  })

  it("counts the file once only, in the most specific folder", () => {
    const groups = groupByFolder(
      ["/ws", "/ws/app"],
      [file("/ws/app/src/x.ts"), file("/ws/README.md")],
      "/ws",
    )
    expect(groups.map((g) => g.folder)).toEqual(["/ws", "/ws/app"])
    expect(
      groups.find((g) => g.folder === "/ws")!.files.map((f) => f.path),
    ).toEqual(["/ws/README.md"])
    expect(
      groups.find((g) => g.folder === "/ws/app")!.files.map((f) => f.path),
    ).toEqual(["/ws/app/src/x.ts"])
  })

  it("puts in the fallback the file that is in no folder", () => {
    // Switching folders: the status is from an instant ago and the file cannot
    // vanish from the list because of that.
    const groups = groupByFolder(["/ws"], [file("/sumiu/x.ts")], "/ws")
    expect(groups).toHaveLength(1)
    expect(groups[0].folder).toBe("/ws")
    expect(groups[0].files).toHaveLength(1)
  })
})
