import { describe, expect, it, vi } from "vitest"

vi.mock("@/src/lib/ipc", () => ({ worktreeApi: {} }))

const { pastasAposTroca } = await import("./worktree-store")

describe("pastasAposTroca", () => {
  it("mantém as pastas extras do workspace, inclusive as associadas depois do último envio", () => {
    expect(pastasAposTroca("/wt/voz", ["/repo", "/extra", "/outra"])).toEqual(["/wt/voz", "/extra", "/outra"])
  })

  it("não repete a pasta principal nova nem pastas duplicadas", () => {
    expect(pastasAposTroca("/wt/voz", ["/repo", "/wt/voz", "/extra", "/extra"])).toEqual(["/wt/voz", "/extra"])
  })

  it("sem extras, fica só a principal", () => {
    expect(pastasAposTroca("/wt/voz", ["/repo"])).toEqual(["/wt/voz"])
  })
})
