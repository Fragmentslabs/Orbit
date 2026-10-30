import { describe, expect, it } from "vitest"

import type { FolderInfo, SessionInfo } from "@shared/chat"

import { firstSessionOfFolder, sessionWorkspace, workspaceOfFolder } from "@/src/lib/folder-workspace"

/**
 * The real case: the Nodara folder was EMPTY (all of its chats deleted) and the
 * "+" opened the new chat in the repository of the last chat opened — Orbit. The automatic
 * map still said which project was the folder's; it is what resolves it.
 */

const NODARA_DIR = "/Users/desknik/Projects/Nodara"
const ORBIT_DIR = "/Users/desknik/Projects/Orbit"

const folder = (over: Partial<FolderInfo> = {}): FolderInfo => ({
  id: "f-nodara",
  name: "Nodara",
  mode: "code",
  pinned: false,
  archived: false,
  createdAt: 1,
  ...over,
})

const session = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  id: "s1",
  title: "chat",
  mode: "code",
  pinned: false,
  archived: false,
  folderId: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

describe("workspaceOfFolder", () => {
  it("empty folder: the automatic map decides (the '+' does not inherit the last chat's repository)", () => {
    expect(
      workspaceOfFolder({
        folder: folder(),
        sessions: [],
        autoFolderMap: { [NODARA_DIR]: "f-nodara", [ORBIT_DIR]: "f-orbit" },
      }),
    ).toEqual([NODARA_DIR])
  })

  it("with chats in the folder, the most recent one decides — its extra folders included", () => {
    const newest = session({
      id: "novo",
      folderId: "f-nodara",
      directory: "/Projects/Nodara-worktree",
      extraDirectories: ["/Projects/api"],
      updatedAt: 20,
    })
    const oldest = session({ id: "velho", folderId: "f-nodara", directory: NODARA_DIR, updatedAt: 10 })
    expect(
      workspaceOfFolder({
        folder: folder(),
        sessions: [oldest, newest],
        autoFolderMap: { [NODARA_DIR]: "f-nodara" },
      }),
    ).toEqual(["/Projects/Nodara-worktree", "/Projects/api"])
  })

  it("the most recent chat beats the map (the folder follows usage, not registration)", () => {
    expect(
      workspaceOfFolder({
        folder: folder(),
        sessions: [session({ folderId: "f-nodara", directory: "/Projects/other" })],
        autoFolderMap: { [NODARA_DIR]: "f-nodara" },
      }),
    ).toEqual(["/Projects/other"])
  })

  it("an archived chat also counts: the folder groups both states", () => {
    expect(
      workspaceOfFolder({
        folder: folder(),
        sessions: [session({ folderId: "f-nodara", directory: NODARA_DIR, archived: true })],
        autoFolderMap: {},
      }),
    ).toEqual([NODARA_DIR])
  })

  it("a chat in the folder with no directory (chat mode) decides nothing", () => {
    expect(
      workspaceOfFolder({
        folder: folder(),
        sessions: [session({ folderId: "f-nodara", mode: "chat", directory: undefined })],
        autoFolderMap: { [NODARA_DIR]: "f-nodara" },
      }),
    ).toEqual([NODARA_DIR])
  })

  it("ignores chats from other folders", () => {
    expect(
      workspaceOfFolder({
        folder: folder(),
        sessions: [session({ folderId: "f-orbit", directory: ORBIT_DIR })],
        autoFolderMap: { [NODARA_DIR]: "f-nodara" },
      }),
    ).toEqual([NODARA_DIR])
  })

  it("several directories in the same map: the folder name breaks the tie", () => {
    expect(
      workspaceOfFolder({
        folder: folder(),
        sessions: [],
        autoFolderMap: { "/antigo/xyz": "f-nodara", [NODARA_DIR]: "f-nodara" },
      }),
    ).toEqual([NODARA_DIR])
  })

  it("empty folder: its memory (the first chat's workspace) beats the map and brings the extras", () => {
    expect(
      workspaceOfFolder({
        folder: folder({ workspace: [NODARA_DIR, "/Projects/api"] }),
        sessions: [],
        autoFolderMap: {},
      }),
    ).toEqual([NODARA_DIR, "/Projects/api"])
  })

  it("the memory is a fallback: with a chat in the folder, the most recent one still decides", () => {
    expect(
      workspaceOfFolder({
        folder: folder({ workspace: [NODARA_DIR] }),
        sessions: [session({ folderId: "f-nodara", directory: "/Projects/other" })],
        autoFolderMap: {},
      }),
    ).toEqual(["/Projects/other"])
  })

  it("a folder with no known project returns undefined (the caller leaves the workspace alone)", () => {
    expect(
      workspaceOfFolder({ folder: folder(), sessions: [], autoFolderMap: { [ORBIT_DIR]: "f-orbit" } }),
    ).toBeUndefined()
  })
})

describe("firstSessionOfFolder", () => {
  it("the OLDEST one in the folder is the one that teaches the workspace — not the most recent", () => {
    const first = session({ id: "a", folderId: "f-nodara", directory: NODARA_DIR, createdAt: 1 })
    const recent = session({ id: "b", folderId: "f-nodara", directory: ORBIT_DIR, createdAt: 9 })
    expect(firstSessionOfFolder("f-nodara", [recent, first])?.id).toBe("a")
  })

  it("ignores chats from other folders, from chat mode and with no directory", () => {
    const noise = [
      session({ id: "other", folderId: "f-orbit", directory: ORBIT_DIR, createdAt: 0 }),
      session({ id: "conversa", folderId: "f-nodara", mode: "chat", createdAt: 0 }),
      session({ id: "sem-dir", folderId: "f-nodara", directory: undefined, createdAt: 0 }),
    ]
    expect(firstSessionOfFolder("f-nodara", noise)).toBeUndefined()
    expect(
      firstSessionOfFolder("f-nodara", [
        ...noise,
        session({ id: "valido", folderId: "f-nodara", directory: NODARA_DIR, createdAt: 5 }),
      ])?.id,
    ).toBe("valido")
  })
})

describe("sessionWorkspace", () => {
  it("main + extras, in order; undefined with no directory", () => {
    expect(sessionWorkspace(session({ directory: "/a", extraDirectories: ["/b"] }))).toEqual(["/a", "/b"])
    expect(sessionWorkspace(session())).toBeUndefined()
  })
})
