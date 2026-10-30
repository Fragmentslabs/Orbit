import { describe, expect, it, vi } from "vitest"

vi.mock("@/src/lib/ipc", () => ({ worktreeApi: {} }))

const { foldersAfterSwitch } = await import("./worktree-store")

describe("foldersAfterSwitch", () => {
  it("keeps the workspace's extra folders, including the ones associated after the last send", () => {
    expect(foldersAfterSwitch("/wt/voz", ["/repo", "/extra", "/outra"])).toEqual(["/wt/voz", "/extra", "/outra"])
  })

  it("does not repeat the new main folder or duplicate folders", () => {
    expect(foldersAfterSwitch("/wt/voz", ["/repo", "/wt/voz", "/extra", "/extra"])).toEqual(["/wt/voz", "/extra"])
  })

  it("with no extras, only the main one remains", () => {
    expect(foldersAfterSwitch("/wt/voz", ["/repo"])).toEqual(["/wt/voz"])
  })
})
