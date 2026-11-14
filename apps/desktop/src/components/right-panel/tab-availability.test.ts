import { describe, expect, it } from "vitest"
import { remoteSessionId } from "@shared/peers"
import { canBrowseRemoteFiles, isSelectableTab, isTabAvailable } from "./tab-availability"

const PEER = "p_0123456789abcdef"

describe("isSelectableTab", () => {
  it("keeps the local rules: code has everything that can open empty, chat a subset", () => {
    expect(isSelectableTab("terminal", "code")).toBe(true)
    expect(isSelectableTab("terminal", "chat")).toBe(false)
    expect(isSelectableTab("browser", "chat")).toBe(true)
    expect(isSelectableTab("motion", "code")).toBe(false)
  })

  it("offers only what works through the peer on a remote desktop, in both modes", () => {
    for (const mode of ["chat", "code"] as const) {
      expect(isSelectableTab("chat", mode, true)).toBe(true)
      expect(isSelectableTab("media", mode, true)).toBe(true)
      expect(isSelectableTab("folders", mode, true)).toBe(true)
      expect(isSelectableTab("terminal", mode, true)).toBe(false)
      expect(isSelectableTab("browser", mode, true)).toBe(false)
      expect(isSelectableTab("fragment", mode, true)).toBe(false)
    }
  })
})

describe("isTabAvailable", () => {
  it("hides local-only tabs in a remote chat", () => {
    for (const type of ["terminal", "process", "browser", "diff", "fragment"] as const) {
      expect(isTabAvailable({ type }, true)).toBe(false)
    }
  })

  it("keeps pieces and conversations in a remote chat", () => {
    for (const type of ["chat", "media", "motion", "design", "slides", "document", "artifact", "sources", "folders"] as const) {
      expect(isTabAvailable({ type }, true)).toBe(true)
    }
  })

  it("hides a pinned remote conversation while on this computer", () => {
    expect(isTabAvailable({ type: "chat", sessionId: remoteSessionId(PEER, "abc") }, false)).toBe(false)
    expect(isTabAvailable({ type: "chat", sessionId: "abc" }, false)).toBe(true)
    expect(isTabAvailable({ type: "terminal" }, false)).toBe(true)
  })
})

describe("canBrowseRemoteFiles", () => {
  it("needs the peer online with the files grant", () => {
    expect(canBrowseRemoteFiles(undefined)).toBe(false)
    expect(canBrowseRemoteFiles({ online: true, grants: { files: false } })).toBe(false)
    expect(canBrowseRemoteFiles({ online: false, grants: { files: true } })).toBe(false)
    expect(canBrowseRemoteFiles({ online: true, grants: { files: true } })).toBe(true)
  })
})
