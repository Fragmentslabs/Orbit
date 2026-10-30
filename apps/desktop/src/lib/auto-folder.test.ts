import { describe, expect, it } from "vitest"
import type { FolderInfo } from "@shared/chat"
import { planAutoFolder } from "./auto-folder"

/**
 * "Create folders automatically" stopped working per project, not per app.
 *
 * The directory → folder map keeps what happened the last time. What
 * happened SINCE THEN — the folder was archived, deleted — it does not know. And the
 * branch that dealt with that did nothing: the session was born loose, the map
 * kept pointing to the same folder, and the next session landed in the same
 * place. Archiving a project's folder turned ITS automatic creation off
 * forever, with the preference on the whole time.
 *
 * The tests below are the states the map may be in when the session
 * is born.
 */

const ORBIT: FolderInfo = {
  id: "f-orbit",
  name: "Orbit",
  mode: "code",
  pinned: false,
  archived: false,
  createdAt: 1,
}

const folder = (over: Partial<FolderInfo>): FolderInfo => ({ ...ORBIT, ...over })

describe("automatic project folder", () => {
  it("uses the folder the map points at", () => {
    expect(
      planAutoFolder({
        directory: "C:/Projects/Orbit",
        mode: "code",
        folders: [ORBIT],
        mappedId: "f-orbit",
      }),
    ).toEqual({ folderId: "f-orbit" })
  })

  it("an ARCHIVED folder comes back to the sidebar instead of becoming a dead end", () => {
    // This is the bug. Before, the session was born loose and the map kept pointing
    // to the archived one — every new chat of that project was born loose too.
    const archivedFolder = folder({ id: "f-vlk", name: "Vlk go", archived: true })
    expect(
      planAutoFolder({
        directory: "C:/Projects/Vlk - GO",
        mode: "code",
        folders: [archivedFolder],
        mappedId: "f-vlk",
      }),
    ).toEqual({ folderId: "f-vlk", revive: true })
  })

  it("a map pointing at a deleted folder falls back to searching by name", () => {
    expect(
      planAutoFolder({
        directory: "C:/Projects/Orbit",
        mode: "code",
        folders: [ORBIT],
        mappedId: "f-que-nao-existe-mais",
      }),
    ).toEqual({ folderId: "f-orbit" })
  })

  it("a map pointing at a folder from ANOTHER mode does not count", () => {
    // The ids belong to different spaces; a chat folder does not receive a code
    // session. Before, this also fell into the branch that did nothing.
    const ofChatFolder = folder({ id: "f-chat", mode: "chat" })
    expect(
      planAutoFolder({
        directory: "C:/Projects/Orbit",
        mode: "code",
        folders: [ofChatFolder],
        mappedId: "f-chat",
      }),
    ).toEqual({ create: "Orbit" })
  })

  it("with no map, it recognizes the project by name — even with a different path", () => {
    // Lost map (cleared localStorage, new machine) or the same project opened
    // by another path. Without this, a second "Orbit" folder would be born.
    for (const dir of ["C:/Projects/Orbit", "C:\\Projects\\Orbit\\", "~/projects/orbit"]) {
      expect(planAutoFolder({ directory: dir, mode: "code", folders: [ORBIT] })).toEqual({
        folderId: "f-orbit",
      })
    }
  })

  it("prefers the live folder when an archived one has the same name", () => {
    const liveFolder = folder({ id: "f-viva" })
    const oldArchived = folder({ id: "f-velha", archived: true })
    expect(
      planAutoFolder({ directory: "C:/Projects/Orbit", mode: "code", folders: [oldArchived, liveFolder] }),
    ).toEqual({ folderId: "f-viva" })
  })

  it("with only the archived one, it revives it instead of creating a duplicate beside it", () => {
    const oldArchived = folder({ id: "f-velha", archived: true })
    expect(
      planAutoFolder({ directory: "C:/Projects/Orbit", mode: "code", folders: [oldArchived] }),
    ).toEqual({ folderId: "f-velha", revive: true })
  })

  it("a new project gets a folder with the readable name of the directory", () => {
    expect(
      planAutoFolder({
        directory: "C:/Projects/WWO/irrigaboi-app-montadores",
        mode: "code",
        folders: [],
      }),
    ).toEqual({ create: "Irrigaboi App Montadores" })
  })
})
